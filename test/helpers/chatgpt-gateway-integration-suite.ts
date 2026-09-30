import {afterAll,describe,expect,test} from 'bun:test';
import {mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Wiring test for the one thing the unit suites cannot prove: that a real ChatGPTService actually routes
// its worker traffic through the gateway when the config says so, and is untouched when it does not.
// His requirement, verbatim: "all of their calls are routed via our special wrapper ... one deduped access
// point in which we can do our own ratelimits ... and be able to change this protocol easily later with
// just a config and not code".

const TEST_HOME=join(tmpdir(),`apiplan-chatgpt-gateway-int-${process.pid}`);
process.env.CHATGPT_HOME=TEST_HOME;
afterAll(()=>rmSync(TEST_HOME,{recursive:true,force:true}));

const [{ChatGPTService},{setFreeze},{BUILTIN_GATEWAY,loadGatewayPolicy,decide},{resetGatewayRegistry,routeWorkerThroughGateway,accountGateway}]=await Promise.all([
 import('../../src/chatgpt/service.ts'),
 import('../../src/chatgpt/freeze.ts'),
 import('../../src/chatgpt/gateway-policy.ts'),
 import('../../src/chatgpt/gateway-registry.ts'),
]);

function account(id:string){return {id,label:'Gateway integration',baseURL:'https://chatgpt.com',created:'2026-09-16T00:00:00.000Z',source:{provider:'managed' as const}};}
function writeConfig(id:string,config:any){
 resetGatewayRegistry();// the registry memoises per account; a suite writing a new config must clear it
 const dir=join(TEST_HOME,'accounts',id);
 mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'gateway.json'),JSON.stringify(config));
}

/** Replace the worker's real dispatch, so nothing launches a browser and nothing reaches the site. */
function stubWorker(service:any){
 const calls:{op:string;args:any;at:number}[]=[];
 let live=0,maxLive=0;
 (service.browser as any).proc={};
 (service.browser as any).rawCall=async(op:string,args:any={})=>{
  live++;maxLive=Math.max(maxLive,live);
  const nonce=calls.push({op,args,at:Date.now()});// captured at entry: a nonce read after the await would race
  await Bun.sleep(1);
  live--;
  return {op,ok:true,nonce};
 };
 return {calls,peak:()=>maxLive};
}

describe('gateway wiring',()=>{
 test('with no gateway.json the service keeps its shipped behaviour and installs nothing',async()=>{
  const service=new ChatGPTService(account('no-config'),{autoResume:false}) as any;
  expect(service.gateway).toBeUndefined();
  const worker=stubWorker(service);
  const results=await Promise.all([service.browser.call('snapshot',{}),service.browser.call('snapshot',{})]);
  // Untouched path: two calls in, two calls out, no dedupe, no queueing.
  expect(worker.calls.length).toBe(2);
  expect(results[0].nonce).not.toBe(results[1].nonce);
  service.store.close();
 });

 test('writing the config is the switch: calls route through the gateway and identical reads dedupe',async()=>{
  writeConfig('with-config',BUILTIN_GATEWAY);
  const service=new ChatGPTService(account('with-config'),{autoResume:false}) as any;
  expect(service.gateway).toBeDefined();
  const worker=stubWorker(service);
  const [first,second]=await Promise.all([
   service.browser.call('request',{path:'/backend-api/models',method:'GET'}),
   service.browser.call('request',{path:'/backend-api/models',method:'GET'}),
  ]);
  // One downstream call served both callers: the deduped access point he asked for.
  expect(worker.calls.length).toBe(1);
  expect(first.nonce).toBe(second.nonce);
  expect(worker.peak()).toBe(1);
  service.store.close();
 });

 test('two identical writes are never coalesced into one',async()=>{
  writeConfig('writes',BUILTIN_GATEWAY);
  const service=new ChatGPTService(account('writes'),{autoResume:false}) as any;
  const worker=stubWorker(service);
  const settled=await Promise.allSettled([
   service.browser.call('request',{path:'/backend-api/conversation/abc',method:'PATCH',body:{is_visible:false}}),
   service.browser.call('request',{path:'/backend-api/conversation/abc',method:'PATCH',body:{is_visible:false}}),
  ]);
  const fulfilled=settled.filter(r=>r.status==='fulfilled');
  const rejected=settled.filter(r=>r.status==='rejected') as PromiseRejectedResult[];
  // Exactly one write reaches the site; the twin is refused rather than silently sharing a result.
  expect(worker.calls.length).toBe(1);
  expect(fulfilled.length).toBe(1);
  expect(rejected.length).toBe(1);
  expect(String((rejected[0].reason as any)?.code)).toContain('GATEWAY');
  service.store.close();
 });

 test('a malformed config fails closed, and freezing still refuses before the gateway queues anything',async()=>{
  const dir=join(TEST_HOME,'accounts','broken');
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'gateway.json'),'{ this is not json');
  const service=new ChatGPTService(account('broken'),{autoResume:false}) as any;
  expect(service.gateway).toBeDefined();// installed precisely so it can refuse
  const worker=stubWorker(service);
  await expect(service.browser.call('request',{path:'/backend-api/models',method:'GET'})).rejects.toBeInstanceOf(Error);
  expect(worker.calls.length).toBe(0);

  setFreeze(account('broken'),true,{by:'test'});
  const frozen=await service.browser.call('request',{path:'/backend-api/models',method:'GET'}).catch((e:any)=>e);
  expect(frozen.code).toBe('FROZEN');
  expect(worker.calls.length).toBe(0);
  setFreeze(account('broken'),false,{by:'test'});
  service.store.close();
 });

 test('the raw dispatch the gateway uses still refuses while frozen, so it is not a bypass',async()=>{
  writeConfig('raw',BUILTIN_GATEWAY);
  const service=new ChatGPTService(account('raw'),{autoResume:false}) as any;
  (service.browser as any).proc={};
  setFreeze(account('raw'),true,{by:'test'});
  const refused=await service.browser.rawCall('request',{path:'/backend-api/models',method:'GET'}).catch((e:any)=>e);
  expect(refused.code).toBe('FROZEN');
  setFreeze(account('raw'),false,{by:'test'});
  service.store.close();
 });
});

