import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {existsSync,unlinkSync,openSync,closeSync,chmodSync,readFileSync,writeFileSync} from 'node:fs';
import {account,accountDir,atomicJSON,readJSON,type Account} from './accounts.ts';
import {classifyError} from './monitor.ts';
import {ChatGPTService,DIRECT_READ_OPERATIONS} from './service.ts';
import {processLiveness} from './autostart.ts';

export const DAEMON_RPC_HEARTBEAT_MS=25000;
type BunLoopbackRequestInit=RequestInit&{timeout:false};
export function daemonRPCRequestInit(token:string,op:string,args:any,signal?:AbortSignal):BunLoopbackRequestInit{return {method:'POST',headers:{'content-type':'application/json','x-chatgpt-token':token},body:JSON.stringify({op,args}),timeout:false,...(signal?{signal}:{})};}
export function daemonRPCResponse(req:Request,op:string,dispatch:(emit:(event:any)=>void,signal:AbortSignal)=>Promise<any>,heartbeatMs=DAEMON_RPC_HEARTBEAT_MS){
 const enc=new TextEncoder(),cancellation=new AbortController();let controller:ReadableStreamDefaultController<Uint8Array>|undefined,closed=false,heartbeat:ReturnType<typeof setInterval>|undefined;
 const cleanup=()=>{if(heartbeat!==undefined){clearInterval(heartbeat);heartbeat=undefined;}req.signal.removeEventListener('abort',abort);};
 const close=()=>{if(closed)return;closed=true;cleanup();try{controller?.close();}catch{}};
 const send=(value:any)=>{if(closed)return;try{controller?.enqueue(enc.encode(JSON.stringify(value)+'\n'));}catch{close();}};
 const abort=()=>{cancellation.abort();close();};
 const stream=new ReadableStream<Uint8Array>({
  start(c){controller=c;if(req.signal.aborted){abort();return;}req.signal.addEventListener('abort',abort,{once:true});heartbeat=setInterval(()=>send({heartbeat:{at:new Date().toISOString()}}),heartbeatMs);heartbeat.unref?.();void (async()=>{try{send({result:await dispatch(event=>send({event}),cancellation.signal)});}catch(e:any){send({error:{...classifyError(e),operation:op,requestId:e.requestId,status:e.status,retryAfterMs:e.retryAfterMs}});}finally{close();}})();},
  cancel(){abort();},
 });
 return new Response(stream,{headers:{'content-type':'application/x-ndjson'}});
}

export function daemonFile(a:Account){return join(accountDir(a),'daemon.json');}
type DaemonOwner={pid:number;instance:string};
function owner(value:any):DaemonOwner|undefined{return Number.isSafeInteger(value?.pid)&&value.pid>0&&typeof value?.instance==='string'&&value.instance?{pid:value.pid,instance:value.instance}:undefined;}
function lockOwner(path:string){try{return owner(JSON.parse(readFileSync(path,'utf8')));}catch{return undefined;}}
function writeLock(fd:number,value:DaemonOwner){try{writeFileSync(fd,JSON.stringify(value)+'\n');}finally{closeSync(fd);}}
export function claimDaemonLock(lock:string,statePath:string,value:DaemonOwner,probe?:(pid:number)=>void){
 try{writeLock(openSync(lock,'wx',0o600),value);return;}
 catch(error:any){
  if(error?.code!=='EEXIST')throw error;
  const state=readJSON<any>(statePath,{}),locked=lockOwner(lock),stated=owner(state);
  if(locked&&stated&&(locked.pid!==stated.pid||locked.instance!==stated.instance))throw new Error('ChatGPT daemon lock and state ownership disagree; preserve both and reconcile manually.');
  const existing=locked||stated||((Number.isSafeInteger(state.pid)&&state.pid>0)?{pid:state.pid,instance:'legacy'}:undefined);
  if(!existing)throw new Error('ChatGPT daemon lock ownership is unknown; preserve it and reconcile manually.');
  const liveness=processLiveness(existing.pid,probe);
  if(liveness==='alive')throw new Error('ChatGPT daemon already running.');
  if(liveness==='unknown')throw new Error('ChatGPT daemon lock owner liveness is unknown; preserve it and reconcile manually.');
  unlinkSync(lock);writeLock(openSync(lock,'wx',0o600),value);
 }
}
export function releaseDaemonOwnership(lock:string,statePath:string,value:DaemonOwner,token:string){
 const state=readJSON<any>(statePath,{});
 if(state.pid===value.pid&&state.instance===value.instance&&state.token===token)try{unlinkSync(statePath);}catch{}
 const current=lockOwner(lock);
 if(current?.pid===value.pid&&current.instance===value.instance)try{unlinkSync(lock);}catch{}
}
export async function runDaemon(a:Account,headless=true){
 const dir=accountDir(a),lock=join(dir,'daemon.lock'),instance=crypto.randomUUID(),ownership={pid:process.pid,instance};
 claimDaemonLock(lock,daemonFile(a),ownership);
 const svc=new ChatGPTService(a), token=crypto.randomUUID();
 const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(req){
  if(req.headers.get('x-chatgpt-token')!==token)return new Response('Unauthorized',{status:401});
  if(req.method==='GET')return Response.json({ok:!stopping,account:a.id,pid:process.pid},{status:stopping?503:200});
  if(stopping)return Response.json({error:'Daemon is shutting down; retry after it stops.'},{status:503});
  if(req.headers.get('origin'))return new Response('Browser-origin requests are not accepted',{status:403});
  let m:any;try{m=await req.json();}catch{return new Response('Invalid JSON',{status:400});}
  if(m.op==='daemon.stop'){setTimeout(()=>shutdown(),100);return Response.json({stopped:true});}
  return daemonRPCResponse(req,m.op,(emit,signal)=>svc.dispatch(m.op,{...m.args,_signal:signal},emit));
 }});
 atomicJSON(daemonFile(a),{pid:process.pid,port:server.port,token,account:a.id,instance});
 let stopping=false;
 async function shutdown(){if(stopping)return;stopping=true;svc.watcher().stop({disable:false});await svc.browser.close();svc.store.close();server.stop(true);releaseDaemonOwnership(lock,daemonFile(a),ownership,token);process.exit(0);}
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
 // Browser startup is lazy: local archives, monitoring and indexes work offline.
 svc.watcher().start({restore:true});
 await new Promise(()=>{});
}

