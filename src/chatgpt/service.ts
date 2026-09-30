import {join,dirname,resolve} from 'node:path';
import {writeFileSync,readFileSync,existsSync,renameSync,lstatSync,unlinkSync,statSync} from 'node:fs';
import {BrowserWorker} from './transport.ts';
import {Store,paginate,paginateCursor,messagePath,recordId,type Coverage} from './store.ts';
import {accountDir,saveAccount,privateDir,atomicJSON,readJSON,type Account} from './accounts.ts';

async function fresh(name:string){const path=join(import.meta.dir,'fresh.ts');const loader=await import(path+'?revision='+statSync(path).mtimeMs);return loader.fresh(name);}
import {WebsiteVoice} from './voice.ts';
import {InvoiceWatcher} from './watchers.ts';
import {listMedia,downloadMedia as resolveMedia} from './media.ts';
import {importInvoices} from './invoices.ts';
import {createHash} from 'node:crypto';
import {runTakeout,auditTakeout} from './takeout.ts';
import {Actions} from './actions.ts';
import {adapter,route,validateAdapter,promoteAdapter,rollbackAdapter,adapterDiagnostic} from './adapters.ts';
import {classifyError,recordEvent} from './monitor.ts';
import {capabilityReport} from './capabilities.ts';
import {RuntimeGate,runtimeRevision} from './runtime.ts';
import {readFreeze,setFreeze} from './freeze.ts';
import type {Gateway} from './gateway.ts';
import {accountGateway,routeWorkerThroughGateway} from './gateway-registry.ts';

/** Pure local reads plus the freeze switch: safe to run in-process when the daemon is unreachable (no browser, no site traffic). */
export const DIRECT_READ_OPERATIONS=new Set(['online.list','online.status','receipts.list','receipts.get','conversations.cached','conversations.search','takeout.status','takeout.audit','takeout.watch-status','flow.validate','flow.status','capabilities.list','map.capabilities','adapter.get','adapter.validate','monitor.events','invoices.watcher','freeze.set','freeze.status']);

