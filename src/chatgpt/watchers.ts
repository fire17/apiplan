import {isAbsolute,join,resolve as resolvePath} from 'node:path';
import {createHash} from 'node:crypto';
import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {accountDir,atomicJSON,readJSON,type Account} from './accounts.ts';
import {classifyError} from './monitor.ts';
import {FREEZE_CODE,readFreeze} from './freeze.ts';
import {importInvoices,type InvoiceImportReport} from './invoices.ts';

export const MIN_WATCH_INTERVAL_MS=60_000;
export const DEFAULT_WATCH_INTERVAL_MS=6*60*60_000;
export const MAX_WATCH_INTERVAL_MS=30*24*60*60_000;
/** A frozen account is a human decision, not an outage: re-check the flag on a flat cadence. */
export const FREEZE_RECHECK_MS=5*60_000;
/** Downloaded invoices are small; anything larger is not one of ours and is never hashed. */
const MAX_PENDING_BYTES=64*1024*1024;

export type InvoiceWatcherConfig={
 version:1;
 enabled:boolean;
 intervalMs:number;
 backoffBaseMs:number;
 maxBackoffMs:number;
 projectPath?:string;
};
type WatcherState={
 version:1;
 nextRunAt?:number;
 inFlight?:boolean;
 operationStartedAt?:number;
 lastCompletedAt?:number;
 failures:number;
 lastError?:ReturnType<typeof classifyError>;
 paused?:'previous-outcome-unknown'|'outcome-unknown'|'action-required';
 /** Set while the account is frozen: a deferral, never a failure — no backoff, no pause. */
 deferred?:'frozen';
 deferredSince?:number;
 lastDeferredAt?:number;
 /** What a human must decide while the watcher is parked, written next to the error that parked it. */
 decision?:{question:string;resume:string;pending:string[]};
};
type FilingRecord={path:string;file?:string;status:'added'|'duplicate';at:string};
export type PendingFiling={path:string;sha256:string;bytes:number;downloadedAt:string};
export type WatcherEvent={type:string;watcher:'invoices';account:string;epoch:number;at:string;[key:string]:unknown};
export type WatcherScheduler={now:()=>number;sleep:(milliseconds:number,signal:AbortSignal)=>Promise<void>};
export type InvoiceSync=(config:InvoiceWatcherConfig,context:{epoch:number})=>Promise<unknown>;
export type InvoiceImporter=(paths:string[],options:{projectPath?:string})=>Promise<InvoiceImportReport>;

const DEFAULT_CONFIG:InvoiceWatcherConfig={version:1,enabled:false,intervalMs:DEFAULT_WATCH_INTERVAL_MS,backoffBaseMs:MIN_WATCH_INTERVAL_MS,maxBackoffMs:DEFAULT_WATCH_INTERVAL_MS};
const DEFAULT_STATE:WatcherState={version:1,failures:0};
const realScheduler:WatcherScheduler={
 now:()=>Date.now(),
 sleep:(milliseconds,signal)=>new Promise(resolve=>{
  if(signal.aborted)return resolve();
  const timer=setTimeout(done,milliseconds);
  function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve();}
  signal.addEventListener('abort',done,{once:true});
 }),
};

export class InvoiceWatcher {
 private active=false;
 private epoch=0;
 private loopPromise:Promise<void>|null=null;
 private operation:Promise<unknown>|null=null;
 private sleepController:AbortController|null=null;
 private readonly scheduler:WatcherScheduler;
 private readonly emitEvent:(event:WatcherEvent)=>void;
 private readonly importer:InvoiceImporter;

 constructor(public account:Account,private readonly sync:InvoiceSync,options:{scheduler?:WatcherScheduler;emit?:(event:WatcherEvent)=>void;importer?:InvoiceImporter}={}){
  this.scheduler=options.scheduler||realScheduler;
  this.emitEvent=options.emit||(()=>{});
  this.importer=options.importer||importInvoices;
 }