describe('one limiter for every worker',()=>{
 test('a second worker built elsewhere shares the account limiter instead of pacing itself',async()=>{
  writeConfig('shared',BUILTIN_GATEWAY);
  const a=account('shared');
  const service=new ChatGPTService(a,{autoResume:false}) as any;
  const first=stubWorker(service);

  // Imitates the harness/online path, which constructs its OWN BrowserWorker (finding F1).
  const secondCalls:string[]=[];
  const second:any={
   router:undefined as any,
   setRouter(router:any){this.router=router;},
   rawCall:async(op:string,args:any)=>{secondCalls.push(op+' '+(args?.path||''));return {op,ok:true};},
   call(op:string,args:any={},timeout=45000){return this.router?this.router(op,args,timeout):this.rawCall(op,args);},
  };
  expect(routeWorkerThroughGateway(a,second)).toBe(true);
  expect(accountGateway(a)).toBe(service.gateway);// literally the same limiter object

  const [x,y]=await Promise.all([
   service.browser.call('request',{path:'/backend-api/conversation/abc',method:'GET'}),
   second.call('request',{path:'/backend-api/conversation/abc',method:'GET'}),
  ]);
  // Same account, same read, two different workers: one request reaches the site, not two.
  expect(first.calls.length+secondCalls.length).toBe(1);
  expect(x.ok).toBe(true);expect(y.ok).toBe(true);

  // The worker tag never reaches the browser, and worker-scoped reads are not shared across workers.
  await Promise.all([service.browser.call('snapshot',{surface:'main'}),second.call('snapshot',{surface:'main'})]);
  expect(first.calls.filter(c=>c.op==='snapshot').length).toBe(1);
  expect(secondCalls.filter(c=>c.startsWith('snapshot')).length).toBe(1);
  expect(JSON.stringify(first.calls)).not.toContain('__gatewayWorker');
  service.store.close();
 });
});

describe('turning the gateway on must not break the browser loops',()=>{
 const loaded=loadGatewayPolicy('probe',()=>JSON.stringify(BUILTIN_GATEWAY));
 const at=(op:string,extra:any={})=>decide(loaded,{op,args:{},layer:'worker',...extra}) as any;

 test('DOM operations are not paced by the HTTP catch-all',()=>{
  // The poll loops run at 150-250ms. Pacing them at the catch-all's 1000ms would blow the 45s
  // readiness budget and turn every send into NOT_SUBMITTED, which is what the shipped defaults did.
  for(const op of ['snapshot','action','key','scroll','text','mouse','composer','submit']){
   const decision=at(op);
   expect(decision.rate?.minSpacingMs??0).toBe(0);
   expect(decision.scope).toBe(`op:${op}`);
  }
 });

 test('HTTP keeps its pacing, and the conversation endpoint keeps its slower one',()=>{
  const models=at('request',{path:'/backend-api/models',method:'GET'});
  expect(models.rate.minSpacingMs).toBe(1000);
  expect(models.kind).toBe('read');// a GET is a read, whatever the operation name suggests
  const conversation=at('request',{path:'/backend-api/conversation/abc',method:'GET'});
  expect(conversation.rate.minSpacingMs).toBe(5000);
  expect(conversation.scope).toBe('/backend-api/conversation/{id}');
  expect(at('request',{path:'/backend-api/conversation/abc',method:'PATCH'}).kind).toBe('write');
 });

 test('a config can still tighten worker operations through the op bucket',()=>{
  const tightened={...BUILTIN_GATEWAY,defaults:{...BUILTIN_GATEWAY.defaults,scopes:{...BUILTIN_GATEWAY.defaults.scopes,'op:*':{minSpacingMs:250,burst:0},'op:snapshot':{minSpacingMs:750,burst:0}}}};
  const strict=loadGatewayPolicy('probe',()=>JSON.stringify(tightened));
  expect(strict.status).toBe('loaded');
  expect((decide(strict,{op:'action',args:{},layer:'worker'}) as any).rate.minSpacingMs).toBe(250);
  expect((decide(strict,{op:'snapshot',args:{},layer:'worker'}) as any).rate.minSpacingMs).toBe(750);
 });
});

describe('breaker state outlives the process',()=>{
 test('an open breaker is restored from disk by a new gateway',async()=>{
  writeConfig('breaker',BUILTIN_GATEWAY);
  const a=account('breaker');
  const {accountDir,atomicJSON}=await import('../../src/chatgpt/accounts.ts');
  const future=Date.now()+600000;
  atomicJSON(join(accountDir(a),'gateway-breaker.json'),{'/backend-api/conversation/{id}':{openUntilWall:future,failures:3,lastAtWall:Date.now()}});
  resetGatewayRegistry();
  const gateway=accountGateway(a)!;
  expect(gateway).toBeDefined();
  // A restart is not a way to clear a rate limit.
  expect(gateway.breakerState()['/backend-api/conversation/{id}'].openUntilWall).toBe(future);
 });
});