export class ChatGPTService {
 browser:BrowserWorker; store:Store; actions:Actions; busy=false; cancelled=false; requestQueue:Promise<void>=Promise.resolve(); nextRequestAt=0; rateLimitedUntil=0; invoiceWatcher?:InvoiceWatcher; rateFailures=0; lastRateLimitedAt=0; limitedScope=""; conversationReadsPaused=false;
 runtimeGate?:RuntimeGate; gateway?:Gateway;
 constructor(public account:Account,options:{autoResume?:boolean}={}){this.browser=new BrowserWorker(account);this.store=new Store(account);this.actions=new Actions(this.browser,path=>this.receipt(path));this.runtimeGate=this.makeRuntimeGate();const saved=readJSON<any>(join(accountDir(account),'request-state.json'),{});this.rateLimitedUntil=saved.rateLimitedUntil||0;this.rateFailures=saved.rateFailures||0;this.lastRateLimitedAt=saved.lastRateLimitedAt||0;this.limitedScope=saved.limitedScope||'';this.conversationReadsPaused=saved.conversationReadsPaused||false;this.installGateway();const recovery=options.autoResume===false?{}:readJSON<any>(join(accountDir(account),'takeout-supervisor.json'),{});if(recovery.enabled)queueMicrotask(()=>void this.superviseTakeout({output:recovery.output}).catch(error=>recordEvent(this.account,{type:'takeout.supervisor.error',...classifyError(error)})));}
/**
 * Route every worker call through one gateway: dedupe, pacing, policy, circuit breaker.
 *
 * Staged on purpose. With NO gateway.json the loader reports `builtin` and the gateway stays out of
 * the path entirely, so a machine that has not opted in behaves exactly as before and this cannot
 * regress his terminal. Writing the file is the switch, which is also what makes the protocol a
 * config change rather than a code change. An invalid or too-new file still installs the gateway, so
 * it fails CLOSED: refusing site traffic is the safe direction, and local reads and freeze keep working.
 */
 installGateway(){
  const state=()=>({rateLimitedUntil:this.rateLimitedUntil,limitedScope:this.limitedScope});
  if(routeWorkerThroughGateway(this.account,this.browser as any,state))this.gateway=accountGateway(this.account,state);
 }
 makeRuntimeGate(){return new RuntimeGate(runtimeRevision(),()=>this.execute('runtime.reload'),event=>{const {detail,...rest}=event;recordEvent(this.account,{...rest,...(detail?classifyError(detail):{})});});}
 watcher(){if(!this.invoiceWatcher)this.invoiceWatcher=new InvoiceWatcher(this.account,async cfg=>{await this.start();return this.syncInvoices({projectPath:cfg.projectPath},e=>recordEvent(this.account,e));},{emit:e=>recordEvent(this.account,e)});return this.invoiceWatcher;}
 async start(headless=this.account.headless??true){await this.browser.start(headless);}
 async identity(){const s=await this.browser.call('session');if(s.authenticated&&s.user?.id){this.store.bindIdentity(s.user.id);this.account={...this.account,userId:s.user.id,email:s.user.email,label:s.user.name||this.account.label};saveAccount(this.account);}return s;}
 saveRequestState(){atomicJSON(join(accountDir(this.account),'request-state.json'),{rateLimitedUntil:this.rateLimitedUntil,rateFailures:this.rateFailures,lastRateLimitedAt:this.lastRateLimitedAt,limitedScope:this.limitedScope,conversationReadsPaused:this.conversationReadsPaused});}
 async receipt(path:string){if(this.conversationReadsPaused||this.rateLimitedUntil>Date.now())throw Object.assign(new Error('429: conversation receipt lookup is paused by account rate limiting.'),{status:429,retryAfterMs:Math.max(60000,this.rateLimitedUntil-Date.now())});return this.request(path);}
 async request(path:string,method='GET',body?:any,binary=false){
  while(this.conversationReadsPaused&&/^\/backend-api\/conversation\//.test(path))await Bun.sleep(500);
  this.requestQueue??=Promise.resolve();this.nextRequestAt??=0;this.rateLimitedUntil??=0;this.rateFailures??=0;this.limitedScope??='';let release!:()=>void;const previous=this.requestQueue;this.requestQueue=new Promise<void>(r=>release=r);await previous;
  try{const wait=Math.max(this.nextRequestAt,this.rateLimitedUntil)-Date.now();if(wait>0)await Bun.sleep(wait);this.nextRequestAt=Date.now()+(/^\/backend-api\/conversation\//.test(path)?5000:1000);
   const directory=binary?privateDir(join(accountDir(this.account),'transfers')):undefined;
   const r=await this.browser.call('request',{path,method,body,binary,workspace:this.account.workspace,...(directory?{directory}:{})},binary?600000:45000);if(r.userId)this.store.bindIdentity(r.userId);
   if(binary&&r.path){if(dirname(resolve(r.path))!==directory||lstatSync(r.path).isSymbolicLink())throw new Error('Invalid private asset transfer path.');const transferPath=r.path;try{const bytes=readFileSync(transferPath);if(bytes.length!==r.size||createHash('sha256').update(bytes).digest('hex')!==r.sha256)throw new Error('Asset transfer integrity mismatch.');r.bytes=bytes;delete r.path;}finally{unlinkSync(transferPath);}}
   if(r.status<200||r.status>=300){let retryAfterMs=0;if(r.status===429){const seconds=Number(r.retryAfter);retryAfterMs=r.retryAfter&&Number.isFinite(seconds)?seconds*1000:r.retryAfter?Math.max(0,Date.parse(r.retryAfter)-Date.now()):60000;this.rateFailures++;this.lastRateLimitedAt=Date.now();this.limitedScope=path.split('?')[0].replace(/\/conversation\/[^/]+$/,'/conversation/{id}');retryAfterMs=Math.max(Math.min(900000,60000*2**Math.min(this.rateFailures-1,4)),retryAfterMs);this.rateLimitedUntil=Date.now()+retryAfterMs;this.saveRequestState();recordEvent(this.account,{type:'rate.limit',scope:this.limitedScope,resource:path.split('?')[0],retryAt:new Date(this.rateLimitedUntil).toISOString(),retryAfterMs});}
    throw Object.assign(new Error(`ChatGPT ${method} ${path.split('?')[0]} returned ${r.status}: ${typeof r.body==='string'?r.body.slice(0,150):JSON.stringify(r.body)?.slice(0,150)}`),{status:r.status,retryAfterMs,code:r.status===429?'RATE_LIMITED':undefined});}
   if(Date.now()-(this.lastRateLimitedAt||Date.now())>900000&&path.split('?')[0].replace(/\/conversation\/[^/]+$/,'/conversation/{id}')===this.limitedScope){this.rateFailures=0;this.limitedScope='';this.saveRequestState();}return binary?r:r.body;
  }finally{release();}
 }

 async conversations(args:any={}){await this.identity();const variants=args.archived==='all'?[false,true]:[args.archived===true];const all:any[]=[];const receipts:Coverage[]=[];for(const archived of variants){const scope=archived?'conversations:archived':'conversations:active';const result=await paginate((offset,limit)=>this.request(`${route('conversations')}?offset=${offset}&limit=${limit}&order=updated&is_archived=${archived}`),scope,{limit:args.pageSize||100,maxPages:args.maxPages,onPage:items=>{for(const r of items)this.store.put('chat',r);}});receipts.push(this.store.receipt(result.coverage));all.push(...result.items);}return {items:all,coverage:receipts,complete:receipts.every(r=>r.complete)};}
 async conversation(id:string){const raw=await this.request(route('conversation',id));this.store.put('conversation',{...raw,id:raw.id||raw.conversation_id||id});return raw;}
 async navigate(args:any){const url=args.url||`${this.account.baseURL}${args.conversation?'/c/'+encodeURIComponent(args.conversation):args.project?'/g/'+encodeURIComponent(args.project)+'/project':args.gpt?'/g/'+encodeURIComponent(args.gpt):'/'}`;const existing=await this.actions.snapshot();if(existing.url===url&&(!args.conversation||existing.messages.length))return {url,conversation:args.conversation,loaded:true,reused:true};const result=await this.browser.call('goto',{url});if(!args.conversation)return result;
  const expected=new URL(url).pathname,until=Date.now()+30000;
  while(Date.now()<until){const snapshot=await this.actions.snapshot();if(new URL(snapshot.url).pathname!==expected)throw new Error('Conversation navigation redirected away from the requested chat. No message was sent; inspect account access or site rate limits.');if(snapshot.messages.length)return {...result,url:snapshot.url,conversation:args.conversation,loaded:true};await Bun.sleep(250);}
  throw new Error('Timed out loading the requested conversation. No message was sent; inspect the existing chat and website rate limits.');
 }
 async catalog(kind:string,args:any={}){await this.identity();const path=route(kind);const field=kind==='gpts'?'gizmos':'items';const result=await paginateCursor(cursor=>this.request(path+(cursor?(path.includes('?')?'&':'?')+'cursor='+encodeURIComponent(cursor):'')),kind==='gpts'?'gpts:bootstrap':kind,{field,maxPages:args.maxPages,onPage:items=>{for(const r of items)this.store.put(kind,r);}});this.store.receipt(result.coverage);return {...result,complete:result.coverage.complete};}
 async invoices(args:any={}){const accounts=await this.request(route('account'));const id=this.account.workspace||accounts.account_ordering?.[0]||Object.keys(accounts.accounts||{}).find(k=>k!=='default');if(!id)throw new Error('Cannot determine billing account identity.');const result=await paginateCursor(cursor=>this.request(route('invoices')+'?account_id='+encodeURIComponent(id)+'&limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):'')),'invoices',{field:'transactions',onPage:items=>{for(const r of items)this.store.put('invoice',r);}});this.store.receipt(result.coverage);return {...result,complete:result.coverage.complete,accountId:id};}
 async downloadInvoice(args:any){const listing=await this.invoices(args),invoice=listing.items.find((x:any)=>x.id===args.id);if(!invoice)throw new Error('Invoice ID was not found in the complete account billing list.');if(!invoice.invoice_url)throw new Error('Invoice does not expose a download page.');await this.browser.call('surface.open',{surface:'invoice',url:invoice.invoice_url});let snap:any,control:any;for(let i=0;i<80;i++){snap=await this.browser.call('snapshot',{surface:'invoice'});control=snap.controls.find((c:any)=>c.name==='Download invoice');if(control)break;await Bun.sleep(250);}if(!control)throw new Error('Invoice download control was not found. Capture the invoice surface snapshot.');const directory=join(accountDir(this.account),'downloads',crypto.randomUUID());privateDir(directory);const result=await this.browser.call('download',{surface:'invoice',ref:control.ref,epoch:snap.epoch,directory},120000);const bytes=readFileSync(result.path);if(bytes.subarray(0,5).toString()!=='%PDF-')throw new Error('Invoice download was not a PDF; preserved for inspection.');const destination=args.output||join(directory,'invoice.pdf');renameSync(result.path,destination);return {...result,path:destination,id:invoice.id,verifiedPDF:true};}
 async voice(){const {WebsiteVoice}=await fresh('voice');return new WebsiteVoice(this.browser,this.actions);}
 async originalTakeout(){if(this.busy)throw new Error('Wait for generation before opening export settings.');return this.actions.originalExport(true);}
 async downloadMedia(reference:any){return (await fresh('media')).downloadMedia(reference,(...args:any[])=>this.request(args[0],args[1],args[2],args[3]));}
 async syncInvoices(args:any,emit:(e:any)=>void){const listing=await this.invoices(args),file=join(accountDir(this.account),'invoice-sync.json'),state=readJSON<any>(file,{invoices:{}}),results=[];for(const item of listing.items){const previous=state.invoices[item.id];if(previous?.imported&&existsSync(previous.path)&&createHash('sha256').update(readFileSync(previous.path)).digest('hex')===previous.sha256){results.push({id:item.id,status:'already-saved',path:previous.path});continue;}const downloaded=await this.downloadInvoice({id:item.id});const imported=await importInvoices([downloaded.path],{projectPath:args.projectPath});const result=imported.results[0];if(imported.failed)throw new Error('Invoice downloaded but filing failed: '+result.message);state.invoices[item.id]={path:downloaded.path,sha256:createHash('sha256').update(readFileSync(downloaded.path)).digest('hex'),imported:true,at:new Date().toISOString(),file:result.file};atomicJSON(file,state);results.push({id:item.id,...result});emit({type:'invoice.saved',id:item.id,status:result.status});}return {items:results,complete:listing.complete};}
 async selectionInteract(args:any,fn:()=>Promise<any>){
  if(!args.surface)return this.interact(fn);
  if(['main','api'].includes(args.surface))throw new Error('Use a dedicated auxiliary surface name.');
  const self=this as any;self.selectionSurfaces??=new Set<string>();if(self.selectionSurfaces.has(args.surface))throw new Error('A selection operation is active in this browser surface.');
  self.selectionSurfaces.add(args.surface);try{return await fn();}finally{self.selectionSurfaces.delete(args.surface);}
 }
 async selectionActions(args:any){
  const {Actions:SelectionActions}=await fresh('actions');
  const actions=args.surface?new SelectionActions({account:this.browser.account,call:(op:string,params:any={},timeout?:number)=>this.browser.call(op,{...params,surface:args.surface},timeout)} as any):this.actions;
  const current=await actions.idle();
  if(args.conversation||args.project||args.gpt||args.new){
   const path=args.conversation?'/c/'+encodeURIComponent(args.conversation):args.project?'/g/'+encodeURIComponent(args.project)+'/project':args.gpt?'/g/'+encodeURIComponent(args.gpt):'/';
   if(new URL(current.url).pathname!==path){
    if(args.surface)await actions.b.call('goto',{url:this.account.baseURL+path});else await this.navigate(args);
    const next=await actions.snapshot();if(new URL(next.url).pathname!==path)throw new Error('Requested selection context did not load. No model or effort was changed.');
   }
  }
  return actions;
 }
 async workFallback(args:any,emit:(event:any)=>void){
  const {workUsageLimit}=await fresh('work-usage');const snapshot=await this.actions.snapshot(),limit=workUsageLimit(snapshot);if(!limit)return args;
  const result=await this.actions.mode('Chat');
  if(!result.verified)throw new Error('Work usage is exhausted and switching to Chat was not verified. No message was sent.');
  const options=await this.actions.options();const model=options.models.find((item:any)=>item.selected)?.label,effort=options.selectedEffort;
  emit({type:'mode.fallback',from:'Work',to:'Chat',verified:true,reason:limit.reason,source:limit.source,model,effort});
  return {...args,mode:'Chat',model,effort};
 }
 async superviseTakeout(args:any={}){
  const module=await fresh('takeout-supervisor'),output=args.archive||args.output||join(accountDir(this.account),'takeout'),cfg=join(accountDir(this.account),'takeout-supervisor.json');
  module.setTakeoutSupervisorPaused(output,false);atomicJSON(cfg,{enabled:true,output});
  const lock=join(output,'.supervisor.lock');if(existsSync(lock)){const pid=Number(readFileSync(lock,'utf8'));try{process.kill(pid,0);return {running:true,pid,source:'existing recovery supervisor',...module.inspectTakeoutRecovery(output,{accountRoot:accountDir(this.account)})};}catch(error:any){if(error.code!=='ESRCH')throw error;}}
  const self=this as any;if(self.takeoutSupervisorTask)return {running:true,...module.inspectTakeoutRecovery(output,{accountRoot:accountDir(this.account)})};
  const supervisor=new module.TakeoutSupervisor({output,accountRoot:accountDir(this.account),launch:()=>this.dispatch('takeout.run',{output,resume:true}),emit:(event:any)=>recordEvent(this.account,event)});
  self.takeoutSupervisorTask=supervisor.run().catch((error:any)=>recordEvent(this.account,{type:'takeout.supervisor.error',...classifyError(error)})).finally(()=>{self.takeoutSupervisorTask=undefined;});
  return {running:true,...module.inspectTakeoutRecovery(output,{accountRoot:accountDir(this.account)})};
 }
 async send(args:any,emit:(e:any)=>void){const rejectPreparation=(message:string):never=>{emit({type:'submission.failed',submissionState:'not-submitted',message});throw Object.assign(new Error(message),{code:'NOT_SUBMITTED',submissionState:'not-submitted',action:'No submit was attempted. Preserve this draft and retry after resolving the preparation failure.'});};if(this.busy)rejectPreparation('A generation is already active in this account.');if(!args.text?.trim()&&!args.files?.length)rejectPreparation('A message or attachment is required.');this.busy=true;this.cancelled=false;let submitAttempted=false;try{const identity=await this.identity();if(!identity.authenticated)throw new Error('Sign in to ChatGPT before sending a message.');await this.actions.idle();if(args.conversation||args.project||args.gpt||args.new)await this.navigate(args);if(args.mode)await this.actions.mode(args.mode);args=await this.workFallback(args,emit);if(args.model)await this.actions.choose('model',args.model);if(args.effort)await this.actions.choose('effort',args.effort);if(args.files?.length)await this.browser.call('upload',{files:args.files,selector:args.selector});await this.actions.composer(args.text||'');const before=await this.actions.snapshot();submitAttempted=true;await this.actions.submit(args.files?.length?120000:10000);emit({type:'submission.pending',url:before.url,source:'website submit control activated'});let result;try{result=await this.actions.waitReply(before,emit,args.timeout||600000,()=>this.cancelled);}catch(error:any){if(error.code==='WORK_USAGE_EXHAUSTED'){try{await this.workFallback(args,emit);}catch(fallbackError:any){emit({type:'mode.fallback.error',message:fallbackError.message});}throw Object.assign(error,{action:'Chat fallback was attempted. Inspect the existing message before sending again; automatic replay is blocked.'});}throw error;}if(result.conversation){const previous=this.store.get('chat',result.conversation)||{};this.store.put('chat',{...previous,id:result.conversation,title:previous.title||args.text?.slice(0,100)||'ChatGPT conversation',url:result.url,update_time:new Date().toISOString()});if(!this.conversationReadsPaused&&this.rateLimitedUntil<=Date.now())void this.conversation(result.conversation).catch(error=>recordEvent(this.account,{type:'index.deferred',conversation:result.conversation,...classifyError(error)}));}return result;}catch(error:any){if(!submitAttempted){const cause=classifyError(error);Object.assign(error,{code:'NOT_SUBMITTED',submissionState:'not-submitted',causeCode:cause.code,action:'No submit was attempted. Your draft can be retried after the reported preparation failure is fixed.'});emit({type:'submission.failed',submissionState:'not-submitted',causeCode:cause.code,message:cause.message});}throw error;}finally{this.busy=false;}}
 async interact(fn:()=>Promise<any>){if(this.busy)throw Object.assign(new Error('An account interaction is active. Wait or stop it before changing this conversation.'),{code:'OPERATION_BUSY',action:'Wait for the active operation or stop the current generation.'});this.busy=true;try{return await fn();}finally{this.busy=false;}}
 async dispatch(op:string,args:any={},emit:(event:any)=>void=()=>{}):Promise<any>{this.runtimeGate??=this.makeRuntimeGate();if(op!=='runtime.reload')await this.runtimeGate.check(runtimeRevision());const started=Date.now(),id=crypto.randomUUID();let journal:any,attempt:any,executionStarted=false;recordEvent(this.account,{type:'operation.start',id,operation:op});try{const receipts=await fresh('receipts');if(receipts.shouldJournal(op)){if(!this.account.userId){await this.start();await this.identity();}journal=new receipts.OperationJournal(this.account);attempt=journal.start(op,args);emit({type:'operation.receipt',requestId:attempt.id,reused:attempt.reused});if(attempt.reused)return attempt.result;}executionStarted=true;const result=await this.execute(op,args,emit);if(journal)journal.finish(attempt.id,result);if(!op.startsWith('ui.')&&!op.startsWith('map.')&&!op.startsWith('monitor.')&&!op.startsWith('api.')){const path=join(accountDir(this.account),'capability-evidence.json'),evidence=readJSON<any>(path,{});evidence[op]={at:new Date().toISOString(),adapter:adapter().version,operation:op,complete:result?.complete,observedSuccess:true};atomicJSON(path,evidence);}recordEvent(this.account,{type:'operation.complete',id,operation:op,elapsedMs:Date.now()-started});return result;}catch(error){if(!executionStarted&&['chat.send','chat.new'].includes(op)&&!['NEEDS_RECONCILIATION','REQUEST_ID_MISMATCH','RECEIPT_CORRUPT','ACCOUNT_MISMATCH'].includes((error as any).code)){Object.assign(error as any,{code:'NOT_SUBMITTED',submissionState:'not-submitted',action:'No send operation began. Resolve the preparation error before retrying the preserved draft.'});emit({type:'submission.failed',submissionState:'not-submitted'});}const detail=classifyError(error);if(journal&&attempt&&!attempt.reused){try{journal.fail(attempt.id,{...detail,status:(error as any).status});Object.assign(error as any,{requestId:attempt.id});}catch{}}if(detail.code==='SITE_DRIFT'){try{const path=join(accountDir(this.account),'drift',id+'.json');atomicJSON(path,{operation:op,adapter:adapter().version,snapshot:await this.actions.snapshot(),at:new Date().toISOString()});Object.assign(error as any,{evidencePath:path});recordEvent(this.account,{type:'drift.snapshot',operation:op,path});}catch{}}recordEvent(this.account,{type:'operation.error',id,operation:op,...detail});throw error;}}
 async messageQueue(op:string,args:any={},emit:(event:any)=>void=()=>{}) {
  const supported=['add','list','status','edit','remove','reorder','pause','resume','run','retry','reconcile'];
  const action=op.slice(6);if(!supported.includes(action))throw Object.assign(new Error('Unknown queue operation.'),{code:'QUEUE_OPERATION_UNKNOWN'});
  if(!this.account.userId)throw Object.assign(new Error('Run chatgpt status once to bind the selected website account before creating a durable queue.'),{code:'ACCOUNT_IDENTITY_REQUIRED'});
  const {MessageQueue}=await fresh('message-queue'),queue=new MessageQueue(this.account);
  const source='durable local queue shared by CLI and TUI';
  const draft=Object.fromEntries(['text','files','conversation','new','project','gpt','mode','model','effort','timeout'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]));
  let item;
  switch(action){
   case 'list':case 'status':break;
   case 'add':item=queue.add(draft,args.clientId);break;
   case 'edit':item=queue.edit(args.id,draft);break;
   case 'remove':queue.remove(args.id);break;
   case 'reorder':queue.reorder(args.id,args.index);break;
   case 'pause':queue.pause();break;
   case 'resume':queue.resume();break;
   case 'retry':item=queue.retry(args.id);break;
   case 'reconcile':{
    const current=queue.status().items.find((entry:any)=>entry.id===args.id);
    if(!current)throw Object.assign(new Error('Queue item was not found.'),{code:'QUEUE_NOT_FOUND'});
    const {OperationJournal}=await fresh('receipts');item=queue.reconcile(args.id,new OperationJournal(this.account).get(current.requestId));break;
   }
   case 'run':return {queueKind:source,...await queue.run((draft:any,event:any)=>this.dispatch('chat.send',draft,event),{emit,signal:args._signal,maxItems:args.maxItems})};
  }
  return {...queue.status(),queueKind:source,...(item?{item}:{})};
 }
 async execute(op:string,args:any={},emit:(event:any)=>void=()=>{}) : Promise<any>{
  if(op.startsWith('queue.'))return this.messageQueue(op,args,emit);
  if(['harness.run','harness.test','harness.status','harness.list'].includes(op)){const harness=await fresh('harness-run');return ['harness.status','harness.list'].includes(op)?harness.harnessStatus(this.account,op==='harness.list'?undefined:args.runId||args.id):harness.runHarness(this.account,{...args,test:op==='harness.test'},emit);}
  if(op==='browser.start'){await this.start(args.headless!==false);const status=await this.browser.call('status');if(status.owned){this.account={...this.account,transportMode:'managed',headless:status.headless};this.browser.account=this.account;saveAccount(this.account);}return status;}
  if(op==='browser.stop'){await this.browser.close();return {stopped:true};}
  if(!new Set(['online.list','online.status','receipts.list','receipts.get','runtime.reload','conversations.cached','conversations.search','takeout.status','takeout.pause','takeout.resume','takeout.audit','takeout.watch','takeout.watch-status','takeout.unwatch','flow.validate','flow.status','capabilities.list','map.capabilities','adapter.get','adapter.validate','adapter.promote','adapter.rollback','monitor.events','monitor.watch','invoices.watcher','invoices.watch','invoices.unwatch','freeze.set','freeze.status']).has(op)&&!(op==='status'&&readFreeze(this.account).frozen))await this.start();
  switch(op){
   case 'online.list':case 'online.status':{const receipts=await fresh('online-receipts');return op==='online.list'?receipts.listOnlineRequests(this.account,args):receipts.onlineRequestStatus(this.account,args);}
   case 'receipts.list':case 'receipts.get':{const {OperationJournal}=await fresh('receipts');const journal=new OperationJournal(this.account);return op==='receipts.list'?journal.list(args):journal.get(args.id);}
   case 'freeze.status':return {...readFreeze(this.account),browserRunning:this.browser.running()};
   case 'freeze.set':{const frozen=!(args.frozen===false||args.frozen==='false');const state=setFreeze(this.account,frozen,{by:args.by||'cli',reason:args.reason||args.text});let stopped:any;if(frozen&&this.busy&&this.browser.running()){this.cancelled=true;stopped=await this.actions.stop().catch(error=>({stopped:false,error:String(error?.message||error)}));}return {...state,...(stopped?{stopped}:{})};}
   case 'status':{const freeze=readFreeze(this.account);return {...(freeze.frozen?{frozen:freeze}:{}),browser:this.browser.running()?await this.browser.call('status'):{running:false},session:freeze.frozen?{skipped:'frozen'}:await this.identity(),account:this.account.id,coverage:this.store.receipts(),busy:this.busy};}
   case 'conversations.list':return this.conversations(args);
   case 'conversations.rename':case 'conversations.pin':case 'conversations.unpin':case 'conversations.archive':case 'conversations.unarchive':case 'conversations.share':case 'conversations.unshare':return this.interact(async()=>{const surface='conversation-operations';await this.browser.call('surface.open',{surface,url:this.account.baseURL});const {ConversationActions}=await fresh('conversation-actions');const result=await new ConversationActions(this.browser,surface).manage(op.split('.')[1],{id:args.id,title:args.title||args.text});if(result.verifiedUI&&op==='conversations.rename'){const existing=this.store.get('chat',args.id)||{};this.store.put('chat',{...existing,id:args.id,title:args.title||args.text});}return result;});
   case 'conversations.cached':return {items:(await fresh('store')).observedRecords(this.store,'chat'),coverage:this.store.receipts(),source:'local index'};
   case 'conversations.get':return args.cached?this.store.get('conversation',args.id)||this.conversation(args.id):this.conversation(args.id);
   case 'conversations.path':return messagePath(args.cached&&this.store.get('conversation',args.id)||await this.conversation(args.id),args.node);
   case 'conversations.search':return {items:this.store.list(args.fullText?'conversation':'chat',args.query||''),coverage:this.store.receipts(),source:'local index'};
   case 'conversations.export':{const raw=await this.conversation(args.id);if(!args.output)return raw;writeFileSync(args.output,JSON.stringify(raw,null,2)+'\n',{mode:0o600});return {path:args.output,nodes:Object.keys(raw.mapping||{}).length};}
   case 'takeout.run':if(args.original)return this.originalTakeout();return (await fresh('takeout')).runTakeout(this,args,emit);
   case 'media.list':return (await fresh('media')).listMedia((...a:any[])=>this.request(a[0],a[1],a[2],a[3]),args);
   case 'media.export':{const media=await fresh('media');const catalog=args.catalog?JSON.parse(readFileSync(args.catalog,'utf8')):await media.listMedia((...a:any[])=>this.request(a[0],a[1],a[2],a[3]),{includeRaw:true});return media.exportMedia(catalog,(...a:any[])=>this.request(a[0],a[1],a[2],a[3]),{output:args.output||join(accountDir(this.account),'media-export'),accountId:this.account.id,userId:this.account.userId},emit);}
   case 'media.audit':return (await fresh('media')).auditMedia(args.output||join(accountDir(this.account),'media-export'));
   case 'media.download':{const result=await this.downloadMedia(args.id);if(!args.output)throw new Error('Media download requires --output PATH.');writeFileSync(args.output,result.bytes,{mode:0o600});return {path:args.output,...result.metadata};}
   case 'takeout.watch':return this.superviseTakeout(args);
   case 'takeout.watch-status':return (await fresh('takeout-supervisor')).inspectTakeoutRecovery(args.archive||args.output||join(accountDir(this.account),'takeout'),{accountRoot:accountDir(this.account)});
   case 'takeout.unwatch':{const output=args.archive||args.output||join(accountDir(this.account),'takeout');atomicJSON(join(accountDir(this.account),'takeout-supervisor.json'),{enabled:false,output});return (await fresh('takeout-supervisor')).setTakeoutSupervisorPaused(output,true);}
   case 'takeout.pause':this.conversationReadsPaused=true;this.saveRequestState();return {paused:true,scope:'conversation-detail reads',checkpointsPreserved:true};
   case 'takeout.resume':this.conversationReadsPaused=false;this.saveRequestState();return {resumed:true,scope:'conversation-detail reads'};
   case 'takeout.status':{const path=args.archive||join(accountDir(this.account),'takeout'),manifest=readJSON<any>(join(path,'manifest.json'),null);return {path,exists:!!manifest,paused:this.conversationReadsPaused,complete:manifest?.complete||false,files:Object.keys(manifest?.files||{}).length,coverage:manifest?.coverage,updated:manifest?.updated,rateLimit:this.rateLimitedUntil>Date.now()?{retryAt:new Date(this.rateLimitedUntil).toISOString(),failures:this.rateFailures}:null};}
   case 'takeout.audit':return auditTakeout(args.archive||join(accountDir(this.account),'takeout'));
   case 'chat.send':return this.send(args,emit);
   case 'chat.new':return this.send({...args,new:true},emit);
   case 'chat.edit':return this.interact(()=>this.actions.edit(args.message||args.id,args.text,emit));
   case 'chat.branch':return this.interact(()=>this.actions.branch(args.message||args.id));
   case 'chat.regenerate':return this.interact(()=>this.actions.regenerate(args.message||args.id,emit));
   case 'chat.reconcile':{const snapshot=await this.actions.snapshot(),conversation=snapshot.url.match(/\/c\/([^/?]+)/)?.[1];if(args.conversation&&args.conversation!==conversation)throw new Error('The browser is showing another conversation. Open the requested chat before reconciliation.');const history=conversation?(await fresh('observed-history')).readObservedHistory(this.account,snapshot):{messages:snapshot.messages,coverage:{complete:false,source:'currently mounted website messages'}};return {conversation,url:snapshot.url,messages:history.messages,historyCoverage:history.coverage,thinking:snapshot.thinking||[],media:snapshot.media,active:snapshot.controls.some((c:any)=>c.testId==='stop-button'||/^(Stop answering|Stop generating|Cancel loading)$/.test(c.name)),source:'observed website conversation',verified:true};}
   case 'chat.stop':this.cancelled=true;return this.actions.stop();
   case 'chat.mode':return this.selectionInteract(args,async()=> (await this.selectionActions(args)).mode(args.mode||args.id));
   case 'chat.model':return this.selectionInteract(args,async()=> (await this.selectionActions(args)).choose('model',args.model||args.id));
   case 'chat.effort':return this.selectionInteract(args,async()=> (await this.selectionActions(args)).choose('effort',args.effort||args.id));
   case 'projects.list':return this.catalog('projects',args);
   case 'gpts.bootstrap':return this.catalog('gpts',args);
   case 'gpts.list':case 'gpts.catalog':case 'gpts.owned':{const result=await (await fresh('gpts')).fetchGPTCatalog(path=>this.request(path),{...args,...(op!=='gpts.catalog'?{scope:'owned',includeRaw:true}:{})});for(const item of result.items)this.store.put('gpts',item);return result;}
   case 'projects.get':case 'gpts.get':return this.request(route('project',args.id));
   case 'projects.chats':{const result=await paginateCursor(cursor=>this.request(route('projectChats',args.id)+'?cursor='+encodeURIComponent(cursor||'0')),'project:'+args.id,{onPage:items=>{for(const r of items)this.store.put('chat',r);}});this.store.receipt(result.coverage);return {...result,complete:result.coverage.complete};}
   case 'account.get':return this.request(route('account'));
   case 'features.list':return this.request(route('features'));
   case 'settings.get':return this.request(route('settings'));
   case 'settings.instructions':return this.request(route('instructions'));
   case 'settings.open':return this.actions.settings(args.section||args.id);
   case 'settings.set':return this.interact(async()=> (await fresh('settings')).setSetting(this.actions,args));
   case 'settings.map':{const result=await this.actions.settingsMap(emit);atomicJSON(join(accountDir(this.account),'settings-map.json'),result);return result;}
   case 'capabilities.list':case 'map.capabilities':return (await fresh('capabilities')).capabilityReport(readJSON(join(accountDir(this.account),'settings-map.json'),null),this.store.receipts(),readJSON(join(accountDir(this.account),'capability-evidence.json'),{}),readJSON(join(accountDir(this.account),'surface-map.json'),{}));
   case 'runtime.reload':{const [{Actions:Next},loaded]=await Promise.all([fresh('actions'),fresh('service')]);if(typeof Next!=='function'||typeof loaded.ChatGPTService!=='function')throw new Error('Runtime revision lacks required service/actions exports.');const actions=new Next(this.browser,path=>this.receipt(path));const browser=await this.browser.call('reload').catch(error=>{if(error.message==='Browser worker not running.')return {deferred:true};throw error;});this.actions=actions;Object.setPrototypeOf(this,loaded.ChatGPTService.prototype);return {service:true,actions:true,browser};}
   case 'adapter.get':return {...adapter(),diagnostics:adapterDiagnostic()};
   case 'adapter.rollback':return rollbackAdapter(args.id||args.version);
   case 'adapter.validate':{const a=args.body||JSON.parse(readFileSync(args.path,'utf8'));validateAdapter(a);return {valid:true,version:a.version,behaviorallyVerified:false};}
   case 'adapter.promote':return promoteAdapter(args.body||JSON.parse(readFileSync(args.path,'utf8')));
   case 'monitor.watch':{const p=join(accountDir(this.account),'events.jsonl');let previous='';while(!args._signal?.aborted){const content=existsSync(p)?readFileSync(p,'utf8'):'';if(content!==previous){const suffix=content.startsWith(previous)?content.slice(previous.length):content;for(const line of suffix.trim().split('\n').filter(Boolean))emit(JSON.parse(line));previous=content;}await Bun.sleep(1000);}return {disconnected:true};}
   case 'monitor.events':{const p=join(accountDir(this.account),'events.jsonl');return {items:existsSync(p)?readFileSync(p,'utf8').trim().split('\n').filter(Boolean).slice(-(args.limit||100)).map(l=>JSON.parse(l)):[]};}
   case 'invoices.list':return this.invoices(args);
   case 'invoices.download':{if(args.all||args.archived==='all'){const list=await this.invoices(args),items=[];for(const x of list.items)items.push(await this.downloadInvoice({id:x.id}));return {items,complete:list.complete};}return this.downloadInvoice(args);}
   case 'invoices.sync':return this.syncInvoices(args,emit);
   case 'invoices.watch':{const watcher=this.watcher();if(args.interval||args.projectPath)watcher.config({...(args.interval?{intervalMs:Number(args.interval)*1000}:{}),...(args.projectPath?{projectPath:args.projectPath}:{})});return watcher.start({acknowledgeAmbiguous:args.acknowledge===true});}
   case 'invoices.unwatch':return this.watcher().stop();
   case 'invoices.watcher':return this.watcher().status();
   case 'tasks.list':{const result=await (await fresh('account-tasks')).listTasks((path:string)=>this.request(path),route('tasks'),args);this.store.receipt(result.coverage);return result;}
   case 'plugins.list':case 'connectors.list':case 'pins.list':return this.request(route(op.split('.')[0]));
   case 'models.options':return this.selectionInteract(args,async()=> (await this.selectionActions(args)).options());
   case 'models.list':return this.request(route('models'));
   case 'dictation.transcribe':return this.interact(async()=> (await this.voice()).transcribe(args.path||args.files?.[0]));
   case 'voice.start':case 'dictation.start':return (await this.voice()).start(op.split('.')[0] as any);
   case 'voice.stop':case 'dictation.stop':return (await this.voice()).stop(op.split('.')[0] as any);
   case 'voice.controls':case 'dictation.controls':return (await this.voice()).controls();
   case 'voices.list':return this.request(route('voices'));
   case 'audio.output.capture':return (await fresh('audio-capture')).captureAudio(this.browser,args,emit);
   case 'audio.output.arm':case 'audio.output.read':case 'audio.output.status':case 'audio.output.stop':return this.browser.call(op,args);
   case 'audio.input':return this.browser.call(op,{path:args.path||args.files?.[0]});
   case 'audio.outputs':case 'audio.play':case 'audio.status':case 'audio.clear':return this.browser.call(op);
   case 'browser.open':case 'conversations.open':return this.navigate(args);
   case 'browser.mode':if(this.busy)throw new Error('Finish or stop generation before switching browser mode.');{const result=await this.browser.call('mode',{headless:args.mode==='headless'},120000);if(result.transportMode){this.account={...this.account,transportMode:result.transportMode,headless:result.headless};this.browser.account=this.account;saveAccount(this.account);}return result;}
   case 'flow.run':return (await fresh('flows')).runFlow(this.browser,this.account,args,emit);
   case 'flow.validate':{const flows=await fresh('flows');const plan=flows.readFlow(args.path);flows.validateFlow(plan);return {valid:true,id:plan.id,version:plan.version,steps:plan.steps.length,executed:false};}
   case 'flow.status':return (await fresh('flows')).flowStatus(this.account,args.runId||args.id);
   case 'map.scan':{const snapshot=await this.browser.call('snapshot',args),network=await this.browser.call('network'),file=join(accountDir(this.account),'surface-map.json'),previous=readJSON<any>(file,{surfaces:{}});const key=new URL(snapshot.url).pathname;const controls=snapshot.controls.map((c:any)=>({name:c.name,role:c.role,id:c.id,testId:c.testId,context:c.context,disabled:c.disabled,checked:c.checked,value:c.value}));const old=previous.surfaces[key]?.controls||[];const signatures=new Set(old.map((c:any)=>JSON.stringify([c.name,c.role,c.testId])));const added=controls.filter((c:any)=>!signatures.has(JSON.stringify([c.name,c.role,c.testId])));previous.surfaces[key]={at:new Date().toISOString(),controls};atomicJSON(file,previous);const result={surface:key,controls,added,observedRoutes:[...new Set(network.map((n:any)=>new URL(n.url).pathname))],complete:false};if(added.length)recordEvent(this.account,{type:'capability.discovered',surface:key,count:added.length});return result;}
   case 'thinking.expand':return this.browser.call(op,args);
   case 'ui.snapshot':return this.browser.call('snapshot',args);
   case 'surface.open':case 'surface.close':case 'surface.activate':return this.browser.call(op,args);
   case 'ui.inspect':return this.browser.call('inspect',args);
   case 'ui.click':return this.browser.call('action',{...args,kind:'click'});
   case 'ui.focus':return this.browser.call('action',{...args,kind:'focus'});
   case 'ui.hover':return this.browser.call('action',{...args,kind:'hover'});
   case 'ui.fill':return this.browser.call('action',{...args,kind:'fill'});
   case 'ui.key':return this.browser.call('key',args);
   case 'ui.text':return this.browser.call('text',args);
   case 'ui.mouse':return this.browser.call('mouse',args);
   case 'ui.scroll':return this.browser.call('scroll',args);
   case 'ui.upload':return this.browser.call('upload',args);
   case 'ui.viewport':return this.browser.call('viewport',args);
   case 'ui.screenshot':{const r=await this.browser.call('screenshot',args);if(!args.output)return r;writeFileSync(args.output,Buffer.from(r.base64,'base64'),{mode:0o600});return {path:args.output};}
   case 'map.response':return this.browser.call('response',args);
   case 'map.request':return this.browser.call('request.info',args);
   case 'map.network':return this.browser.call('network');
   case 'api.request':{const method=String(args.method||'GET').toUpperCase();
    if(method!=='GET'&&args.allowWrite!==true)throw Object.assign(new Error(`api.request refuses ${method} ${String(args.path||'').split('?')[0]} without --allow-write: a raw website write can change or destroy account data and is often invisible afterwards.`),{code:'WRITE_NOT_ALLOWED',retryable:false,action:'Reads need no flag. For a write, confirm the exact method and path with the account owner, then repeat the command with --allow-write.'});
    return this.request(args.path,method,args.body,args.binary);}
   default:throw new Error('Unknown operation: '+op);
  }
 }
}