 private configPath(){return join(accountDir(this.account),'invoice-watcher.json');}
 private statePath(){return join(accountDir(this.account),'invoice-watcher-state.json');}
 private filingsPath(){return join(accountDir(this.account),'invoice-filings.json');}
 private downloadsDir(){return join(accountDir(this.account),'downloads');}
 private syncStatePath(){return join(accountDir(this.account),'invoice-sync.json');}
 private state(){return {...DEFAULT_STATE,...readJSON<WatcherState>(this.statePath(),DEFAULT_STATE)};}
 private saveState(state:WatcherState){atomicJSON(this.statePath(),state);return state;}
 private event(type:string,extra:Record<string,unknown>={}){this.emitEvent({type,watcher:'invoices',account:this.account.id,epoch:this.epoch,at:new Date(this.scheduler.now()).toISOString(),...extra});}

 config(update?:Partial<Omit<InvoiceWatcherConfig,'version'>>):InvoiceWatcherConfig{
  const current={...DEFAULT_CONFIG,...readJSON<InvoiceWatcherConfig>(this.configPath(),DEFAULT_CONFIG)};
  if(!update)return this.validateConfig(current);
  const next=this.validateConfig({...current,...update,version:1});
  atomicJSON(this.configPath(),next);
  this.event('invoice.watcher.configured',{enabled:next.enabled,intervalMs:next.intervalMs,backoffBaseMs:next.backoffBaseMs,maxBackoffMs:next.maxBackoffMs});
  return next;
 }

 private validateConfig(value:any):InvoiceWatcherConfig{
  if(!value||value.version!==1||typeof value.enabled!=='boolean')throw new Error('Invoice watcher config needs version 1 and an enabled boolean.');
  for(const key of ['intervalMs','backoffBaseMs','maxBackoffMs']as const){const amount=value[key];if(!Number.isSafeInteger(amount)||amount<MIN_WATCH_INTERVAL_MS||amount>MAX_WATCH_INTERVAL_MS)throw new Error(`Invoice watcher ${key} must be an integer from 60000 to ${MAX_WATCH_INTERVAL_MS} milliseconds.`);}
  if(value.backoffBaseMs>value.maxBackoffMs)throw new Error('Invoice watcher backoffBaseMs cannot exceed maxBackoffMs.');
  if(value.projectPath!==undefined&&(typeof value.projectPath!=='string'||!isAbsolute(value.projectPath)))throw new Error('Invoice watcher projectPath must be absolute.');
  return {version:1,enabled:value.enabled,intervalMs:value.intervalMs,backoffBaseMs:value.backoffBaseMs,maxBackoffMs:value.maxBackoffMs,...(value.projectPath?{projectPath:value.projectPath}:{})};
 }

 start(options:{restore?:boolean;acknowledgeAmbiguous?:boolean}={}){
  let config=this.config();
  if(!options.restore&&!config.enabled)config=this.config({enabled:true});
  if(!config.enabled)return {...this.status(),started:false};
  const state=this.state();
  if(state.inFlight&&this.operation){
   this.event('invoice.watcher.start.deferred',{reason:'operation-outcome-pending'});
   return {...this.status(),started:false,pendingOutcome:true};
  }
  if(state.inFlight){
   this.saveState({...state,inFlight:false,nextRunAt:undefined,paused:'previous-outcome-unknown'});
   this.event('invoice.watcher.recovered',{paused:true,reason:'previous-outcome-unknown',operationStartedAt:state.operationStartedAt});
   return {...this.status(),started:false};
  }
  if(state.paused&&!options.acknowledgeAmbiguous)return {...this.status(),started:false};
  if(state.paused&&options.acknowledgeAmbiguous)this.saveState({...state,paused:undefined,lastError:undefined,decision:undefined,nextRunAt:this.scheduler.now()+config.intervalMs});
  if(this.active)return {...this.status(),started:false};
  this.active=true;this.epoch++;
  // A frozen account still starts: the loop defers every cycle and resumes by itself on thaw.
  this.event('invoice.watcher.started',{restored:options.restore===true,frozen:readFreeze(this.account).frozen});
  this.ensureLoop(this.epoch);
  return {...this.status(),started:true};
 }

