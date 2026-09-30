import {randomUUID,createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,chmodSync,openSync,closeSync,writeFileSync,readFileSync,renameSync,unlinkSync,fsyncSync,statSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {accountDir,type Account} from './accounts.ts';
import {mergeThinking} from './tui-thinking.ts';

export type QueuePhase='queued'|'submitting'|'submitted'|'responding'|'complete'|'not-submitted'|'unknown';
export type QueueDraft={text?:string;files?:string[];conversation?:string;new?:boolean;project?:string;gpt?:string;mode?:'Chat'|'Work';model?:string;effort?:string;timeout?:number};
export type QueueItem={clientId?:string;id:string;requestId:string;phase:QueuePhase;draft:QueueDraft;created:string;updated:string;attempts:Array<{requestId:string;phase:QueuePhase;started:string;finished?:string;error?:string}>;response?:string;thinking?:any[];media?:any[];result?:any;error?:{code:string;message:string};websiteConversation?:string};
type Document={schema:1;account:{id:string;userId?:string;workspace?:string};clientAdds?:Record<string,{id:string;sha256:string}>;ownerPid:number;paused:boolean;updated:string;items:QueueItem[]};
type Lock={pid:number;token:string;created:string};
export type QueueSender=(args:QueueDraft&{requestId:string},emit:(event:any)=>void)=>Promise<any>;
const active=new Set<QueuePhase>(['submitting','submitted','responding']);
const now=()=>new Date().toISOString();
const fault=(code:string,message:string)=>Object.assign(new Error(message),{code});
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));