/** In-process execution for pure local reads and the freeze switch. Never starts a browser; used when the daemon is unreachable (sandboxes deny loopback) or when CHATGPT_DIRECT=1. */
async function direct(a:Account,op:string,args:any,onEvent:((e:any)=>void)|undefined,reason:string){
 if(!DIRECT_READ_OPERATIONS.has(op))throw Object.assign(new Error(`${op} needs the ChatGPT daemon (browser or site traffic); direct mode only runs local reads and freeze/thaw.`),{code:'DAEMON_REQUIRED',retryable:false,action:'Local reads, receipts and freeze/thaw run without a daemon. Starting one opens a browser on the account owner\'s live session, so ask before starting it.'});
 onEvent?.({type:'direct-mode',operation:op,reason});
 const svc=new ChatGPTService(a,{autoResume:false});// local reads never resume the background archive writer
 try{return await svc.execute(op,{...args},e=>onEvent?.(e));}finally{svc.store.close();}
}
export async function call(a:Account,op:string,args:any={},onEvent?:(e:any)=>void,signal?:AbortSignal):Promise<any>{
 signal?.throwIfAborted();
 if(process.env.CHATGPT_DIRECT==='1')return direct(a,op,args,onEvent,'CHATGPT_DIRECT=1');
 let st=readJSON<any>(daemonFile(a),{});
 const alive=async()=>{try{return (await fetch(`http://127.0.0.1:${st.port}/health`,{headers:{'x-chatgpt-token':st.token||''},signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}};
 if(!await alive()){
  if(op==='daemon.stop')return {stopped:false};
  if(DIRECT_READ_OPERATIONS.has(op))return direct(a,op,args,onEvent,'daemon unreachable');
  const managed=process.platform==='darwin'&&(await (await import('./autostart.ts')).status(a)).loaded;
  if(!managed)spawn(process.execPath,[join(import.meta.dir,'../../bin/chatgpt.ts'),'--account',a.id,'_daemon',...(args.headless===false?['--headed']:[])],{detached:true,stdio:'ignore'}).unref();
  let ready=false;for(let i=0;i<150;i++){signal?.throwIfAborted();await Bun.sleep(100);st=readJSON<any>(daemonFile(a),{});if(await alive()){ready=true;break;}}
  if(!ready)throw new Error('ChatGPT daemon did not start. Run chatgpt doctor or chatgpt _daemon to inspect startup.');
 }
 signal?.throwIfAborted();const r=await fetch(`http://127.0.0.1:${st.port}/rpc`,daemonRPCRequestInit(st.token,op,args,signal));
 if(!r.ok)throw new Error(`ChatGPT daemon returned ${r.status}.`);
 if(r.headers.get('content-type')?.startsWith('application/json')){const value=await r.json();if(op==='daemon.stop'){for(let i=0;i<100;i++){await Bun.sleep(100);if(!await alive())break;}}return value;}
 let buffer='',answer:any,received=false;const dec=new TextDecoder();
 for await(const chunk of r.body!){buffer+=dec.decode(chunk,{stream:true});let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line)continue;const m=JSON.parse(line);if(m.error)throw Object.assign(new Error(m.error.message),m.error);if(m.event)onEvent?.(m.event);if('result'in m){answer=m.result;received=true;}}}
 if(!received)throw new Error('Daemon stream ended without a completion receipt.');return answer;
}