 stop(options:{disable?:boolean}={}){
  if(options.disable!==false&&this.config().enabled)this.config({enabled:false});
  const wasActive=this.active,pending=this.operation!==null;
  this.active=false;this.epoch++;
  this.sleepController?.abort();this.sleepController=null;
  this.event('invoice.watcher.stopped',{wasActive,pendingOutcome:pending});
  return {...this.status(),stopped:wasActive,pendingOutcome:pending};
 }

 status(){
  const config=this.config(),state=this.state(),freeze=readFreeze(this.account),pending=this.pendingFilings();
  return {watcher:'invoices' as const,enabled:config.enabled,running:this.active,inFlight:this.operation!==null,epoch:this.epoch,
   nextRunAt:state.nextRunAt?new Date(state.nextRunAt).toISOString():null,failures:state.failures,paused:state.paused||null,
   lastCompletedAt:state.lastCompletedAt?new Date(state.lastCompletedAt).toISOString():null,lastError:state.lastError||null,
   frozen:freeze.frozen,deferred:state.deferred||null,
   pendingFilings:pending.length,pendingPaths:pending.map(item=>item.path),decision:state.decision||null};
 }

 // ------------------------------------------------------------------ staged work a human can resume

 /** Invoice PDFs already downloaded to this account that no run has filed yet. Pure read. */
 pendingFilings():PendingFiling[]{
  const root=this.downloadsDir();
  if(!existsSync(root))return [];
  const filed=new Set<string>(),sync=readJSON<any>(this.syncStatePath(),{invoices:{}});
  for(const entry of Object.values<any>(sync?.invoices||{}))if(entry?.imported&&entry.sha256)filed.add(entry.sha256);
  for(const sha of Object.keys(this.filings()))filed.add(sha);
  const pending:PendingFiling[]=[];
  const files:string[]=[];
  try{
   for(const entry of readdirSync(root,{withFileTypes:true})){
    const path=join(root,entry.name);
    if(entry.isDirectory()){try{for(const inner of readdirSync(path))if(inner.toLowerCase().endsWith('.pdf'))files.push(join(path,inner));}catch{/* unreadable download dir is not pending work */}}
    else if(entry.isFile()&&entry.name.toLowerCase().endsWith('.pdf'))files.push(path);
   }
  }catch{return [];}
  for(const path of files.sort()){
   try{
    const info=statSync(path);
    if(!info.isFile()||info.size>MAX_PENDING_BYTES)continue;
    const bytes=readFileSync(path);
    if(bytes.subarray(0,5).toString()!=='%PDF-')continue;
    const sha256=createHash('sha256').update(bytes).digest('hex');
    if(filed.has(sha256))continue;
    pending.push({path,sha256,bytes:info.size,downloadedAt:new Date(info.mtimeMs).toISOString()});
   }catch{/* a file that disappeared mid-scan is not pending work */}
  }
  return pending;
 }

 private filings():Record<string,FilingRecord>{return readJSON<any>(this.filingsPath(),{version:1,filings:{}})?.filings||{};}
 private recordFilings(entries:Record<string,FilingRecord>){
  atomicJSON(this.filingsPath(),{version:1,updated:new Date(this.scheduler.now()).toISOString(),filings:{...this.filings(),...entries}});
 }

 /** Everything a human needs to decide what happens next, without touching the site. */
 inspect(){
  const state=this.state(),pending=this.pendingFilings(),freeze=readFreeze(this.account);
  return {
   ...this.status(),
   freeze,
   pending,
   filed:Object.values(this.filings()).length,
   question:state.decision?.question||(pending.length?`File ${pending.length} downloaded invoice(s) into the invoice project, or discard them?`:'Nothing is waiting to be filed.'),
   resume:state.decision?.resume||'chatgpt account invoice-resume',
  };
 }

