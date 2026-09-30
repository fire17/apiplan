import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync,chmodSync,lstatSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {accountDir,privateDir,atomicJSON,type Account} from './accounts.ts';
import {recordId} from './store.ts';
import {readExportedMedia} from './media.ts';
import {readFreeze,FREEZE_CODE} from './freeze.ts';
import {processLiveness} from './autostart.ts';

export type MediaReference={id:string;reference:string;conversationId:string;kind:string};
export interface TakeoutService {
 account:Account;
 identity?():Promise<any>;
 conversations(args:any):Promise<any>;
 conversation(id:string):Promise<any>;
 request(path:string,method?:string,body?:any,binary?:boolean):Promise<any>;
 dispatch?(op:string,args?:any):Promise<any>;
 downloadMedia?(reference:MediaReference):Promise<{bytes:Uint8Array;contentType?:string;extension?:string}>;
}
type Entry={path:string;sha256:string;bytes:number;kind:string;id:string;contentType?:string};
type Scope={status:'complete'|'partial'|'inaccessible'|'unsupported';required:boolean;count?:number;reason?:string};
type Manifest={version:1;account:{id:string;userId?:string;workspace?:string};started:string;updated:string;complete:boolean;files:Record<string,Entry>;coverage:Record<string,Scope>};
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const key=(id:string)=>hash(id).slice(0,40);
function safePath(root:string,path:string){const full=resolve(root,path),r=relative(root,full);if(!r||r.startsWith('..')||isAbsolute(r))throw new Error('Unsafe archive path');let p=full;while(p!==root){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw new Error('Archive contains symbolic link');p=resolve(p,'..');}return full;}
function intact(root:string,e:Entry){try{const b=readFileSync(safePath(root,e.path));return b.length===e.bytes&&hash(b)===e.sha256;}catch{return false;}}
function classification(e:unknown):Scope['status']{const s=String((e as any)?.message||e);return /\b(401|403|404)\b/.test(s)?'inaccessible':/Unknown operation|unsupported|not implemented/i.test(s)?'unsupported':'partial';}
/** Errors deliberately omit remote bodies, URLs and credentials. */
function failure(e:unknown){return {status:classification(e),reason:classification(e)==='inaccessible'?'Server denied or does not expose this resource.':classification(e)==='unsupported'?'No supported adapter is available.':'Read failed; resume to retry.'};}
/** A deliberate account freeze refuses the call before anything is sent: it is a deferral, never a read failure. */
const isFrozenError=(e:unknown)=>(e as any)?.code===FREEZE_CODE;
const DEFERRED_REASON='Deferred while the account is frozen; no request was sent and no failure was recorded.';
const PENDING_REASON='Pending conversation detail read; no attempt recorded yet.';
function scope(e:unknown){return isFrozenError(e)?{status:'partial' as const,reason:DEFERRED_REASON}:failure(e);}
/** Read at most this many conversation details per run unless the caller asks for a bigger slice or 'all'. */
export const DEFAULT_CONVERSATION_READS=25;
export function conversationBudget(value:unknown){
 if(value===undefined||value===null||value==='')return DEFAULT_CONVERSATION_READS;
 if(value===Infinity||value==='all'||value==='unbounded')return Infinity;
 const n=typeof value==='number'?value:Number(String(value).trim());
 if(!Number.isInteger(n)||n<0)throw new Error("maxConversations must be a whole number of conversation reads (0 or more), or 'all' for an explicitly unbounded run.");
 return n;
}
/** The account freeze is durable local state; a test service may supply its own reader. */
function freezeState(service:TakeoutService):{frozen:boolean;reason?:string}{
 const custom=(service as any).freeze;
 if(typeof custom==='function')return custom.call(service)||{frozen:false};
 try{return readFreeze(service.account);}catch{return {frozen:false};}
}
async function retry<T>(fn:()=>Promise<T>,max:number,onWait:(event:any)=>void=()=>{}){for(let n=0;;n++){try{return await fn();}catch(e){if(n>=max||classification(e)!=='partial'||isFrozenError(e))throw e;const rateLimited=(e as any)?.status===429||/\b429\b|rate.limit/i.test(String((e as any)?.message||e));const hint=Number((e as any)?.retryAfterMs);const delay=rateLimited?(Number.isFinite(hint)&&hint>0?hint:60000):Math.min(2000,100*2**n);let remaining=delay;if(rateLimited)onWait({type:'takeout.wait',reason:'rate-limit',waitMs:remaining,attempt:n+1});while(remaining>0){const chunk=Math.min(30000,remaining);await new Promise(r=>setTimeout(r,chunk));remaining-=chunk;if(rateLimited&&remaining>0)onWait({type:'takeout.wait',reason:'rate-limit',waitMs:remaining,attempt:n+1});}}}}
export function mediaReferences(raw:any,conversationId:string):MediaReference[]{
 const refs=new Map<string,MediaReference>();
 function visit(v:any,k=''){if(typeof v==='string'){
  // Only explicit asset pointers and attachment identifiers, never every link in prose.
  if(/^(?:file-service:\/\/|sediment:\/\/)/.test(v)||(/^(?:asset_pointer|audio_url|image_url|download_url|file_id)$/.test(k)&&v))refs.set(v,{id:key(v),reference:v,conversationId,kind:k||'asset'});
 }else if(Array.isArray(v))v.forEach(x=>visit(x,k));else if(v&&typeof v==='object'){for(const [a,b] of Object.entries(v)){if(a==='attachments'&&Array.isArray(b))for(const attachment of b){if(attachment?.id)visit(attachment.id,'file_id');}visit(b,a);}}}
 visit(raw);return [...refs.values()];
}
/** Checks every manifest hash. A successful audit means local integrity, not remote completeness. */
export function auditTakeout(output:string){const root=resolve(output);const m=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')) as Manifest;const damaged=Object.values(m.files).filter(e=>!intact(root,e)).map(e=>({path:e.path,kind:e.kind,id:e.id}));return {path:root,integrity:damaged.length===0,complete:m.complete&&damaged.length===0,files:Object.keys(m.files).length,damaged,coverage:m.coverage};}
async function executeTakeout(service:TakeoutService,args:{output?:string;mediaExport?:string;resume?:boolean;maxRetries?:number;pageSize?:number;maxPages?:number;maxConversations?:number|string}={},emit:(event:any)=>void=()=>{}){
 const root=resolve(args.output||join(accountDir(service.account),'takeout'));
 if(existsSync(root)&&lstatSync(root).isSymbolicLink())throw new Error('Archive root cannot be a symbolic link');
 privateDir(root);const manifestPath=join(root,'manifest.json');
 let m:Manifest={version:1,account:{id:service.account.id,userId:service.account.userId,workspace:service.account.workspace},started:new Date().toISOString(),updated:new Date().toISOString(),complete:false,files:{},coverage:{}};
 if(existsSync(manifestPath)){
  if(args.resume===false)throw new Error('Archive already exists; choose a new output directory or resume.');
  m=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(m.version!==1||m.account.id!==service.account.id||m.account.userId!==service.account.userId||m.account.workspace!==service.account.workspace)throw new Error('Archive account identity does not match selected account.');
 }
 const max=Math.max(0,Math.min(2,args.maxRetries??2));
 const save=()=>{m.updated=new Date().toISOString();m.complete=false;atomicJSON(manifestPath,m);};
 const write=(name:string,path:string,value:any,kind:string,id:string,binary=false)=>{const bytes=binary?Buffer.from(value):Buffer.from(JSON.stringify(value,null,2)+'\n');const dest=safePath(root,path);privateDir(resolve(dest,'..'));const tmp=dest+'.tmp';if(existsSync(tmp)&&lstatSync(tmp).isSymbolicLink())throw new Error('Unsafe temporary archive path');writeFileSync(tmp,bytes,{mode:0o600});chmodSync(tmp,0o600);renameSync(tmp,dest);m.files[name]={path,sha256:hash(bytes),bytes:bytes.length,kind,id};save();};
 const cached=(name:string)=>{const e=m.files[name];if(!e||m.coverage[name]&&m.coverage[name].status!=='complete'||!intact(root,e))return undefined;return JSON.parse(readFileSync(safePath(root,e.path),'utf8'));};
 const capture=async(name:string,path:string,fn:()=>Promise<any>,kind:string,id:string,refresh=false)=>{let raw=(refresh||kind==='catalog'||kind==='account')?undefined:cached(name);if(raw===undefined){raw=await retry(fn,max,emit);write(name,path,raw,kind,id);}return raw;};
 save();emit({type:'takeout.started',resumed:Object.keys(m.files).length>0});
 let listing:any;
 try{listing=await capture('conversations:index','conversations/index.json',()=>service.conversations({archived:'all',pageSize:args.pageSize,maxPages:args.maxPages}),'catalog','conversations');if(!Array.isArray(listing.items))throw new Error('Invalid conversation catalog');m.coverage['conversations:index']={required:true,status:listing.complete===true?'complete':'partial',count:listing.items.length,reason:listing.complete===true?undefined:'Catalog pagination did not prove completeness.'};}catch(e){m.coverage['conversations:index']={required:true,...scope(e)};save();}
 const chats=new Map<string,any>();for(const c of listing?.items||[]){const id=recordId(c);if(id)chats.set(id,c);else m.coverage['conversations:index']={required:true,status:'partial',reason:'Catalog record has no identity.'};}
 const catalogs=['projects','gpts'];
 for(const kind of catalogs){try{
  const raw=await capture(kind+':index',kind+'/index.json',()=>{if(!service.dispatch)throw new Error('unsupported');return service.dispatch(kind+'.list',{});},'catalog',kind);
  const rows=raw.items;if(!Array.isArray(rows))throw new Error('Unrecognized catalog');
  m.coverage[kind+':index']={required:true,status:raw.complete===true?'complete':'partial',count:rows.length};
  for(const row of rows){const id=recordId(row);if(!id){m.coverage[kind+':index'].status='partial';continue;}
   const name=kind+':'+id;try{await capture(name,`${kind}/${key(id)}.json`,()=>service.dispatch!(kind+'.get',{id}),kind,id);m.coverage[name]={required:true,status:'complete'};}catch(e){m.coverage[name]={required:true,...scope(e)};}
   if(kind==='projects'){try{const list=await capture(name+':chats',`${kind}/${key(id)}.conversations.json`,()=>service.dispatch!('projects.chats',{id}),'catalog',id);if(!Array.isArray(list.items))throw new Error('Invalid project conversations');m.coverage[name+':chats']={required:true,status:list.complete===true?'complete':'partial',count:list.items.length};for(const c of list.items){const cid=recordId(c);if(cid)chats.set(cid,c);else m.coverage[name+':chats'].status='partial';}}catch(e){m.coverage[name+':chats']={required:true,...scope(e)};}}
  }
 }catch(e){m.coverage[kind+':index']={required:true,...scope(e)};}save();}
 // Materialize the entire observed target set before any detail read can stop on a rate limit.
 // Preserve historical trees, and distinguish pending targets from attempted failures.
 const targetIds=[...chats.keys()].sort(),targetSourcesComplete=['conversations:index','projects:index',...Object.keys(m.coverage).filter(name=>name.startsWith('projects:')&&name.endsWith(':chats'))].every(name=>m.coverage[name]?.status==='complete');
 for(const id of targetIds)if(!m.coverage['conversation:'+id])m.coverage['conversation:'+id]={required:true,status:'partial',reason:'Pending conversation detail read; no attempt recorded yet.'};
 const historicalIds=Object.keys(m.coverage).filter(name=>name.startsWith('conversation:')).map(name=>name.slice('conversation:'.length)).filter(id=>!chats.has(id)).sort();
 write('conversations:targets','conversations/targets.json',{ids:targetIds,count:targetIds.length,sha256:hash(JSON.stringify(targetIds)),sourceCatalogsComplete:targetSourcesComplete,historicalIds,observedAt:new Date().toISOString()},'catalog','conversation-targets');
 m.coverage['conversations:targets']={required:true,status:targetSourcesComplete?'complete':'partial',count:targetIds.length,reason:targetSourcesComplete?undefined:'Target set is limited by incomplete conversation or project catalogs; historical snapshots are preserved.'};save();
 const operations=['settings.get','settings.instructions','account.get','features.list','tasks.list','plugins.list','connectors.list','pins.list','invoices.list','models.list','voices.list','capabilities.list'];
 for(const op of operations){try{const raw=await capture(op,`account/${op}.json`,()=>{if(!service.dispatch)throw new Error('unsupported');return service.dispatch(op,{discover:false});},'account',op);const paginated=raw&&typeof raw==='object'&&('coverage'in raw||'has_more'in raw||'hasMore'in raw||'next_cursor'in raw);const verified=raw?.complete===true||(!paginated&&op!=='invoices.list'&&op!=='tasks.list'&&op!=='connectors.list'&&op!=='plugins.list'&&op!=='pins.list');m.coverage[op]={required:true,status:verified?'complete':'partial',reason:verified?undefined:'Response captured; pagination completeness is unverified.'};}catch(e){m.coverage[op]={required:true,...scope(e)};}save();}
 let done=0,reads=0;const refs=new Map<string,MediaReference>();
 // A run reads a BOUNDED slice of conversation details by default. Unread targets stay recorded as
 // pending — never as failures — so a short run can never hide a target that was never attempted.
 const budget=conversationBudget(args.maxConversations);
 const outstanding=()=>targetIds.filter(other=>m.coverage['conversation:'+other]?.status!=='complete').length;
 const halt=(reason:'read-limit'|'rate-limit'|'frozen',detail:string)=>{
  m.coverage['conversations:details']={required:true,status:'partial',count:done,reason:detail};save();
  const result={...auditTakeout(root),paused:true,stopped:reason==='read-limit',deferred:reason==='frozen',reason,reads,limit:budget===Infinity?null:budget,attempted:done,remaining:outstanding(),targets:targetIds.length};
  atomicJSON(join(root,'coverage.json'),result);
  emit({type:reason==='frozen'?'takeout.deferred':'takeout.paused',reason,completed:done,total:chats.size,reads,remaining:result.remaining});
  return result;
 };
 /** Mirrors capture()'s cache decision so the budget only counts reads that actually reach the site. */
 const plan=(id:string)=>{try{const indexed=chats.get(id),previous=cached('conversation:'+id),updated=indexed?.update_time??indexed?.updated_at;const changed=!!(previous&&updated!=null&&String(updated)!==String(previous.update_time??previous.updated_at));return {previous,changed,fetches:previous===undefined||changed};}catch{return {previous:undefined,changed:false,fetches:true};}};
 for(const id of chats.keys()){
  const name='conversation:'+id,ahead=plan(id);
  if(ahead.fetches&&reads>=budget)return halt('read-limit',`Bounded run stopped after ${reads} conversation read${reads===1?'':'s'} (limit ${budget}). Resume for the next slice.`);
  if(ahead.fetches&&freezeState(service).frozen)return halt('frozen','Account traffic is frozen; remaining conversation details were not attempted and no failure was recorded.');
  try{const changed=ahead.changed;const raw=await capture(name,`conversations/${key(id)}.json`,()=>{reads++;return service.conversation(id);},'conversation',id,changed);
   const mapping=raw.mapping;if(!mapping||typeof mapping!=='object'||Array.isArray(mapping))throw new Error('Missing message tree');
   let invalid=false;for(const [nid,node]of Object.entries(mapping) as [string,any][]){if(!node||node.parent&&!mapping[node.parent]||(node.children||[]).some((child:string)=>!mapping[child]))invalid=true;}
   if(raw.current_node&&!mapping[raw.current_node])invalid=true;
   for(const nid of Object.keys(mapping)){const seen=new Set<string>();let cursor:string|null=nid;while(cursor&&mapping[cursor]){if(seen.has(cursor)){invalid=true;break;}seen.add(cursor);cursor=mapping[cursor].parent;}}
   m.coverage[name]={required:true,status:invalid?'partial':'complete',count:Object.keys(mapping).length,reason:invalid?'Message tree references missing nodes.':undefined};
   for(const ref of mediaReferences(raw,id))refs.set(ref.id,ref);
  }catch(e){
   if(isFrozenError(e)){m.coverage[name]={required:true,status:'partial',reason:PENDING_REASON};return halt('frozen','Account traffic is frozen; remaining conversation details were not attempted and no failure was recorded.');}
   m.coverage[name]={required:true,...scope(e)};
   if((e as any)?.status===429||/\b429\b|rate.limit/i.test(String((e as any)?.message||e)))return halt('rate-limit','Rate limit interrupted conversation detail reads. Resume after cooldown.');}
  save();emit({type:'takeout.progress',phase:'conversations',completed:++done,total:chats.size});
 }
 delete m.coverage['conversations:details'];
 /** Media downloads are site reads too: a freeze that lands mid-run defers them instead of recording failures. */
 const deferMedia=()=>{save();const result={...auditTakeout(root),paused:true,deferred:true,reason:'frozen',phase:'media',reads,attempted:done,remaining:outstanding(),targets:targetIds.length};atomicJSON(join(root,'coverage.json'),result);emit({type:'takeout.deferred',reason:'frozen',phase:'media'});return result;};
 if(freezeState(service).frozen)return deferMedia();
 try{const library=await capture('media:library','media/library.json',()=>{if(!service.dispatch)throw new Error('unsupported');return service.dispatch('media.list',{includeRaw:true});},'catalog','media:library');if(!Array.isArray(library.items))throw new Error('Unrecognized library catalog');m.coverage['media:library']={required:true,status:library.complete===true?'complete':'partial',count:library.items.length,reason:library.complete===true?undefined:'Library pagination or another library scope remains unverified.'};for(const item of library.items){if(item.downloadable===true&&typeof item.reference==='string'){const id=key(item.reference);refs.set(id,{id,reference:item.reference,conversationId:item.conversationId||'',kind:item.kind||'library-file'});}}}catch(e){m.coverage['media:library']={required:true,...scope(e)};}save();
 write('media:index','media/index.json',[...refs.values()],'catalog','media');
 for(const ref of refs.values()){const name='media:'+ref.id;const pending=!m.files[name]||!intact(root,m.files[name]);
  try{if(pending){const cached=readExportedMedia(args.mediaExport||join(accountDir(service.account),'media-export'),ref,{accountId:service.account.id,userId:service.account.userId});
   // A local export copy needs no traffic; only an actual download is deferred by a freeze.
   if(!cached&&freezeState(service).frozen)return deferMedia();
   if(!cached&&!service.downloadMedia)throw new Error('unsupported');const result=cached||await retry(()=>service.downloadMedia!(ref),max,emit);if(!(result.bytes instanceof Uint8Array)||!result.bytes.length)throw new Error('Empty media response');const extension=/^[a-z0-9]{1,8}$/.test(result.extension||'')?result.extension:'bin';write(name,`media/${ref.id}.${extension}`,result.bytes,'media',ref.id,true);if(result.contentType)m.files[name].contentType=result.contentType;}m.coverage[name]={required:true,status:'complete'};}catch(e){m.coverage[name]={required:true,...scope(e)};}save();}
 m.coverage['media:discovery']={required:true,status:'partial',count:refs.size,reason:'Explicit media references scanned in all fetched conversation trees and positively identified ChatGPT-owned library files. Unexposed libraries and unrecognized reference schemes remain unverified.'};
 m.coverage['account:other-surfaces']={required:false,status:'unsupported',reason:'Deleted or expired data, unexposed memories, GPT knowledge binaries, unobserved nested or archived media scopes and other server-only data require additional observed adapters or the official export.'};
 m.complete=Object.values(m.coverage).every(s=>s.status==='complete');m.updated=new Date().toISOString();atomicJSON(manifestPath,m);
 const result=auditTakeout(root);atomicJSON(join(root,'coverage.json'),result);emit({type:'takeout.finished',complete:result.complete,files:result.files});return result;
}

/**
 * One archive writer per directory. Only a PROVABLY dead writer releases the lock: an owner whose
 * liveness cannot be probed (EPERM under a sandbox or another user) is never assumed dead.
 * A frozen account defers the whole run before any site read, any lock and any failure record.
 */
export async function runTakeout(service:TakeoutService,args:Parameters<typeof executeTakeout>[1]={},emit:(event:any)=>void=()=>{}){
 const root=resolve(args.output||join(accountDir(service.account),'takeout'));
 const frozen=freezeState(service);
 if(frozen.frozen){
  const base=existsSync(join(root,'manifest.json'))?auditTakeout(root):{path:root,integrity:true,complete:false,files:0,damaged:[] as any[],coverage:{}};
  const result={...base,paused:true,deferred:true,reason:'frozen',...(frozen.reason?{freezeReason:frozen.reason}:{}),reads:0,attempted:0};
  emit({type:'takeout.deferred',reason:'frozen'});return result;
 }
 if(service.identity){const session=await service.identity();if(session.authenticated===false)throw new Error('Sign in before taking out account data.');}
 if(existsSync(root)&&lstatSync(root).isSymbolicLink())throw new Error('Archive root cannot be a symbolic link');
 privateDir(root);const lock=join(root,'.writer.lock');
 if(existsSync(lock)){if(lstatSync(lock).isSymbolicLink())throw new Error('Unsafe archive lock');const pid=Number(readFileSync(lock,'utf8'));const state=Number.isSafeInteger(pid)&&pid>0?processLiveness(pid):'unknown';
  if(state==='alive')throw new Error('Archive is already being written; wait for its writer to finish.');
  if(state!=='dead')throw new Error('An archive writer lock exists whose owner cannot be probed; verify it by hand before writing.');
  unlinkSync(lock);}
 const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);
 try{return await executeTakeout(service,{...args,output:root},emit);}finally{unlinkSync(lock);}
}
