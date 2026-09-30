import {afterAll,describe,expect,test} from 'bun:test';
import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const TEST_HOME=join(tmpdir(),`apiplan-chatgpt-runtime-service-${process.pid}`);
process.env.CHATGPT_HOME=TEST_HOME;
afterAll(()=>rmSync(TEST_HOME,{recursive:true,force:true}));

const [{RuntimeGate},{ChatGPTService}]=await Promise.all([
 import('../../src/chatgpt/runtime.ts'),
 import('../../src/chatgpt/service.ts'),
]);

function deferred<T=void>(){
 let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(reason?:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}

const account={id:'runtime-service',label:'Runtime service test',baseURL:'https://chatgpt.com',created:'2026-09-15T00:00:00.000Z',source:{provider:'managed' as const}};

describe('RuntimeGate revision boundaries',()=>{
 test('coalesces concurrent checks for one revision into one reload',async()=>{
  const release=deferred(),events:any[]=[];let reloads=0;
  const gate=new RuntimeGate('initial',async()=>{reloads++;await release.promise;},event=>events.push(event));
  const first=gate.check('next'),second=gate.check('next');
  expect(reloads).toBe(1);
  release.resolve();
  await Promise.all([first,second]);
  expect(reloads).toBe(1);
  expect(events).toEqual([{type:'runtime.reloaded'}]);
 });

 test('serializes a newer revision that arrives during a reload',async()=>{
  const releases=[deferred(),deferred()];let reloads=0;
  const gate=new RuntimeGate('initial',async()=>{await releases[reloads++].promise;},()=>{});
  const first=gate.check('revision-1'),second=gate.check('revision-2');
  expect(reloads).toBe(1);
  releases[0].resolve();
  await first;
  await Promise.resolve();
  expect(reloads).toBe(2);
  releases[1].resolve();
  await Promise.all([first,second]);
 });

 test('retains a failed attempted revision and retries when a new revision appears',async()=>{
  const error=new Error('candidate module failed'),events:any[]=[];let reloads=0;
  const gate=new RuntimeGate('working',async()=>{reloads++;if(reloads===1)throw error;},event=>events.push(event));
  await expect(gate.check('broken')).resolves.toBeUndefined();
  await expect(gate.check('broken')).resolves.toBeUndefined();
  expect(reloads).toBe(1);
  expect(events[0]).toMatchObject({type:'runtime.rejected',reason:'Revision failed to load; previous working runtime retained.',detail:error});
  await expect(gate.check('fixed')).resolves.toBeUndefined();
  expect(reloads).toBe(2);
  expect(events[1]).toEqual({type:'runtime.reloaded'});
 });
});

describe('ChatGPTService operation guards',()=>{
 test('a redirected conversation navigation cannot reach composer or submit',async()=>{
  const service=Object.create(ChatGPTService.prototype) as InstanceType<typeof ChatGPTService>;
  service.account={...account};service.busy=false;service.cancelled=false;
  service.identity=async()=>({authenticated:true}) as any;
  const browserCalls:string[]=[];
  service.browser={call:async(op:string)=>{browserCalls.push(op);if(op==='goto')return {navigated:true};throw new Error(`Unexpected browser call: ${op}`);}} as any;
  let snapshots=0,composed=false,submitted=false;
  service.actions={
   idle:async()=>{},
   snapshot:async()=>{snapshots++;return {url:'https://chatgpt.com/',messages:[]};},
   composer:async()=>{composed=true;},
   submit:async()=>{submitted=true;},
  } as any;
  await expect(service.send({conversation:'requested-chat',text:'must remain unsent'},()=>{})).rejects.toThrow('No message was sent');
  expect({browserCalls,snapshots,composed,submitted,busy:service.busy}).toEqual({browserCalls:['goto'],snapshots:2,composed:false,submitted:false,busy:false});
 });

 test('interact rejects overlap and releases the guard after settlement',async()=>{
  const service=Object.create(ChatGPTService.prototype) as InstanceType<typeof ChatGPTService>;
  service.busy=false;
  const release=deferred<string>(),started=deferred();let overlapRan=false;
  const first=service.interact(async()=>{started.resolve();return release.promise;});
  await started.promise;
  await expect(service.interact(async()=>{overlapRan=true;})).rejects.toThrow('An account interaction is active');
  expect(overlapRan).toBe(false);
  release.resolve('complete');
  expect(await first).toBe('complete');
  expect(service.busy).toBe(false);
  await expect(service.interact(async()=>{throw new Error('operation failed');})).rejects.toThrow('operation failed');
  expect(service.busy).toBe(false);
 });

 test('dispatch lazily initializes a missing RuntimeGate on an older service instance',async()=>{
  const service=Object.create(ChatGPTService.prototype) as InstanceType<typeof ChatGPTService>;
  service.account={...account};
  let made=0,checked=0,executed=0;
  service.makeRuntimeGate=()=>{made++;return {check:async()=>{checked++;}} as any;};
  service.execute=async()=>{executed++;return {ok:true};};
  expect(await service.dispatch('ui.snapshot')).toEqual({ok:true});
  expect({made,checked,executed}).toEqual({made:1,checked:1,executed:1});
  expect(await service.dispatch('ui.snapshot')).toEqual({ok:true});
  expect({made,checked,executed}).toEqual({made:1,checked:2,executed:2});
 });

 test('paused receipts fail immediately without entering the bulk request wait',async()=>{
  const service=Object.create(ChatGPTService.prototype) as InstanceType<typeof ChatGPTService>;
  service.conversationReadsPaused=true;service.rateLimitedUntil=0;
  let requested=false;service.request=async()=>{requested=true;return {};};
  const started=performance.now();
  await expect(service.receipt('/backend-api/conversation/chat')).rejects.toMatchObject({status:429});
  expect(performance.now()-started).toBeLessThan(100);
  expect(requested).toBe(false);
 });

 test('a paused bulk conversation read waits outside the request queue',async()=>{
  const service=Object.create(ChatGPTService.prototype) as InstanceType<typeof ChatGPTService>;
  service.account={...account};service.conversationReadsPaused=true;service.requestQueue=Promise.resolve();service.nextRequestAt=0;service.rateLimitedUntil=0;service.rateFailures=0;service.limitedScope='';
  const paths:string[]=[];service.browser={call:async(_op:string,args:any)=>{paths.push(args.path);return {status:200,body:{path:args.path}};}} as any;
  let detailSettled=false;
  const detail=service.request('/backend-api/conversation/chat').finally(()=>{detailSettled=true;});
  await Bun.sleep(20);
  const catalog=await Promise.race([service.request('/backend-api/conversations?offset=0'),Bun.sleep(250).then(()=>{throw new Error('catalog request was blocked by paused detail read');})]);
  expect(catalog).toEqual({path:'/backend-api/conversations?offset=0'});
  expect(detailSettled).toBe(false);
  expect(paths).toEqual(['/backend-api/conversations?offset=0']);
  service.conversationReadsPaused=false;
  expect(await Promise.race([detail,Bun.sleep(2000).then(()=>{throw new Error('detail request did not resume');})])).toEqual({path:'/backend-api/conversation/chat'});
  expect(paths).toEqual(['/backend-api/conversations?offset=0','/backend-api/conversation/chat']);
 });
});

describe('send phase and request journal integration',()=>{
 test('full dispatch sends once and reuses the completed receipt',async()=>{
  const service=new ChatGPTService({...account,id:'send-journal-success',userId:'fixture-user'});let submits=0;const events:any[]=[];
  service.start=async()=>{};service.identity=async()=>({authenticated:true});service.workFallback=async args=>args;service.conversationReadsPaused=true;
  service.actions={idle:async()=>{},composer:async()=>{},snapshot:async()=>({url:'https://chatgpt.com/'}),submit:async()=>{submits++;},waitReply:async(_before:any,emit:any)=>{emit({type:'submitted',verified:true});emit({type:'text',text:'ACK'});return {conversation:'fixture-chat',url:'https://chatgpt.com/c/fixture-chat',text:'ACK'};}} as any;
  try{const args={requestId:'one-submit',text:'fixture prompt'};const first=await service.dispatch('chat.send',args,event=>events.push(event)),second=await service.dispatch('chat.send',args,event=>events.push(event));expect(first).toEqual(second);expect(submits).toBe(1);expect(events.some(event=>event.type==='operation.receipt'&&event.reused===true)).toBe(true);expect(service.store.get('chat','fixture-chat').update_time).toBeTruthy();}finally{service.store.close();}
 });
 test('identity failure after journal start records a not-submitted receipt',async()=>{
  const service=new ChatGPTService({...account,id:'send-journal-auth',userId:'fixture-user'});service.start=async()=>{};service.identity=async()=>{throw new Error('Authentication session read timed out.');};
  try{await expect(service.dispatch('chat.send',{requestId:'failed-auth',text:'preserve draft'})).rejects.toMatchObject({code:'NOT_SUBMITTED'});const receipt=await service.execute('receipts.get',{id:'failed-auth'});expect(receipt.receipt.status).toBe('not-submitted');expect(receipt.receipt.error.outcome).toBe('not-submitted');}finally{service.store.close();}
 });
 test('identity failure before journal initialization also reports not submitted',async()=>{
  const service=new ChatGPTService({...account,id:'send-journal-pre'});service.start=async()=>{};service.identity=async()=>{throw new Error('Authentication session read timed out.');};
  try{await expect(service.dispatch('chat.send',{requestId:'pre-journal-auth',text:'preserve draft'})).rejects.toMatchObject({code:'NOT_SUBMITTED'});}finally{service.store.close();}
 });
});