 /**
  * Finish a filing that failed after the download — offline, no site traffic, no re-download.
  *
  * Filing twice is impossible: the existing importer keys duplicates on provider + invoice number,
  * and every path this method files is written to `invoice-filings.json`, so a second resume finds
  * nothing pending and is a no-op.
  */
 async resumeFiling(options:{projectPath?:string;paths?:string[];clearPause?:boolean}={}){
  if(this.operation)throw new Error('A sync is still in flight; stop the invoice watcher before resuming filing.');
  const config=this.config();
  const chosen=options.paths?.map(path=>resolvePath(path))||this.pendingFilings().map(item=>item.path);
  if(!chosen.length){
   this.event('invoice.filing.resume.noop',{reason:'nothing-pending'});
   return {resumed:false,filed:0,duplicates:0,failed:0,results:[],pending:[],...this.status()};
  }
  this.event('invoice.filing.resume.started',{paths:chosen.length});
  const report=await this.importer(chosen,{projectPath:options.projectPath||config.projectPath});
  const done:Record<string,FilingRecord>={};
  for(const result of report.results){
   if((result.status==='added'||result.status==='duplicate')&&result.sha256)done[result.sha256]={path:result.source,file:result.file,status:result.status,at:new Date(this.scheduler.now()).toISOString()};
  }
  if(Object.keys(done).length)this.recordFilings(done);
  const state=this.state();
  if(report.failed===0){
   this.saveState({...state,failures:0,lastError:undefined,paused:undefined,decision:undefined,deferred:undefined,lastCompletedAt:this.scheduler.now(),nextRunAt:this.scheduler.now()+config.intervalMs});
  }else{
   const failure=report.results.find(result=>result.status==='error');
   const classified=classifyError(Object.assign(new Error('Invoice filing resume failed: '+(failure?.message||'unknown importer error')),{code:'FILING_FAILED',retryable:false,action:'Inspect the staged item in the invoice project inbox, fix what it reports, then resume filing again. Nothing needs re-downloading.'}));
   this.saveState({...state,lastError:classified,paused:'action-required',nextRunAt:undefined,decision:this.decisionFor(classified)});
  }
  this.event('invoice.filing.resumed',{added:report.added,duplicates:report.duplicates,failed:report.failed});
  return {resumed:true,filed:report.added,duplicates:report.duplicates,failed:report.failed,results:report.results,pending:this.pendingFilings(),...this.status()};
 }

 private decisionFor(classified:ReturnType<typeof classifyError>){
  const pending=this.pendingFilings().map(item=>item.path);
  return {
   question:pending.length
    ?`${pending.length} invoice PDF is downloaded but not filed. File it into the invoice project (resume), or discard the download?`
    :'The last invoice filing failed. Inspect what the invoice project has staged, then resume or discard it.',
   resume:'chatgpt account invoice-resume',
   pending,
   ...(classified.code?{code:classified.code}:{}),
  } as WatcherState['decision'];
 }

 // ------------------------------------------------------------------ loop

 private ensureLoop(epoch:number){
  if(this.loopPromise)return;
  const loop=this.run(epoch).finally(()=>{
   if(this.loopPromise===loop)this.loopPromise=null;
   if(this.active)queueMicrotask(()=>this.ensureLoop(this.epoch));
  });
  this.loopPromise=loop;
 }

 private async wait(milliseconds:number,epoch:number){
  const controller=new AbortController();this.sleepController=controller;
  this.event('invoice.watcher.scheduled',{delayMs:milliseconds,nextRunAt:new Date(this.scheduler.now()+milliseconds).toISOString()});
  await this.scheduler.sleep(milliseconds,controller.signal);
  if(this.sleepController===controller)this.sleepController=null;
  return this.active&&this.epoch===epoch&&!controller.signal.aborted;
 }

