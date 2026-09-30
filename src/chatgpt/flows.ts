import {readFileSync,statSync,existsSync,openSync,closeSync,unlinkSync,writeFileSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {accountDir,atomicJSON,privateDir,validId,type Account} from './accounts.ts';

type Target={name?:string;role?:string;id?:string;testId?:string;messageId?:string;checked?:boolean|string;value?:string};
type Expect={url?:string;textIncludes?:string;control?:Target;absent?:Target};
export type FlowStep={id:string;op:'snapshot'|'click'|'fill'|'key'|'scroll'|'upload'|'goto'|'wait';args?:Record<string,any>;expect?:Expect};
export type Flow={id:string;version:string|number;steps:FlowStep[]};
type Browser={call:(op:string,args?:any)=>Promise<any>};
type Entry={id:string;op:string;fingerprint:string;status:'started'|'complete'|'unknown'|'failed';at:string;completedAt?:string;proof?:'postcondition';errorCode?:string};
type Journal={schemaVersion:1;runId:string;flowId:string;account:string;userId?:string;pathHash:string;status:string;steps:Entry[];startedAt:string;updatedAt:string};
const flowId=(id:any)=>{if(typeof id!=='string')throw error('INVALID_FLOW','Identifier must be a string.');return validId(id);};
const now=()=>new Date().toISOString();
const error=(code:string,message:string,extra:any={})=>Object.assign(new Error(message),{code,...extra});
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const writeOps=new Set(['click','fill','key','scroll','upload','goto']);
const keys=(v:any,allowed:string[],where:string)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw error('INVALID_FLOW','Invalid fields in '+where);};
function safePath(path:any,absolute=false){if(typeof path!=='string'||!path||path.includes('\0')||path.split(/[\\/]/).includes('..')||(absolute&&!isAbsolute(path)))throw error('INVALID_FLOW','Expected a safe '+(absolute?'absolute ':'')+'file path without parent traversal.');return resolve(path);}
function target(t:any){keys(t,['name','role','id','testId','messageId','checked','value'],'target');if(!Object.keys(t).length)throw error('INVALID_FLOW','Target must have an exact semantic constraint.');for(const [k,v] of Object.entries(t))if(typeof v!=='string'&&!(k==='checked'&&typeof v==='boolean'))throw error('INVALID_FLOW','Target fields must be strings, or boolean checked.');}
function expectation(e:any){keys(e,['url','textIncludes','control','absent'],'expect');if(!Object.keys(e).length)throw error('INVALID_FLOW','Postcondition must contain an assertion.');for(const k of ['url','textIncludes'])if(k in e&&(typeof e[k]!=='string'||!e[k]))throw error('INVALID_FLOW','Assertion must be a nonempty string.');if(e.control)target(e.control);if(e.absent)target(e.absent);}
export function validateFlow(value:unknown):Flow{
 keys(value,['id','version','steps'],'flow');const f=value as Flow;flowId(f.id);if((typeof f.version!=='string'&&typeof f.version!=='number')||!String(f.version)||String(f.version).length>200)throw error('INVALID_FLOW','Flow requires a version.');if(!Array.isArray(f.steps)||!f.steps.length||f.steps.length>200)throw error('INVALID_FLOW','Flow needs 1–200 steps.');const ids=new Set<string>();
 for(const s of f.steps){keys(s,['id','op','args','expect'],'step');flowId(s.id);if(ids.has(s.id))throw error('INVALID_FLOW','Duplicate step id.');ids.add(s.id);if(!['snapshot','click','fill','key','scroll','upload','goto','wait'].includes(s.op))throw error('INVALID_FLOW','Unsupported operation.');if(s.args===null)throw error('INVALID_FLOW','Step args must be an object.');const a=s.args||{};keys(a,['surface','target','selector','text','key','modifiers','x','y','dx','dy','files','url','ms','timeoutMs'],'args');
  if(a.surface!==undefined)flowId(a.surface);if(a.timeoutMs!==undefined&&(!Number.isInteger(a.timeoutMs)||a.timeoutMs<1||a.timeoutMs>60000))throw error('INVALID_FLOW','timeoutMs must be 1–60000.');
  const permitted:Record<string,string[]>={snapshot:[],click:['target','selector'],fill:['target','selector','text'],key:['key','modifiers'],scroll:['x','y','dx','dy'],upload:['files','selector'],goto:['url'],wait:['ms']};if(Object.keys(a).some(k=>!['surface','timeoutMs',...permitted[s.op]].includes(k)))throw error('INVALID_FLOW','Arguments do not match the operation.');
  if(['click','fill'].includes(s.op)){if(Boolean(a.target)===Boolean(a.selector))throw error('INVALID_FLOW','Click/fill requires exactly one semantic target or CSS selector.');if(a.target)target(a.target);}
  if(a.selector!==undefined&&(typeof a.selector!=='string'||!a.selector.trim()||a.selector.length>2000))throw error('INVALID_FLOW','Invalid CSS selector.');if(s.op==='fill'&&typeof a.text!=='string')throw error('INVALID_FLOW','Fill requires text.');if(s.op==='key'&&(typeof a.key!=='string'||!a.key||a.key.length>64))throw error('INVALID_FLOW','Key requires a bounded key name.');if(a.modifiers!==undefined&&(!Number.isInteger(a.modifiers)||a.modifiers<0||a.modifiers>15))throw error('INVALID_FLOW','Invalid key modifiers.');
  for(const n of ['x','y','dx','dy'])if(a[n]!==undefined&&(!Number.isFinite(a[n])||Math.abs(a[n])>100000))throw error('INVALID_FLOW','Invalid scroll coordinate.');if(s.op==='scroll'&&a.dx===undefined&&a.dy===undefined)throw error('INVALID_FLOW','Scroll requires dx or dy.');
  if(s.op==='upload'){if(!Array.isArray(a.files)||!a.files.length||a.files.length>20)throw error('INVALID_FLOW','Upload requires 1–20 files.');a.files.forEach((p:any)=>safePath(p,true));}
  if(s.op==='goto'){try{const u=new URL(a.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw 0;}catch{throw error('INVALID_FLOW','Goto requires an HTTP(S) URL without credentials.');}}
  if(s.op==='wait'&&(!Number.isInteger(a.ms)||a.ms<0||a.ms>60000))throw error('INVALID_FLOW','Wait requires ms between 0 and 60000.');if(s.expect)expectation(s.expect);
 }
 return f;
}
export function readFlow(path:string){const p=safePath(path);if(!p.endsWith('.json')||statSync(p).size>1024*1024)throw error('INVALID_FLOW','Flow must be a JSON file of at most 1 MiB.');let parsed:any;try{parsed=JSON.parse(readFileSync(p,'utf8'));}catch{throw error('INVALID_FLOW','Flow file is not valid JSON.');}return validateFlow(parsed);}
const matches=(c:any,t:Target)=>Object.entries(t).every(([k,v])=>k==='checked'?String(c[k])===String(v):c[k]===v);
export function checkPostcondition(snapshot:any,expect:Expect){return (!expect.url||snapshot.url===expect.url)&&(!expect.textIncludes||String(snapshot.text||'').includes(expect.textIncludes))&&(!expect.control||(snapshot.controls||[]).filter((c:any)=>matches(c,expect.control!)).length===1)&&(!expect.absent||!(snapshot.controls||[]).some((c:any)=>matches(c,expect.absent!)));}
const journalPath=(a:Account,id:string)=>join(accountDir(a),'flows',flowId(id)+'.json');
export function flowStatus(a:Account,runId:string){const path=journalPath(a,runId);if(!existsSync(path))throw error('FLOW_NOT_FOUND','Flow run was not found.');return JSON.parse(readFileSync(path,'utf8')) as Journal;}
async function bounded<T>(promise:Promise<T>,ms:number):Promise<T>{let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(error('STEP_TIMEOUT','Step exceeded its deadline; the remote outcome may be unknown.')),ms);})]);}finally{clearTimeout(timer!);}}
export async function runFlow(b:Browser,a:Account,options:{path:string;runId?:string;resume?:boolean;dryRun?:boolean},emit:(e:any)=>void=()=>{}){
 const path=safePath(options.path),initial=readFlow(path);for(const s of initial.steps)if(s.op==='goto'&&new URL(s.args!.url).origin!==new URL(a.baseURL).origin)throw error('INVALID_FLOW','Goto must stay on the selected account origin.');
 if(options.dryRun)return {dryRun:true,flowId:initial.id,version:initial.version,steps:initial.steps.map(s=>({id:s.id,op:s.op,mutation:writeOps.has(s.op),hasPostcondition:!!s.expect,fingerprint:hash(s)}))};
 if(options.resume&&!options.runId)throw error('INVALID_RUN','Resume requires an explicit run id.');const runId=flowId(options.runId||randomUUID()),file=journalPath(a,runId);privateDir(resolve(file,'..'));const lock=file+'.lock';let lockFd:number;try{lockFd=openSync(lock,'wx',0o600);}catch{
  // Serialize stale-owner recovery. Live or unreadable locks are never stolen.
  let recovery:number|undefined;const guard=lock+'.recovery';try{recovery=openSync(guard,'wx',0o600);const owner=JSON.parse(readFileSync(lock,'utf8'));if(!Number.isInteger(owner.pid)||owner.pid<1)throw 0;let dead=false;try{process.kill(owner.pid,0);}catch(e:any){dead=e.code==='ESRCH';}if(!dead)throw 0;unlinkSync(lock);lockFd=openSync(lock,'wx',0o600);}catch{throw error('RUN_BUSY','This run has a writer lock; inspect its owner before recovery.',{runId});}finally{if(recovery!==undefined){closeSync(recovery);unlinkSync(guard);}}
 }writeFileSync(lockFd!,JSON.stringify({pid:process.pid,startedAt:now()}));let j:Journal;
 try{
 if(existsSync(file)){if(!options.resume)throw error('RUN_EXISTS','Run id already exists; use resume to inspect or continue it.',{runId});j=flowStatus(a,runId);if(j.flowId!==initial.id||j.pathHash!==hash(path)||j.account!==a.id||j.userId!==a.userId)throw error('RUN_MISMATCH','Run identity or source path does not match.');}
 else{if(options.resume)throw error('FLOW_NOT_FOUND','Cannot resume an unknown run.');j={schemaVersion:1,runId,flowId:initial.id,account:a.id,userId:a.userId,pathHash:hash(path),status:'running',steps:[],startedAt:now(),updatedAt:now()};atomicJSON(file,j);}
 }catch(e){closeSync(lockFd!);unlinkSync(lock);throw e;}const save=()=>{j.updatedAt=now();atomicJSON(file,j);};const event=(type:string,s?:FlowStep)=>emit({type,runId,flowId:j.flowId,...(s?{stepId:s.id,operation:s.op}:{})});
 try{for(let boundary=0;boundary<=200;boundary++){
  const flow=readFlow(path);if(flow.id!==j.flowId)throw error('FLOW_CHANGED','Flow identity changed during the run.');
  // Completed and uncertain prefixes cannot be moved, removed, or rewritten by hot reload.
  for(let i=0;i<j.steps.length;i++){const old=j.steps[i],current=flow.steps[i];if(!current||current.id!==old.id||hash(current)!==old.fingerprint)throw error('FLOW_CHANGED','Previously attempted step changed. Start a new reviewed run instead.',{stepId:old.id});}
  const pending=j.steps.find(e=>e.status!=='complete');
  if(pending){const s=flow.steps.find(s=>s.id===pending.id)!;if(writeOps.has(s.op)){
    if(!s.expect)throw error('NEEDS_RECONCILIATION','Uncertain mutation has no explicit postcondition; it will not be replayed.',{runId,stepId:s.id});
    const snap=await bounded(b.call('snapshot',{surface:s.args?.surface}),s.args?.timeoutMs||15000);if(!checkPostcondition(snap,s.expect))throw error('NEEDS_RECONCILIATION','Postcondition does not prove the previous mutation completed; it will not be replayed.',{runId,stepId:s.id});pending.status='complete';pending.proof='postcondition';pending.completedAt=now();save();event('flow.reconciled',s);continue;
   }j.steps.pop();save();}
  const s=flow.steps[j.steps.length];if(!s){j.status='complete';save();event('flow.complete');return {runId,flowId:j.flowId,status:j.status,completed:j.steps.length,journal:file};}
  if(s.op==='goto'&&new URL(s.args!.url).origin!==new URL(a.baseURL).origin)throw error('INVALID_FLOW','Hotloaded goto must stay on account origin.');const args={...(s.args||{})},timeout=args.timeoutMs||15000;delete args.timeoutMs;
  // Resolve targets before journaling a possible mutation; no stale refs are accepted in JSON.
  let prepared:any=args;if(s.op==='click'||s.op==='fill'){const snap=await bounded(b.call('snapshot',{surface:args.surface}),timeout);if(args.target){const found=(snap.controls||[]).filter((c:any)=>matches(c,args.target));if(found.length!==1||found[0].disabled)throw error('TARGET_UNAVAILABLE','Semantic target must match one enabled control.',{stepId:s.id});prepared={surface:args.surface,ref:found[0].ref,epoch:snap.epoch,...(s.op==='fill'?{text:args.text}:{})};}else prepared={surface:args.surface,selector:args.selector,...(s.op==='fill'?{text:args.text}:{})};}
  const entry:Entry={id:s.id,op:s.op,fingerprint:hash(s),status:'started',at:now()};j.steps.push(entry);j.status='running';save();event('flow.step.started',s);
  try{if(s.op==='wait')await Bun.sleep(args.ms);else await bounded(b.call(s.op==='click'||s.op==='fill'?'action':s.op,s.op==='click'||s.op==='fill'?{...prepared,kind:s.op}:prepared),timeout);
   if(s.expect){const snap=await bounded(b.call('snapshot',{surface:args.surface}),timeout);if(!checkPostcondition(snap,s.expect))throw error('POSTCONDITION_FAILED','Step returned but its explicit postcondition was not observed.');}
   entry.status='complete';entry.completedAt=now();save();event('flow.step.complete',s);
  }catch(e:any){entry.status=writeOps.has(s.op)?'unknown':'failed';entry.errorCode=['STEP_TIMEOUT','POSTCONDITION_FAILED'].includes(e.code)?e.code:'BROWSER_OPERATION_FAILED';j.status=writeOps.has(s.op)?'needs_reconciliation':'failed';save();event('flow.step.'+entry.status,s);throw error(writeOps.has(s.op)?'NEEDS_RECONCILIATION':entry.errorCode,writeOps.has(s.op)?'Mutation outcome is uncertain. Resume requires postcondition proof; no write was replayed.':'Read step failed; resume may retry it.',{runId,stepId:s.id});}
 }throw error('FLOW_BOUND_EXCEEDED','Flow exceeded its step-boundary budget.');
 }catch(e:any){if(j.status!=='complete'){j.status=e.code==='NEEDS_RECONCILIATION'?'needs_reconciliation':'failed';save();}throw e;
 }finally{closeSync(lockFd!);unlinkSync(lock);}
}
