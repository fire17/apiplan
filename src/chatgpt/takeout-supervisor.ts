import {appendFileSync,chmodSync,closeSync,existsSync,lstatSync,openSync,readFileSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {atomicJSON,privateDir,readJSON} from './accounts.ts';
import {processLiveness,type ProcessLiveness} from './autostart.ts';
import {FREEZE_CODE} from './freeze.ts';

type Coverage={required?:boolean;status?:string};
export type FreezeFlag={frozen:boolean;at?:string;by?:string;reason?:string};
export type TakeoutSnapshotOptions={now?:number;staleAfterMs?:number;isPidAlive?:(pid:number)=>boolean;pidLiveness?:(pid:number)=>ProcessLiveness;freeze?:()=>FreezeFlag;accountRoot?:string};
export type TakeoutRecoverySnapshot={
 at:string;state:'complete'|'frozen'|'explicitly-paused'|'active'|'rate-limited'|'stalled-active'|'uncertain-lock'|'stale-lock'|'ready-to-resume'|'missing';
 complete:boolean;explicitlyPaused:boolean;writer:{present:boolean;pid?:number;pidAlive?:boolean;pidLiveness?:ProcessLiveness;activeOperation:boolean;operationEnded:boolean;stalled:boolean;stale:boolean};
 progress:{files:number;coverage:number;requiredIncomplete:number;conversations:{complete:number;partial:number;total:number};gaps:Record<string,number>};
 checkpoint:{started?:string;updated?:string;ageMs?:number};rateLimit?:{retryAt:string;failures:number;scope?:string};freeze?:FreezeFlag;nextAction:string;
};
export type TakeoutWatchStatus=TakeoutRecoverySnapshot&{
 source:'local durable recovery state';output:string;enabled:boolean;running:boolean;
 supervisor:{present:boolean;pid?:number;pidAlive?:boolean;pidLiveness?:ProcessLiveness};
};

const safeError=(error:unknown)=>String((error as any)?.code||'OPERATION_FAILED').replace(/[^A-Z0-9_]/g,'').slice(0,80)||'OPERATION_FAILED';
/**
 * Liveness has three answers, never two. `kill(pid,0)` reports ESRCH for a process that is gone and
 * EPERM for a process this user may not signal — sandboxes and cross-user PIDs answer EPERM for
 * everything, live or dead. Reading EPERM as "alive" made a killed writer look alive forever and the
 * archive could never resume; reading it as "dead" would let a supervisor clear a live writer's lock.
 * `processLiveness` (src/chatgpt/autostart.ts) is the single source of truth for that mapping.
 */
function livenessProbe(options:{isPidAlive?:(pid:number)=>boolean;pidLiveness?:(pid:number)=>ProcessLiveness}):(pid:number)=>ProcessLiveness{
 if(options.pidLiveness)return options.pidLiveness;
 if(options.isPidAlive)return pid=>options.isPidAlive!(pid)?'alive':'dead';
 return pid=>processLiveness(pid);
}
/** Same rule as freeze.ts readFreeze: only an explicit `frozen:true` flag counts. Read-only, path-based, no account object needed. */
function readFreezeFlag(accountRoot:string):FreezeFlag{const state=readJSON<any>(join(accountRoot,'freeze.json'),{frozen:false});return {frozen:state?.frozen===true,...(state?.at?{at:state.at}:{}),...(state?.by?{by:state.by}:{}),...(state?.reason?{reason:state.reason}:{})};}
function readEventFile(path:string){try{return readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return [];}}
function readEvents(path:string){return [...readEventFile(path+'.1'),...readEventFile(path)].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));}
function takeoutOperation(events:any[],notBefore:number){const starts=events.filter(event=>event.type==='operation.start'&&event.operation==='takeout.run'&&Date.parse(event.time)>=notBefore-5000).sort((a,b)=>Date.parse(b.time)-Date.parse(a.time));const start=starts[0],terminal=start&&events.find(event=>event.id===start.id&&(event.type==='operation.complete'||event.type==='operation.error'));return {start,terminal};}
function gapSummary(coverage:Record<string,Coverage>){const gaps:Record<string,number>={};for(const [name,value] of Object.entries(coverage))if(value.required===true&&value.status!=='complete'){const prefix=name.startsWith('conversation:')?'conversation':name;gaps[prefix]=(gaps[prefix]||0)+1;}return gaps;}

