import {existsSync,lstatSync,readFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {accountDir,atomicJSON,type Account} from './accounts.ts';
const digest=(value:any)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(message:string)=>{throw Object.assign(new Error(message),{code:'HISTORY_SEED_INVALID',action:'Preserve the original observation and inspect the account/conversation identity. No browser mutation was attempted.'});};
function context(a:Account,snapshot:any){let url:URL;try{url=new URL(snapshot.url);}catch{return fail('History observation has no valid website URL.');}if(url.origin!==new URL(a.baseURL).origin)return fail('History observation belongs to another website.');const id=url.pathname.match(/^\/c\/([A-Za-z0-9_-]+)\/?$/)?.[1];if(!id||!Array.isArray(snapshot.messages))return fail('History observation needs an exact conversation and message array.');return id;}
const messageId=(message:any)=>message.id||message.message_id;
const role=(message:any)=>message.role||message.author?.role;
function path(a:Account,conversation:string){return join(accountDir(a),'observed-history',conversation+'.json');}
function safe(file:string){if(existsSync(file)&&(lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()||lstatSync(file).size>16*1024*1024))fail('History seed must be a regular private file below 16 MiB.');}
/** Explicit local recovery seed. Raw observed source is retained intact, never a claim of a full tree. */
export function seedObservedHistory(a:Account,snapshot:any,source:{sourcePath:string;observedAt:string}){
 if(!a.userId)fail('Bind the account website identity before seeding observed history.');
 const conversation=context(a,snapshot),ids=snapshot.messages.map(messageId);
 if(ids.some((id:any)=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)fail('Seed message IDs must be present and unique.');
 if(!source.sourcePath||!Number.isFinite(Date.parse(source.observedAt)))fail('Record the source path and observation time.');
 const envelope={schema:1,account:{id:a.id,userId:a.userId,workspace:a.workspace},conversation,source,rawSnapshot:snapshot,sha256:digest(snapshot),coverage:{complete:false,source:'previously observed mounted website messages'}};
 const file=path(a,conversation);safe(file);if(existsSync(file)){const previous=JSON.parse(readFileSync(file,'utf8'));if(digest(previous)!==digest(envelope))fail('An existing history seed is preserved; inspect it before replacing any evidence.');return {path:file,conversation,messages:ids.length,reused:true};}
 if(Buffer.byteLength(JSON.stringify(envelope))>16*1024*1024)fail('History seed exceeds 16 MiB.');
 atomicJSON(file,envelope);chmodSync(join(accountDir(a),'observed-history'),0o700);chmodSync(file,0o600);return {path:file,conversation,messages:ids.length,reused:false};
}
/** Reads only local evidence. Prefix recovery requires an ordered shared message-ID anchor. */
export function readObservedHistory(a:Account,current:any){
 const conversation=context(a,current),file=path(a,conversation);
 const coverage={complete:false,source:'currently mounted website messages',retainedPrefix:0};
 safe(file);if(!existsSync(file))return {messages:current.messages,coverage};
 const seed=JSON.parse(readFileSync(file,'utf8'));
 if(seed.schema!==1||seed.account?.id!==a.id||seed.account?.userId!==a.userId||seed.account?.workspace!==a.workspace||seed.conversation!==conversation||context(a,seed.rawSnapshot)!==conversation||digest(seed.rawSnapshot)!==seed.sha256)fail('History seed failed account, conversation or integrity checks.');
 const previous=seed.rawSnapshot.messages,positions=new Map(previous.map((message:any,index:number)=>[messageId(message),index]));
 const overlap=current.messages.filter((message:any)=>positions.has(messageId(message)));
 if(!overlap.length)return {messages:current.messages,coverage:{...coverage,seedAvailable:true,seedApplied:false,reason:'No shared mounted message ID; previous source retained without guessing a merge.'}};
 const indices=overlap.map((message:any)=>positions.get(messageId(message)) as number);
 if(indices.some((index:number,i:number)=>i>0&&index<=indices[i-1])||overlap.some((message:any,i:number)=>role(message)!==role(previous[indices[i]])))fail('History seed and current observation disagree on message order or role.');
 const currentIds=new Set(current.messages.map(messageId)),prefix=previous.slice(0,indices[0]).filter((message:any)=>!currentIds.has(messageId(message)));
 return {messages:[...prefix,...current.messages],coverage:{complete:false,source:'mounted website messages plus an ID-anchored previous observation',retainedPrefix:prefix.length,seedApplied:true,seedPath:file,originalSource:seed.source}};
}