 /** A freeze is a deliberate stop: defer on a flat cadence, keep the failure count, never pause. */
 private defer(state:WatcherState,config:InvoiceWatcherConfig,extra:Record<string,unknown>){
  const delay=Math.min(config.intervalMs,FREEZE_RECHECK_MS),now=this.scheduler.now();
  this.saveState({...state,inFlight:false,operationStartedAt:undefined,deferred:'frozen',deferredSince:state.deferredSince??now,lastDeferredAt:now,nextRunAt:now+delay});
  this.event('invoice.watcher.sync.deferred',{reason:'frozen',delayMs:delay,nextRunAt:new Date(now+delay).toISOString(),...extra});
  return delay;
 }

 private async run(epoch:number){
  let state=this.state(),config=this.config();
  const firstDelay=Math.max(0,(state.nextRunAt??(this.scheduler.now()+config.intervalMs))-this.scheduler.now());
  if(state.nextRunAt===undefined)state=this.saveState({...state,nextRunAt:this.scheduler.now()+firstDelay});
  let delay=firstDelay;
  while(this.active&&this.epoch===epoch){
   if(!await this.wait(delay,epoch))return;
   config=this.config();
   if(!config.enabled){this.active=false;return;}
   const freeze=readFreeze(this.account);
   if(freeze.frozen){
    // No site work while frozen, and no failure either: the flag is a human decision, not an outage.
    delay=this.defer(this.state(),config,{...(freeze.reason?{reason_detail:freeze.reason}:{}),source:'flag'});
    continue;
   }
   const startedAt=this.scheduler.now();
   state=this.saveState({...this.state(),inFlight:true,operationStartedAt:startedAt,nextRunAt:undefined,deferred:undefined,deferredSince:undefined});
   this.event('invoice.watcher.sync.started',{operationStartedAt:new Date(startedAt).toISOString()});
   const operation=Promise.resolve().then(()=>this.sync(config,{epoch}));
   this.operation=operation;
   try{
    const result=await operation;
    const completedAt=this.scheduler.now();
    state=this.saveState({...this.state(),inFlight:false,operationStartedAt:undefined,lastCompletedAt:completedAt,failures:0,lastError:undefined,paused:undefined,decision:undefined,deferred:undefined,deferredSince:undefined});
    const summary=result&&typeof result==='object'?{count:Array.isArray((result as any).items)?(result as any).items.length:undefined,complete:(result as any).complete,failed:(result as any).failed}:{};
    this.event('invoice.watcher.sync.completed',{elapsedMs:completedAt-startedAt,cancelledAfterStart:!this.active||this.epoch!==epoch,...summary});
    if(!this.active||this.epoch!==epoch)return;
    config=this.config();delay=config.intervalMs;
   }catch(error){
    const classified=classifyError(error);
    if(classified.code===FREEZE_CODE){
     // The freeze landed mid-cycle. Same rule as the flag: defer, do not count it, do not back off.
     delay=this.defer(this.state(),config,{source:'error'});
     if(!this.active||this.epoch!==epoch)return;
     continue;
    }
    const failures=(state.failures||0)+1;
    const pause=classified.code==='OUTCOME_UNKNOWN'?'outcome-unknown':classified.retryable?undefined:'action-required';
    if(pause){
     state=this.saveState({...this.state(),inFlight:false,operationStartedAt:undefined,failures,lastError:classified,paused:pause,nextRunAt:undefined,decision:this.decisionFor(classified)});
     this.event('invoice.watcher.sync.error',{...classified,failures,retryScheduled:false,paused:pause,pendingFilings:state.decision?.pending?.length||0});
     this.active=false;return;
    }
    config=this.config();delay=Math.min(config.maxBackoffMs,config.backoffBaseMs*2**Math.min(failures-1,20));
    state=this.saveState({...this.state(),inFlight:false,operationStartedAt:undefined,failures,lastError:classified,nextRunAt:this.scheduler.now()+delay});
    this.event('invoice.watcher.sync.error',{...classified,failures,retryScheduled:true,delayMs:delay});
    if(!this.active||this.epoch!==epoch)return;
   }finally{
    if(this.operation===operation)this.operation=null;
   }
   state=this.saveState({...state,nextRunAt:this.scheduler.now()+delay});
  }
 }
}
