import {expect,spyOn,test} from 'bun:test';
import {DAEMON_RPC_HEARTBEAT_MS,call,claimDaemonLock,daemonRPCRequestInit,daemonRPCResponse,releaseDaemonOwnership} from '../src/chatgpt/daemon.ts';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function deferred<T=void>(){
 let resolve!:(value:T|PromiseLike<T>)=>void;
 const promise=new Promise<T>(yes=>{resolve=yes;});
 return {promise,resolve};
}

test('daemon RPC disables the Bun client idle timeout',()=>{
 const controller=new AbortController(),init=daemonRPCRequestInit('secret','media.export',{catalog:'items.json'},controller.signal);
 expect(init).toMatchObject({method:'POST',timeout:false,headers:{'content-type':'application/json','x-chatgpt-token':'secret'}});
 expect(JSON.parse(String(init.body))).toEqual({op:'media.export',args:{catalog:'items.json'}});
 expect(init.signal).toBe(controller.signal);
});

test('an already-aborted client call exits before daemon discovery',async()=>{
 const controller=new AbortController();controller.abort();
 const a={id:'abort-before-discovery',label:'fixture',baseURL:'https://chatgpt.com',created:'2026-09-15T00:00:00.000Z'} as any;
 await expect(call(a,'chat.send',{text:'must not be submitted'},undefined,controller.signal)).rejects.toMatchObject({name:'AbortError'});
});

test('daemon RPC heartbeats within 30 seconds and clears its timer when the request is cancelled',async()=>{
 expect(DAEMON_RPC_HEARTBEAT_MS).toBeLessThanOrEqual(30000);
 const release=deferred(),settled=deferred(),abortController=new AbortController();let operationSignal:AbortSignal|undefined;
 const clear=spyOn(globalThis,'clearInterval');
 try{
  const response=daemonRPCResponse(new Request('http://127.0.0.1/rpc',{signal:abortController.signal}),'media.export',async (_emit,signal)=>{operationSignal=signal;await release.promise;settled.resolve();return {complete:true};},5);
  const reader=response.body!.getReader(),first=await reader.read();
  expect(first.done).toBe(false);
  const message=JSON.parse(new TextDecoder().decode(first.value));
  expect(message.heartbeat.at).toBeString();
  expect(5).toBeLessThanOrEqual(30000);
  abortController.abort();
  expect((await reader.read()).done).toBe(true);
  expect(operationSignal?.aborted).toBe(true);
  expect(clear).toHaveBeenCalledTimes(1);
  release.resolve();await settled.promise;await Promise.resolve();
  expect(clear).toHaveBeenCalledTimes(1);
 }finally{release.resolve();clear.mockRestore();}
});

test('daemon ownership treats EPERM as unknown and an old shutdown preserves a newer generation',()=>{
 const root=mkdtempSync(join(tmpdir(),'chatgpt-daemon-owner-')),lock=join(root,'daemon.lock'),state=join(root,'daemon.json'),old={pid:42,instance:'old'},next={pid:43,instance:'next'};
 try{
  writeFileSync(lock,JSON.stringify(old));writeFileSync(state,JSON.stringify({...old,port:1,token:'old-token'}));
  expect(()=>claimDaemonLock(lock,state,next,()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});})).toThrow('liveness is unknown');
  expect(JSON.parse(readFileSync(lock,'utf8'))).toEqual(old);
  writeFileSync(state,JSON.stringify({...next,port:2,token:'next-token'}));
  expect(()=>claimDaemonLock(lock,state,{pid:44,instance:'third'},()=>{throw Object.assign(new Error('gone'),{code:'ESRCH'});})).toThrow('ownership disagree');
  expect(JSON.parse(readFileSync(lock,'utf8'))).toEqual(old);
  writeFileSync(state,JSON.stringify({...old,port:1,token:'old-token'}));
  claimDaemonLock(lock,state,next,()=>{throw Object.assign(new Error('gone'),{code:'ESRCH'});});
  expect(JSON.parse(readFileSync(lock,'utf8'))).toEqual(next);
  writeFileSync(state,JSON.stringify({...next,port:2,token:'next-token'}));
  releaseDaemonOwnership(lock,state,old,'old-token');
  expect(existsSync(lock)).toBe(true);expect(existsSync(state)).toBe(true);
  releaseDaemonOwnership(lock,state,next,'next-token');
  expect(existsSync(lock)).toBe(false);expect(existsSync(state)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