/** Inspect local receipts only. A live daemon PID is insufficient evidence by itself because archive locks contain the daemon PID. */
export function inspectTakeoutRecovery(output:string,options:TakeoutSnapshotOptions={}):TakeoutRecoverySnapshot{
 const root=resolve(output),now=options.now??Date.now(),staleAfterMs=options.staleAfterMs??20*60_000,liveness=livenessProbe(options);
 const manifestPath=join(root,'manifest.json'),pausePath=join(root,'.supervisor.paused'),lockPath=join(root,'.writer.lock'),accountRoot=resolve(options.accountRoot||dirname(root));
 const freeze=options.freeze?options.freeze():readFreezeFlag(accountRoot);
 const manifest=readJSON<any>(manifestPath,undefined),coverage:Record<string,Coverage>=manifest?.coverage||{},files=manifest?.files?Object.keys(manifest.files).length:0;
 const entries=Object.entries(coverage),conversation=entries.filter(([name])=>name.startsWith('conversation:')),conversationComplete=conversation.filter(([,v])=>v.status==='complete').length,conversationPartial=conversation.filter(([,v])=>v.status!=='complete').length;
 let pid:number|undefined,lockMtime=0,writerLiveness:ProcessLiveness='unknown';if(existsSync(lockPath)){if(lstatSync(lockPath).isSymbolicLink())throw new Error('Unsafe takeout writer lock.');pid=Number(readFileSync(lockPath,'utf8'));lockMtime=statSync(lockPath).mtimeMs;writerLiveness=Number.isSafeInteger(pid)&&pid>0?liveness(pid):'unknown';}
 const pidAlive=writerLiveness==='alive';
 const operation=takeoutOperation(readEvents(join(accountRoot,'events.jsonl')),lockMtime),activeOperation=!!operation.start&&!operation.terminal&&pidAlive,operationEnded=!!operation.start&&!!operation.terminal;
 const manifestMtime=manifestPath&&existsSync(manifestPath)?statSync(manifestPath).mtimeMs:0,lastProgress=Math.max(manifestMtime,operation.start?Date.parse(operation.start.time):0,lockMtime),ageMs=lastProgress?Math.max(0,now-lastProgress):undefined;
 const request=readJSON<any>(join(accountRoot,'request-state.json'),{}),retryMs=Number(request.rateLimitedUntil)||0,rateLimit=retryMs>now?{retryAt:new Date(retryMs).toISOString(),failures:Number(request.rateFailures)||0,...(request.limitedScope?{scope:String(request.limitedScope)}:{})}:undefined;
 const explicitlyPaused=existsSync(pausePath),lockPresent=existsSync(lockPath),stalled=lockPresent&&!rateLimit&&ageMs!==undefined&&ageMs>=staleAfterMs;
 // Cleanup needs positive evidence: a provably dead owner, or a terminal receipt for that owner's run.
 // An owner whose liveness is UNKNOWN never licences clearing the lock.
 const stale=lockPresent&&(writerLiveness==='dead'||operationEnded);
 let state:TakeoutRecoverySnapshot['state'],nextAction:string;
 if(manifest?.complete===true){state='complete';nextAction='No action required.';}
 else if(freeze.frozen){state='frozen';nextAction='Account traffic is frozen; no archive request is attempted, no failure is recorded and no backoff escalates. Thaw the account (chatgpt thaw) before resuming.';}
 else if(explicitlyPaused){state='explicitly-paused';nextAction='Remove the explicit pause before resuming.';}
 else if(stale){state='stale-lock';nextAction='Revalidate and clear the stale writer lock, then submit one resume.';}
 else if(stalled&&activeOperation){state='stalled-active';nextAction='Report the stalled active operation; do not create a competing writer.';}
 else if(activeOperation&&rateLimit){state='rate-limited';nextAction='Wait until retryAt; the active writer owns the next attempt.';}
 else if(activeOperation){state='active';nextAction='Wait for checkpoint progress or operation completion.';}
 else if(lockPresent){state='uncertain-lock';nextAction=writerLiveness==='unknown'?'The writer PID cannot be probed (EPERM, a foreign user or a sandbox), so the owner is neither alive nor proven dead; inspect it by hand and never clear the lock on this evidence.':stalled?'Writer evidence is incomplete and checkpoint progress is stalled; inspect the daemon without creating a competing writer.':'Wait for conclusive writer evidence; do not create a competing writer.';}
 else if(manifest){state='ready-to-resume';nextAction=rateLimit?'Wait until retryAt, then submit one resume.':'Submit one resume.';}
 else{state='missing';nextAction=rateLimit?'Wait until retryAt, then start one archive run.':'Start one archive run.';}
 return {at:new Date(now).toISOString(),state,complete:manifest?.complete===true,explicitlyPaused,writer:{present:lockPresent,...(pid?{pid}:{}),...(lockPresent?{pidAlive,pidLiveness:writerLiveness}:{}),activeOperation,operationEnded,stalled,stale},progress:{files,coverage:entries.length,requiredIncomplete:entries.filter(([,v])=>v.required===true&&v.status!=='complete').length,conversations:{complete:conversationComplete,partial:conversationPartial,total:conversation.length},gaps:gapSummary(coverage)},checkpoint:{started:manifest?.started,updated:manifest?.updated,...(ageMs!==undefined?{ageMs}:{})},...(rateLimit?{rateLimit}:{}),...(freeze.frozen?{freeze}:{}),nextAction};
}

