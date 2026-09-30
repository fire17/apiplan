import {join} from 'node:path';
import {account,accountDir,atomicJSON,readJSON,type Account} from './accounts.ts';
const fields=['collection','nav','selected','query','focus','conversation','project','gpt','heading','messages','draft','cursor','scroll','model','effort','mode','status','error','coverage','navProject','showThinking','queue','attachments','downloads','inFlight','composerNavigation','sharedQueueView'];
export function sessionEnvelope(a:Account,state:Record<string,any>){
 const ui=Object.fromEntries(fields.filter(key=>state[key]!==undefined).map(key=>[key,state[key]]));
 const result={schema:1,account:{id:a.id,userId:a.userId,workspace:a.workspace},savedAt:new Date().toISOString(),ui};
 if(Buffer.byteLength(JSON.stringify(result))>16*1024*1024)throw new Error('TUI session exceeds 16 MiB; previous checkpoint retained.');return result;
}
export function restoreSession(a:Account,envelope:any){
 if(!envelope||envelope.schema!==1||envelope.account?.id!==a.id||envelope.account?.userId!==a.userId||envelope.account?.workspace!==a.workspace)return undefined;
 const state=envelope.ui;if(!state||!Array.isArray(state.messages)||!Array.isArray(state.nav)||typeof state.draft!=='string')return undefined;
 const restored=JSON.parse(JSON.stringify(state));
 restored.a=a;restored.inspector=false;restored.inspection=null;restored.control=0;restored.monitoring=false;restored.palette=null;
 if(restored.queue)restored.queue.paused=true;
 restored.status=restored.inFlight?'Restored conversation · previous response may still be running; inspect before sending':'Restored last conversation and reading position';
 restored.error='';return restored;
}
export function loadTuiSession(id?:string){const a=account(id);return restoreSession(a,readJSON(join(accountDir(a),'tui-session.json'),null));}
export function saveTuiSession(id:string|undefined,state:Record<string,any>){const a=account(id);if(state.a?.id&&state.a.id!==a.id)throw new Error('TUI checkpoint account mismatch.');atomicJSON(join(accountDir(a),'tui-session.json'),sessionEnvelope(a,state));}