/** Account-scoped local queue. Request IDs guard replay; this is not a native website queue. */
export class MessageQueue {
 readonly directory:string;
 private file:string;
 private mutationFile:string;
 private runnerFile:string;
 constructor(private account:Account,options:{directory?:string}={}){
  this.directory=resolve(options.directory||join(accountDir(account),'message-queue'));
  if(existsSync(this.directory)&&lstatSync(this.directory).isSymbolicLink())throw fault('QUEUE_UNSAFE_PATH','Queue directory must not be a symlink.');
  mkdirSync(this.directory,{recursive:true,mode:0o700});chmodSync(this.directory,0o700);
  this.file=join(this.directory,'queue.json');this.mutationFile=join(this.directory,'mutation.lock');this.runnerFile=join(this.directory,'runner.lock');
  this.mutate(state=>{
   const running=this.readLock(this.runnerFile);
   if(!running||!this.alive(running.pid)){
    if(state.ownerPid!==process.pid||state.items.some(item=>active.has(item.phase)))state.paused=true;
    for(const item of state.items)if(active.has(item.phase)){
     item.phase='unknown';item.updated=now();item.error={code:'QUEUE_INTERRUPTED',message:'The previous runner ended without a completion receipt. Reconcile this request before retrying.'};
     const attempt=item.attempts.at(-1);if(attempt){attempt.phase='unknown';attempt.finished=now();attempt.error=item.error.message;}
    }
    state.ownerPid=process.pid;
   }
  });
 }
 private safe(path:string){if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw fault('QUEUE_UNSAFE_PATH','Queue files must not be symlinks.');}
 private alive(pid:number){if(!Number.isInteger(pid)||pid<=0)throw fault('QUEUE_LOCK_UNKNOWN','Queue lock has no trustworthy process identity.');try{process.kill(pid,0);return true;}catch(error:any){if(error.code==='ESRCH')return false;return true;}}
 private readLock(path:string):Lock|undefined{
  this.safe(path);if(!existsSync(path))return;
  let lock:Lock;try{lock=JSON.parse(readFileSync(path,'utf8'));}catch(error:any){if(error.code==='ENOENT')return;throw fault('QUEUE_LOCK_UNKNOWN','Queue lock is unreadable; its ownership cannot be assumed stale.');}
  if(!lock.token||!Number.isInteger(lock.pid)||lock.pid<=0)throw fault('QUEUE_LOCK_UNKNOWN','Queue lock lacks a valid owner.');return lock;
 }
 private lock(path:string):Lock{
  this.safe(path);
  for(let attempt=0;attempt<2;attempt++){
   const lock={pid:process.pid,token:randomUUID(),created:now()};let fd:number;
   try{fd=openSync(path,'wx',0o600);}catch(error:any){
    if(error.code!=='EEXIST')throw error;
    const before=statSync(path),existing=this.readLock(path);
    if(!existing||this.alive(existing.pid))throw fault('QUEUE_BUSY','Another queue operation owns this lock.');
    const after=statSync(path),current=this.readLock(path);
    if(before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||current?.token!==existing.token||this.alive(existing.pid))throw fault('QUEUE_BUSY','Queue lock ownership changed during recovery.');
    unlinkSync(path);continue;
   }
   try{writeFileSync(fd,JSON.stringify(lock));fsyncSync(fd);}finally{closeSync(fd);}return lock;
  }
  throw fault('QUEUE_BUSY','Queue lock could not be acquired.');
 }
 private unlock(path:string,lock:Lock){const current=this.readLock(path);if(current?.token===lock.token&&current.pid===lock.pid)unlinkSync(path);}
 private read():Document{
  this.safe(this.file);
  if(!existsSync(this.file))return {schema:1,account:{id:this.account.id,userId:this.account.userId,workspace:this.account.workspace},ownerPid:process.pid,paused:true,updated:now(),items:[]};
  let state:Document;try{state=JSON.parse(readFileSync(this.file,'utf8'));}catch{throw fault('QUEUE_CORRUPT','Queue checkpoint is unreadable; no drafts were discarded.');}
  if(state.schema!==1||state.account?.id!==this.account.id||state.account?.userId!==this.account.userId||state.account?.workspace!==this.account.workspace)throw fault('ACCOUNT_MISMATCH','Queue belongs to another account, website user or workspace.');
  if(state.clientAdds!==undefined&&(!state.clientAdds||Array.isArray(state.clientAdds)||typeof state.clientAdds!=='object'||Object.values(state.clientAdds).some(entry=>!entry||typeof entry.id!=='string'||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256))))throw fault('QUEUE_CORRUPT','Queue client request ledger has an invalid shape.');
  if(!Array.isArray(state.items)||typeof state.paused!=='boolean'||state.items.some(item=>!item||typeof item.id!=='string'||typeof item.requestId!=='string'||!['queued','submitting','submitted','responding','complete','not-submitted','unknown'].includes(item.phase)||!item.draft||!Array.isArray(item.attempts))||new Set(state.items.map(item=>item.id)).size!==state.items.length)throw fault('QUEUE_CORRUPT','Queue checkpoint has an invalid shape.');
  for(const item of state.items){try{this.draft(item.draft);}catch{throw fault('QUEUE_CORRUPT','A persisted queue draft has an invalid destination or payload. No message was sent; checkpoint retained.');}}return state;
 }
 private write(state:Document){
  this.safe(this.file);const bytes=JSON.stringify(state,null,2)+'\n';if(Buffer.byteLength(bytes)>32*1024*1024)throw fault('QUEUE_TOO_LARGE','Queue checkpoint exceeds 32 MiB; previous checkpoint retained.');
  const temp=this.file+'.'+randomUUID()+'.tmp';
  try{const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,this.file);chmodSync(this.file,0o600);}finally{if(existsSync(temp))unlinkSync(temp);}
 }
 private mutate<T>(change:(state:Document)=>T):T{
  const lock=this.lock(this.mutationFile);
  try{const state=this.read(),result=change(state);state.updated=now();this.write(state);return clone(result===undefined?null:result) as T;}
  finally{this.unlock(this.mutationFile,lock);}
 }
 private draft(value:QueueDraft):QueueDraft{
  if(!value||typeof value!=='object')throw fault('QUEUE_INVALID_DRAFT','Supply an explicit message draft.');
  if(value.text!==undefined&&typeof value.text!=='string')throw fault('QUEUE_INVALID_DRAFT','Message text must be a string.');
  if(value.files!==undefined&&(!Array.isArray(value.files)||value.files.some(path=>typeof path!=='string'||!path.trim())))throw fault('QUEUE_INVALID_DRAFT','Files must be explicit local paths.');
  const files=(value.files||[]).map(path=>resolve(path));
  if(!value.text?.trim()&&!files.length)throw fault('QUEUE_INVALID_DRAFT','Queue needs text or an attachment.');
  if((value.text?.length||0)>1024*1024||files.length>50)throw fault('QUEUE_INVALID_DRAFT','Draft exceeds the queue limit (1 MiB text or 50 files).');
  for(const key of ['conversation','project','gpt','model','effort'] as const)if(value[key]!==undefined&&(typeof value[key]!=='string'||!value[key]?.trim()))throw fault('QUEUE_INVALID_DRAFT',key+' must be a nonempty string.');
  if(!value.conversation&&value.new!==true)throw fault('QUEUE_CONTEXT_REQUIRED','Specify conversation or new:true; ambient browser context is not a durable queue target.');
  if(value.conversation&&(value.new||value.project||value.gpt)||value.project&&value.gpt)throw fault('QUEUE_INVALID_DRAFT','Choose one explicit conversation or a new project/GPT context.');
  if(value.mode!==undefined&&!['Chat','Work'].includes(value.mode))throw fault('QUEUE_INVALID_DRAFT','Mode must be Chat or Work.');
  if(value.timeout!==undefined&&(!Number.isFinite(value.timeout)||value.timeout<=0))throw fault('QUEUE_INVALID_DRAFT','Timeout must be positive.');
  return {text:value.text||'',files,...Object.fromEntries(['conversation','new','project','gpt','mode','model','effort','timeout'].filter(key=>(value as any)[key]!==undefined).map(key=>[key,(value as any)[key]]))};
 }
 private item(state:Document,id:string){const item=state.items.find(item=>item.id===id);if(!item)throw fault('QUEUE_ITEM_MISSING','Queued message does not exist.');return item;}
 status(){const state=this.read(),runner=this.readLock(this.runnerFile);return {...clone(state),source:'local durable message queue',running:!!runner&&this.alive(runner.pid)};}
 /** A persisted client key makes a lost add response safe to retry, even after edits/removal. */
 add(draft:QueueDraft,clientId?:string){
  const value=this.draft(draft);
  if(clientId!==undefined&&(typeof clientId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(clientId)))throw fault('QUEUE_INVALID_CLIENT_ID','clientId must be 1–200 letters, digits, colons, dots, underscores or hyphens.');
  const digest=createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return this.mutate(state=>{
   const known=clientId&&Object.hasOwn(state.clientAdds||{},clientId)?state.clientAdds![clientId]:undefined;
   if(known){
    if(known.sha256!==digest)throw fault('QUEUE_CLIENT_ID_MISMATCH','This clientId was already used for a different draft. Preserve the original draft or use a new clientId for new work.');
    const item=state.items.find(item=>item.id===known.id);
    if(!item)throw fault('QUEUE_ITEM_REMOVED','This clientId identifies an intentionally removed queue item. It will not be recreated.');
    return item;
   }
   if(state.items.length>=500)throw fault('QUEUE_FULL','Queue history has reached 500 items. Remove completed entries before adding more.');
   const item:QueueItem={...(clientId?{clientId}:{}),id:randomUUID(),requestId:randomUUID(),phase:'queued',draft:value,created:now(),updated:now(),attempts:[]};
   if(clientId){state.clientAdds??={};Object.defineProperty(state.clientAdds,clientId,{value:{id:item.id,sha256:digest},enumerable:true,writable:true,configurable:true});}
   state.items.push(item);return item;
  });
 }
 edit(id:string,draft:QueueDraft){return this.mutate(state=>{const item=this.item(state,id);if(!['queued','not-submitted'].includes(item.phase))throw fault('QUEUE_ITEM_LOCKED','Only unsent drafts can be edited.');const changed={...item.draft,...draft};if(draft.conversation!==undefined){delete changed.new;delete changed.project;delete changed.gpt;}else if(draft.new===true)delete changed.conversation;item.draft=this.draft(changed);item.requestId=randomUUID();item.phase='queued';item.updated=now();delete item.error;return item;});}
 remove(id:string){return this.mutate(state=>{const item=this.item(state,id);if(active.has(item.phase)||item.phase==='unknown')throw fault('QUEUE_ITEM_LOCKED','Active or uncertain attempts must be reconciled before removal.');state.items=state.items.filter(item=>item.id!==id);return {removed:id};});}
 reorder(id:string,index:number){return this.mutate(state=>{if(!Number.isInteger(index)||index<0||index>=state.items.length)throw fault('QUEUE_INVALID_ORDER','Supply an existing zero-based queue position.');const item=this.item(state,id);if(!['queued','not-submitted'].includes(item.phase))throw fault('QUEUE_ITEM_LOCKED','Only unsent drafts can be reordered.');state.items=state.items.filter(item=>item.id!==id);state.items.splice(index,0,item);return item;});}
 pause(){return this.mutate(state=>{state.paused=true;return {paused:true};});}
 resume(){return this.mutate(state=>{if(state.items.some(item=>item.phase==='unknown'))throw fault('NEEDS_RECONCILIATION','An uncertain attempt blocks queue resumption. Reconcile its request receipt first.');if(state.items.some(item=>item.phase==='not-submitted'))throw fault('QUEUE_RETRY_REQUIRED','A preparation failure retained its draft. Explicitly retry or edit that item before resuming.');state.paused=false;state.ownerPid=process.pid;return {paused:false};});}
 retry(id:string){return this.mutate(state=>{const item=this.item(state,id);if(item.phase!=='not-submitted')throw fault('NEEDS_RECONCILIATION','Only proven non-submissions may receive a new request ID.');item.phase='queued';item.requestId=randomUUID();item.updated=now();delete item.error;state.paused=true;return item;});}
 /** Accept only an account-bound, matching journal receipt as reconciliation evidence. */
 reconcile(id:string,evidence:{receipt:any;result?:any}){return this.mutate(state=>{const item=this.item(state,id),receipt=evidence?.receipt;if(!['unknown','not-submitted'].includes(item.phase))throw fault('QUEUE_ITEM_LOCKED','This item does not require reconciliation.');if(receipt?.id!==item.requestId||receipt.operation!=='chat.send'||receipt.account?.id!==this.account.id||receipt.account?.userId!==this.account.userId||receipt.account?.workspace!==this.account.workspace)throw fault('ACCOUNT_MISMATCH','Receipt does not match this queue attempt and account.');if(receipt.status==='complete'){item.phase='complete';item.result=evidence.result;delete item.error;}else if(receipt.status==='not-submitted'){item.phase='not-submitted';item.error={code:'NOT_SUBMITTED',message:'Journal confirms no submission was attempted.'};}else throw fault('NEEDS_RECONCILIATION','The receipt is still pending or unknown; no replay is permitted.');item.updated=now();state.paused=true;return item;});}
 async run(send:QueueSender,options:{emit?:(event:any)=>void;signal?:AbortSignal;maxItems?:number}={}){
  if(options.maxItems!==undefined&&(!Number.isInteger(options.maxItems)||options.maxItems<1||options.maxItems>500))throw fault('QUEUE_INVALID_LIMIT','maxItems must be 1–500.');
  const owner=this.lock(this.runnerFile);let completed=0;
  const notify=(event:any)=>{try{options.emit?.(event);}catch{/* Observer failure does not change a persisted submission outcome. */}};
  try{
   this.mutate(state=>{for(const item of state.items)if(active.has(item.phase)){item.phase='unknown';item.updated=now();item.error={code:'QUEUE_INTERRUPTED',message:'A previous runner has no completion receipt.'};state.paused=true;const attempt=item.attempts.at(-1);if(attempt){attempt.phase='unknown';attempt.finished=now();}}if(state.ownerPid!==process.pid)state.paused=true;state.ownerPid=process.pid;});
   for(;;){
    if(options.signal?.aborted){this.pause();break;}
    const job=this.mutate(state=>{if(state.paused)return null;if(state.items.some(item=>item.phase==='unknown'||item.phase==='not-submitted')){state.paused=true;return null;}const item=state.items.find(item=>item.phase==='queued');if(!item)return null;item.phase='submitting';item.updated=now();item.attempts.push({requestId:item.requestId,phase:'submitting',started:now()});return item;});
    if(!job)break;notify({type:'queue.submitting',id:job.id,requestId:job.requestId});let settled=false,notSubmitted=false;
    try{
     for(const file of job.draft.files||[])if(!isAbsolute(file)||!existsSync(file)||!statSync(file).isFile())throw fault('NOT_SUBMITTED','Queued attachment is no longer an available local file: '+file);
     const result=await send({...clone(job.draft),requestId:job.requestId},event=>{
      if(settled)return;if(event.type==='submission.failed'&&event.submissionState==='not-submitted')notSubmitted=true;
      if(event.type==='operation.receipt'&&event.requestId!==job.requestId)throw fault('QUEUE_REQUEST_MISMATCH','Sender returned a different request ID.');
      if(['submitted','text','replace','thinking','media'].includes(event.type))this.mutate(state=>{const item=this.item(state,job.id);if(item.requestId!==job.requestId||!active.has(item.phase))return;item.phase=event.type==='submitted'?'submitted':'responding';item.updated=now();if(event.type==='text')item.response=((item.response||'')+String(event.text||'')).slice(-1024*1024);if(event.type==='replace')item.response=String(event.text||'').slice(-1024*1024);if(event.type==='thinking')item.thinking=mergeThinking(item.thinking||[],event);if(event.type==='media')item.media=Array.isArray(event.items)?event.items:[];if(event.url)item.websiteConversation=String(event.url).match(/\/c\/([^/?]+)/)?.[1];const attempt=item.attempts.at(-1);if(attempt)attempt.phase=item.phase;});
      notify({type:'queue.event',id:job.id,requestId:job.requestId,event});
     });
     settled=true;if(result===undefined)throw fault('OUTCOME_UNKNOWN','Sender ended without a completion receipt.');
     this.mutate(state=>{const item=this.item(state,job.id);item.phase='complete';item.result=result;item.updated=now();if(result?.conversation)item.websiteConversation=result.conversation;const attempt=item.attempts.at(-1)!;attempt.phase='complete';attempt.finished=now();delete item.error;});completed++;notify({type:'queue.complete',id:job.id,requestId:job.requestId});
    }catch(error:any){
     settled=true;this.mutate(state=>{const item=this.item(state,job.id);const unsent=item.phase==='submitting'&&(notSubmitted||error?.code==='NOT_SUBMITTED'||error?.submissionState==='not-submitted');item.phase=unsent?'not-submitted':'unknown';item.error={code:unsent?'NOT_SUBMITTED':String(error?.code||'OUTCOME_UNKNOWN'),message:String(error?.message||error)};item.updated=now();state.paused=true;const attempt=item.attempts.at(-1)!;attempt.phase=item.phase;attempt.finished=now();attempt.error=item.error.message;});notify({type:'queue.paused',id:job.id,requestId:job.requestId,reason:this.status().items.find(item=>item.id===job.id)?.phase});break;
    }
    if(completed>=(options.maxItems??500))break;
   }
   return {...this.status(),running:false,completedThisRun:completed};
  }finally{this.unlock(this.runnerFile,owner);}
 }
}