/** Read watcher configuration, lock liveness and archive progress synchronously from disk. This never contacts the daemon or starts recovery work. */
export function readTakeoutWatchStatus(accountRoot:string,output?:string,options:Omit<TakeoutSnapshotOptions,'accountRoot'>={}):TakeoutWatchStatus{
 const account=resolve(accountRoot),config=readJSON<any>(join(account,'takeout-supervisor.json'),{}),configuredOutput=resolve(config.output||join(account,'takeout')),root=resolve(output||configuredOutput);
 const lockPath=join(root,'.supervisor.lock'),liveness=livenessProbe(options);let pid:number|undefined,supervisorLiveness:ProcessLiveness='unknown';
 if(existsSync(lockPath)){if(lstatSync(lockPath).isSymbolicLink())throw new Error('Unsafe takeout supervisor lock.');pid=Number(readFileSync(lockPath,'utf8'));supervisorLiveness=Number.isSafeInteger(pid)&&pid>0?liveness(pid):'unknown';}
 const pidAlive=supervisorLiveness==='alive';
 const snapshot=inspectTakeoutRecovery(root,{...options,pidLiveness:liveness,accountRoot:account}),enabled=config.enabled===true&&configuredOutput===root;
 return {...snapshot,source:'local durable recovery state',output:root,enabled,running:enabled&&pidAlive&&!snapshot.explicitlyPaused&&!snapshot.complete&&snapshot.state!=='frozen',supervisor:{present:existsSync(lockPath),...(pid?{pid}:{}),...(existsSync(lockPath)?{pidAlive,pidLiveness:supervisorLiveness}:{})}};
}

function signature(snapshot:TakeoutRecoverySnapshot){const {at,checkpoint,...stable}=snapshot;const {ageMs,...stableCheckpoint}=checkpoint;return JSON.stringify({...stable,checkpoint:stableCheckpoint});}
function writeProgress(root:string,snapshot:TakeoutRecoverySnapshot,event?:any){privateDir(root);atomicJSON(join(root,'recovery-status.json'),snapshot);if(event)appendFileSync(join(root,'recovery-events.jsonl'),JSON.stringify({at:snapshot.at,...event})+'\n',{mode:0o600});}
export function setTakeoutSupervisorPaused(output:string,paused:boolean){const root=resolve(output),path=join(root,'.supervisor.paused');privateDir(root);if(paused){writeFileSync(path,new Date().toISOString()+'\n',{mode:0o600});chmodSync(path,0o600);}else if(existsSync(path))unlinkSync(path);return {paused,path};}

function clearStaleWriter(root:string,before:TakeoutRecoverySnapshot,options:TakeoutSnapshotOptions){const path=join(root,'.writer.lock');const after=inspectTakeoutRecovery(root,options);if(before.state!=='stale-lock'||after.state!=='stale-lock'||before.writer.pid!==after.writer.pid)throw new Error('Takeout writer lock changed during stale-lock validation.');if(existsSync(path))unlinkSync(path);}

export class TakeoutSupervisor{
 private last='';private lastResume='';private resumeInFlight=false;
 constructor(private options:{output:string;accountRoot?:string;launch:()=>Promise<unknown>;emit?:(event:any)=>void;intervalMs?:number;staleAfterMs?:number;signal?:AbortSignal;now?:()=>number;sleep?:(ms:number)=>Promise<void>;isPidAlive?:(pid:number)=>boolean;pidLiveness?:(pid:number)=>ProcessLiveness;freeze?:()=>FreezeFlag}){}
 private publish(snapshot:TakeoutRecoverySnapshot,event?:any){const current=signature(snapshot);if(current===this.last&&!event)return;this.last=current;const message=event||{type:'takeout.supervisor.changed',state:snapshot.state,files:snapshot.progress.files,requiredIncomplete:snapshot.progress.requiredIncomplete};writeProgress(resolve(this.options.output),snapshot,message);this.options.emit?.({...message,snapshot});}
 async tick(){const now=this.options.now?.()??Date.now(),snapshotOptions={now,staleAfterMs:this.options.staleAfterMs,isPidAlive:this.options.isPidAlive,pidLiveness:this.options.pidLiveness,freeze:this.options.freeze,accountRoot:this.options.accountRoot};let snapshot=inspectTakeoutRecovery(this.options.output,snapshotOptions);this.publish(snapshot);
  // Frozen: no launch, no lock mutation, no failure and no backoff. Forget the last resume key so the
  // same checkpoint may resume exactly once after a thaw.
  if(snapshot.state==='frozen'){this.lastResume='';return snapshot;}
  if(snapshot.complete||snapshot.explicitlyPaused||snapshot.writer.activeOperation||snapshot.state==='uncertain-lock'||snapshot.state==='stalled-active'||this.resumeInFlight)return snapshot;
  if(snapshot.state==='stale-lock'){clearStaleWriter(resolve(this.options.output),snapshot,snapshotOptions);snapshot=inspectTakeoutRecovery(this.options.output,snapshotOptions);this.publish(snapshot,{type:'takeout.supervisor.stale-lock-cleared'});}
  if(snapshot.rateLimit&&Date.parse(snapshot.rateLimit.retryAt)>now)return snapshot;
  const resumeKey=signature(snapshot);if(resumeKey===this.lastResume)return snapshot;this.lastResume=resumeKey;
  this.resumeInFlight=true;this.publish(snapshot,{type:'takeout.supervisor.resume'});try{await this.options.launch();}catch(error){const code=safeError(error),next=inspectTakeoutRecovery(this.options.output,{...snapshotOptions,now:this.options.now?.()??Date.now()});
   // A freeze refusal is not a failed resume: nothing was sent, so nothing is counted and the same
   // checkpoint stays eligible for one resume after the thaw.
   if(code===FREEZE_CODE){this.lastResume='';this.publish(next,{type:'takeout.supervisor.frozen',code});}else this.publish(next,{type:'takeout.supervisor.resume-error',code});}finally{this.resumeInFlight=false;}
  snapshot=inspectTakeoutRecovery(this.options.output,{...snapshotOptions,now:this.options.now?.()??Date.now()});this.publish(snapshot);return snapshot;
 }
 async run(){const root=resolve(this.options.output),lock=join(root,'.supervisor.lock');privateDir(root);if(existsSync(lock)){const pid=Number(readFileSync(lock,'utf8')),state=Number.isSafeInteger(pid)&&pid>0?livenessProbe(this.options)(pid):'unknown';
  if(state==='alive')throw new Error('Takeout recovery supervisor is already running.');
  if(state!=='dead')throw new Error('A takeout recovery supervisor lock exists whose owner cannot be probed; verify it by hand instead of starting a competing supervisor.');
  unlinkSync(lock);}const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);try{for(;;){const snapshot=await this.tick();if(snapshot.complete||snapshot.explicitlyPaused||this.options.signal?.aborted)return snapshot;await (this.options.sleep||((ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))))(Math.max(1000,this.options.intervalMs??30_000));}}finally{if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);}}
}
