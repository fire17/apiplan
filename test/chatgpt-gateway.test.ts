import {afterAll,beforeEach,describe,expect,test} from 'bun:test';
import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Isolated account home: nothing here touches ~/.apiplan, no browser is started, no site is reached.
// Set BEFORE importing any chatgpt module — accounts.ts reads CHATGPT_HOME at module load.
const TEST_HOME=join(tmpdir(),`apiplan-chatgpt-gateway-${process.pid}`);
process.env.CHATGPT_HOME=TEST_HOME;
afterAll(()=>rmSync(TEST_HOME,{recursive:true,force:true}));

const [{Gateway,BUILTIN_GATEWAY_POLICY,SHAREABLE_READS,scopeOfPath,shareableCall,policyFromDecider},{setFreeze},{DIRECT_READ_OPERATIONS},policyModule]=await Promise.all([
 import('../src/chatgpt/gateway.ts'),
 import('../src/chatgpt/freeze.ts'),
 import('../src/chatgpt/service.ts'),
 import('../src/chatgpt/gateway-policy.ts'),   // the config engine this runner is reconciled with
]);
type Decision=ReturnType<typeof BUILTIN_GATEWAY_POLICY.decide>;

const account={id:'gateway-test',label:'Gateway test',baseURL:'https://chatgpt.com',created:'2026-09-16T00:00:00.000Z',userId:'user-1',workspace:'w1',source:{provider:'managed' as const}};
const frozenAccount={...account,id:'gateway-frozen-test'};

/* ---- deterministic timeline: no test ever sleeps in real time -------------------------------- */
function timeline(start=1_780_000_000_000){
 let wall=start,mono=0;
 type Timer={at:number;fire:()=>void;signal?:AbortSignal};
 let timers:Timer[]=[];
 const clock={now:()=>wall,monotonic:()=>mono};
 const sleep=(ms:number,signal?:AbortSignal)=>new Promise<void>(resolve=>{
  const timer:Timer={at:mono+Math.max(0,ms),fire:resolve,signal};
  timers.push(timer);
  signal?.addEventListener('abort',()=>{timers=timers.filter(t=>t!==timer);resolve();},{once:true});
 });
 const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
 async function advance(ms:number){
  const target=mono+ms;
  await flush();
  for(;;){
   const due=timers.filter(t=>t.at<=target&&!t.signal?.aborted).sort((a,b)=>a.at-b.at)[0];
   if(!due)break;
   const step=due.at-mono;mono=due.at;wall+=step;
   timers=timers.filter(t=>t!==due);
   due.fire();
   await flush();
  }
  const rest=target-mono;mono=target;wall+=rest;
  await flush();
 }
 return {clock,sleep,advance,flush,pendingTimers:()=>timers.length};
}

/* ---- fake downstream: stands in for BrowserWorker.call, never launches anything --------------- */
function fakeWorker(){
 type Call={op:string;args:any;timeout:number;settle(value:any):void;fail(error:any):void};
 const calls:Call[]=[];
 let live=0,maxLive=0,closed=false;
 return {
  calls,maxLive:()=>maxLive,closed:()=>closed,
  ops:()=>calls.map(c=>c.op),
  paths:()=>calls.map(c=>String(c.args?.path??c.op)),
  call(op:string,args:any,timeout:number){
   live++;maxLive=Math.max(maxLive,live);
   return new Promise<any>((resolve,reject)=>{
    calls.push({op,args,timeout,settle:v=>{live--;resolve(v);},fail:e=>{live--;reject(e);}});
   });
  },
  async start(){},
  async close(){closed=true;},
  settleAll(value:any={status:200,body:{}}){for(const c of calls.splice(0))c.settle(value);},
 };
}

/** Policy overlay on the built-in (today's exact numbers). */
function policyOf(patch:(request:any,base:Decision)=>Partial<Decision>={}as any){
 return {decide(request:any):Decision{
  const base=BUILTIN_GATEWAY_POLICY.decide(request);
  return typeof patch==='function'?{...base,...patch(request,base)}:base;
 }};
}

function harness(options:{policy?:any;restore?:any;persist?:any;account?:any}={}){
 const t=timeline();
 const worker=fakeWorker();
 const events:any[]=[];
 const gateway=new Gateway({
  account:options.account??account,
  downstream:worker,
  policy:options.policy??policyOf(),
  clock:t.clock,sleep:t.sleep,
  emit:e=>events.push(e),
  ...(options.restore?{restore:options.restore}:{}),
  ...(options.persist?{persist:options.persist}:{}),
 });
 return {...t,worker,events,gateway,
  decisions:()=>events.filter(e=>e.type==='gateway.decision'),
  dispatched:()=>events.filter(e=>e.type==='gateway.dispatch')};
}

const GET=(path:string)=>({path,method:'GET'});
const swallow=(p:Promise<any>)=>{p.catch(()=>{});return p;};

let h:ReturnType<typeof harness>;
beforeEach(()=>{h=harness();});

/* ============================================================================================== */

describe('dedupe',()=>{
 test('identical concurrent reads collapse to exactly one downstream call',async()=>{
  const a=swallow(h.gateway.call('request',GET('/backend-api/conversations?offset=0')));
  const b=swallow(h.gateway.call('request',GET('/backend-api/conversations?offset=0')));
  await h.flush();
  expect(h.worker.calls.length).toBe(1);
  h.worker.calls[0].settle({status:200,body:{items:[1]}});
  await h.flush();
  expect((await a).body.items).toEqual([1]);
  expect((await b).body.items).toEqual([1]);
  expect(h.worker.calls.length).toBe(1);
  expect(h.decisions().map(d=>d.decision)).toEqual(['admitted','joined']);
 });

 test('a different query string is a different call and is never shared',async()=>{
  swallow(h.gateway.call('request',GET('/backend-api/conversations?offset=0')));
  swallow(h.gateway.call('request',GET('/backend-api/conversations?offset=28')));
  await h.flush();
  expect(h.worker.calls.length).toBe(1);        // concurrency 1: the second is queued, not merged
  h.worker.calls[0].settle({status:200,body:{}});
  await h.advance(1000);
  expect(h.worker.paths()).toEqual(['/backend-api/conversations?offset=0','/backend-api/conversations?offset=28']);
 });

 test('a joiner cannot mutate the leader result and gets its own error object',async()=>{
  const a=swallow(h.gateway.call('request',GET('/backend-api/conversations')));
  const b=swallow(h.gateway.call('request',GET('/backend-api/conversations')));
  await h.flush();
  h.worker.calls[0].settle({status:200,body:{n:1}});
  const [leader,joiner]=[await a,await b];
  joiner.body.n=99;joiner.injected=true;
  expect(leader.body.n).toBe(1);
  expect(leader.injected).toBeUndefined();

  const c=swallow(h.gateway.call('request',GET('/backend-api/gizmos/g1')));
  const d=swallow(h.gateway.call('request',GET('/backend-api/gizmos/g1')));
  await h.flush();
  h.worker.calls.at(-1)!.fail(Object.assign(new Error('ChatGPT GET /backend-api/gizmos/g1 returned 500: boom'),{status:500,requestId:'leader-req'}));
  const leaderError=await c.then(()=>null,e=>e);
  const joinerError=await d.then(()=>null,e=>e);
  expect(joinerError).not.toBe(leaderError);
  Object.assign(joinerError,{requestId:'joiner-req'});
  expect(leaderError.requestId).toBe('leader-req');
  expect(joinerError.status).toBe(500);
 });

 test('two identical writes never collapse: one call, one refusal',async()=>{
  const args={path:'/backend-api/conversation',method:'POST',body:{action:'next'}};
  const a=swallow(h.gateway.call('request',args));
  const b=swallow(h.gateway.call('request',args));
  await h.flush();
  expect(h.worker.calls.length).toBe(1);
  const error=await b.then(()=>null,e=>e);
  expect(error.code).toBe('GATEWAY_WRITE_IN_FLIGHT');
  expect(error.message).toBe('An identical write is already in flight for this account; no second submission was made.');
  expect(error.retryable).toBe(false);
  h.worker.calls[0].settle({status:200,body:{}});
  await a;
  expect(h.worker.calls.length).toBe(1);
 });

 test('a journalled UI write is never shareable even when its op looks like a read',()=>{
  expect(shareableCall('request',{path:'/x',method:'GET'})).toBe(true);
  expect(shareableCall('request',{path:'/x',method:'POST'})).toBe(false);
  expect(shareableCall('request',{path:'/x',method:'GET',binary:true})).toBe(false);
  expect(shareableCall('snapshot.evaluate',{})).toBe(false);
  expect(SHAREABLE_READS.has('snapshot.evaluate')).toBe(false);
  expect(shareableCall('action',{})).toBe(false);
 });
});

describe('pacing',()=>{
 test('conversation reads keep 5s spacing and everything else 1s, with no real sleeping',async()=>{
  const started=Date.now();
  swallow(h.gateway.call('request',GET('/backend-api/conversation/abc')));
  await h.flush();
  h.worker.calls[0].settle({status:200,body:{}});
  await h.flush();
  swallow(h.gateway.call('request',GET('/backend-api/conversation/def')));
  await h.advance(4999);
  expect(h.worker.calls.length).toBe(1);
  await h.advance(1);
  expect(h.worker.calls.length).toBe(2);
  h.worker.calls[1].settle({status:200,body:{}});
  await h.flush();

  swallow(h.gateway.call('request',GET('/backend-api/accounts/check')));
  await h.flush();
  expect(h.worker.calls.length).toBe(3);        // a different scope is not paced by the conversation lane
  h.worker.calls[2].settle({status:200,body:{}});
  await h.flush();
  swallow(h.gateway.call('request',GET('/backend-api/accounts/check?v=2')));
  await h.advance(999);
  expect(h.worker.calls.length).toBe(3);
  await h.advance(1);
  expect(h.worker.calls.length).toBe(4);
  expect(Date.now()-started).toBeLessThan(2000);   // ~6s of simulated pacing, no real time spent
 });

 test('scope normalisation matches the expression the service uses today',()=>{
  expect(scopeOfPath('/backend-api/conversation/abc?x=1')).toBe('/backend-api/conversation/{id}');
  expect(scopeOfPath('/backend-api/conversations?offset=0')).toBe('/backend-api/conversations');
 });

 test('token buckets start empty, so a fresh process never emits a boot burst',async()=>{
  const g=harness({policy:policyOf(()=>({bucket:{burst:3,refillPerMinute:60},spacingMs:0}))});
  swallow(g.gateway.call('request',GET('/backend-api/conversations')));
  await g.flush();
  expect(g.worker.calls.length).toBe(0);
  await g.advance(999);
  expect(g.worker.calls.length).toBe(0);
  await g.advance(1);
  expect(g.worker.calls.length).toBe(1);
 });

 test('concurrency 1 is honoured: the worker never sees two overlapping calls',async()=>{
  for(let i=0;i<6;i++)swallow(h.gateway.call('request',GET(`/backend-api/accounts/check?i=${i}`)));
  for(let i=0;i<6;i++){await h.advance(1000);h.worker.calls.at(-1)?.settle({status:200,body:{}});await h.flush();}
  expect(h.worker.maxLive()).toBe(1);
  expect(h.worker.calls.length).toBe(6);
 });

 test('an admitted call keeps the spacing it was admitted under when the policy changes underneath',async()=>{
  let spacing=5000;
  const g=harness({policy:policyOf(()=>({spacingMs:spacing}))});
  swallow(g.gateway.call('request',GET('/backend-api/conversations?p=1')));
  await g.flush();
  g.worker.calls[0].settle({status:200,body:{}});
  await g.flush();
  swallow(g.gateway.call('request',GET('/backend-api/conversations?p=2')));
  spacing=250;                                   // hot reload lands mid-queue
  await g.advance(4999);
  expect(g.worker.calls.length).toBe(1);
  await g.advance(1);
  expect(g.worker.calls.length).toBe(2);
 });
});

describe('rate limiting',()=>{
 test('a 429 with Retry-After larger than the floor parks exactly as long as it says',async()=>{
  const a=swallow(h.gateway.call('request',GET('/backend-api/conversation/abc')));
  await h.flush();
  h.worker.calls[0].settle({status:429,retryAfter:'120'});
  await a;
  swallow(h.gateway.call('request',GET('/backend-api/conversation/xyz')));
  await h.advance(119_999);
  expect(h.worker.calls.length).toBe(1);
  await h.advance(1);
  expect(h.worker.calls.length).toBe(2);
  const limit=h.events.find(e=>e.type==='rate.limit');
  expect(limit).toMatchObject({scope:'/backend-api/conversation/{id}',retryAfterMs:120000,failures:1});
 });

 test("retryAfter 'max' keeps today's 60s floor when the site asks for less",async()=>{
  const a=swallow(h.gateway.call('request',GET('/backend-api/conversation/abc')));
  await h.flush();
  h.worker.calls[0].settle({status:429,retryAfter:'30'});
  await a;
  swallow(h.gateway.call('request',GET('/backend-api/conversation/xyz')));
  await h.advance(59_999);
  expect(h.worker.calls.length).toBe(1);
  await h.advance(1);
  expect(h.worker.calls.length).toBe(2);
 });

 test("retryAfter 'site' obeys Retry-After verbatim — protocol changed by config, not code",async()=>{
  const g=harness({policy:policyOf((_r,base)=>({backoff:{...base.backoff,retryAfter:'site' as const}}))});
  const a=swallow(g.gateway.call('request',GET('/backend-api/conversation/abc')));
  await g.flush();
  g.worker.calls[0].settle({status:429,retryAfter:'30'});
  await a;
  swallow(g.gateway.call('request',GET('/backend-api/conversation/xyz')));
  await g.advance(29_999);
  expect(g.worker.calls.length).toBe(1);
  await g.advance(1);
  expect(g.worker.calls.length).toBe(2);
 });

 test('backoff escalates toward the 15 minute ceiling and never past it',async()=>{
  const g=harness();
  const failures:number[]=[];
  for(let i=0;i<8;i++){
   const call=swallow(g.gateway.call('request',GET(`/backend-api/conversation/c${i}`)));
   await g.advance(900_000);                     // ride out the open breaker between attempts
   g.worker.calls.at(-1)!.settle({status:429});
   await call;
  }
  for(const e of g.events.filter(e=>e.type==='rate.limit'))failures.push(e.retryAfterMs);
  expect(failures.slice(0,5)).toEqual([60000,120000,240000,480000,900000]);
  expect(failures.every(ms=>ms<=900000)).toBe(true);
 });

 test('a restart does not clear an open breaker',async()=>{
  let saved:any={};
  const first=harness({persist:(s:any)=>{saved=s;}});
  const a=swallow(first.gateway.call('request',GET('/backend-api/conversation/abc')));
  await first.flush();
  first.worker.calls[0].settle({status:429,retryAfter:'300'});
  await a;
  expect(saved['/backend-api/conversation/{id}'].openUntilWall).toBeGreaterThan(0);

  const second=harness({restore:()=>saved});
  swallow(second.gateway.call('request',GET('/backend-api/conversation/abc')));
  await second.advance(299_999);
  expect(second.worker.calls.length).toBe(0);    // a restart is not a way to clear a rate limit
  await second.advance(1);
  expect(second.worker.calls.length).toBe(1);
 });

 test('background sheds on its own scope while another scope keeps flowing',async()=>{
  const g=harness({policy:policyOf((request:any)=>({
   shedWhileLimited:String(request.args?.path??'').startsWith('/backend-api/conversation/'),
  }))});
  const first=swallow(g.gateway.call('request',GET('/backend-api/conversation/a')));
  await g.flush();
  const shed=swallow(g.gateway.call('request',GET('/backend-api/conversation/b')));
  const other=swallow(g.gateway.call('request',GET('/backend-api/accounts/check')));
  g.worker.calls[0].settle({status:429,retryAfter:'600'});
  await g.flush();
  const error=await shed.then(()=>null,e=>e);
  expect(error.code).toBe('RATE_LIMITED');
  expect(error.retryable).toBe(true);
  expect(g.events.some(e=>e.type==='gateway.shed')).toBe(true);
  await g.advance(1000);
  // the shed item never reached the worker; the unrelated scope did
  expect(g.worker.paths()).toEqual(['/backend-api/conversation/a','/backend-api/accounts/check']);
  g.worker.calls.at(-1)!.settle({status:200,body:{}});
  await g.flush();
  await expect(other).resolves.toMatchObject({status:200});
  await first;
 });
});

describe('priority',()=>{
 test('interactive work is never starved by a bulk crawl',async()=>{
  const g=harness({policy:policyOf((request:any)=>({spacingMs:0,
   ...(request.meta?.priority==='interactive'?{}:{class:'background' as const,rank:2}),
  }))});
  const held=swallow(g.gateway.call('request',GET('/backend-api/conversation/warm')));
  await g.flush();
  expect(g.worker.calls.length).toBe(1);         // the slot is busy; everything below queues
  for(let i=0;i<50;i++)swallow(g.gateway.call('request',GET(`/backend-api/conversation/bulk-${i}`)));
  swallow(g.gateway.call('request',GET('/backend-api/conversation/live'),undefined,{priority:'interactive'}));
  g.worker.calls[0].settle({status:200,body:{}});
  await g.flush();
  expect(g.worker.paths()[1]).toBe('/backend-api/conversation/live');
  await held;
 });

 test('an interactive joiner promotes the queued background read it joins',async()=>{
  const g=harness({policy:policyOf((request:any)=>({spacingMs:0,
   ...(request.meta?.priority==='interactive'?{class:'interactive' as const,rank:0}:{class:'background' as const,rank:2}),
  }))});
  const held=swallow(g.gateway.call('request',GET('/backend-api/conversation/warm')));
  await g.flush();
  swallow(g.gateway.call('request',GET('/backend-api/conversation/first')));
  swallow(g.gateway.call('request',GET('/backend-api/conversation/second')));
  swallow(g.gateway.call('request',GET('/backend-api/conversation/second'),undefined,{priority:'interactive'}));
  g.worker.calls[0].settle({status:200,body:{}});
  await g.flush();
  expect(g.worker.paths()[1]).toBe('/backend-api/conversation/second');
  await held;
 });

 test('aging promotes an old background waiter without ever letting it overtake typing',async()=>{
  const g=harness({policy:policyOf((request:any)=>({spacingMs:0,agingMs:60000,
   ...(request.meta?.priority==='interactive'?{class:'interactive' as const,rank:0}:{class:'background' as const,rank:2}),
  }))});
  const held=swallow(g.gateway.call('request',GET('/backend-api/conversation/warm')));
  await g.flush();
  swallow(g.gateway.call('request',GET('/backend-api/conversation/old')));
  await g.advance(120_000);
  swallow(g.gateway.call('request',GET('/backend-api/conversation/live'),undefined,{priority:'interactive'}));
  g.worker.calls[0].settle({status:200,body:{}});
  await g.flush();
  expect(g.worker.paths()[1]).toBe('/backend-api/conversation/live');
  await held;
 });

 test('the queue is bounded and overflow drops the newest low-priority waiter',async()=>{
  const g=harness({policy:policyOf(()=>({queueDepth:4,spacingMs:0}))});
  const held=swallow(g.gateway.call('request',GET('/backend-api/conversation/warm')));
  await g.flush();
  const results=[] as Promise<any>[];
  for(let i=0;i<10;i++)results.push(swallow(g.gateway.call('request',GET(`/backend-api/conversation/q${i}`))));
  await g.flush();
  expect(g.gateway.stats().queued).toBe(4);
  g.worker.calls[0].settle({status:200,body:{}});
  for(let i=0;i<4;i++){await g.flush();g.worker.calls.at(-1)!.settle({status:200,body:{}});}
  await g.flush();
  const codes=await Promise.all(results.map(p=>p.then(()=>'ok',(e:any)=>e.code)));
  expect(codes.filter(c=>c==='GATEWAY_QUEUE_FULL').length).toBe(6);
  expect(codes.filter(c=>c==='ok').length).toBe(4);
  expect(g.worker.paths().slice(1)).toEqual(['/backend-api/conversation/q0','/backend-api/conversation/q1','/backend-api/conversation/q2','/backend-api/conversation/q3']);
  await held;
 });
});

describe('cancellation',()=>{
 test('cancelling mid-wait leaves nothing queued and never reaches the worker',async()=>{
  const held=swallow(h.gateway.call('request',GET('/backend-api/conversation/warm')));
  await h.flush();
  const controller=new AbortController();
  const cancelled=swallow(h.gateway.call('request',GET('/backend-api/conversation/target'),undefined,{signal:controller.signal}));
  expect(h.gateway.stats().queued).toBe(1);
  controller.abort();
  const error=await cancelled.then(()=>null,e=>e);
  expect(error.code).toBe('GATEWAY_CANCELLED');
  expect(error.message).toBe('The caller cancelled before the request reached the browser; no request was sent.');
  expect(h.gateway.stats()).toMatchObject({queued:0,inflight:1});
  h.worker.calls[0].settle({status:200,body:{}});
  await held;
  await h.advance(60_000);
  expect(h.worker.calls.length).toBe(1);         // nothing orphaned: the cancelled call never dispatched
  expect(h.gateway.stats()).toMatchObject({queued:0,running:0,inflight:0});
 });

 test('an already aborted signal is refused without ever queueing',async()=>{
  const controller=new AbortController();controller.abort();
  const error=await swallow(h.gateway.call('request',GET('/backend-api/conversations'),undefined,{signal:controller.signal})).then(()=>null,e=>e);
  expect(error.code).toBe('GATEWAY_CANCELLED');
  await h.advance(10_000);
  expect(h.worker.calls.length).toBe(0);
 });

 test('a cancelled joiner detaches without disturbing the leader',async()=>{
  const leader=swallow(h.gateway.call('request',GET('/backend-api/conversations')));
  const controller=new AbortController();
  const joiner=swallow(h.gateway.call('request',GET('/backend-api/conversations'),undefined,{signal:controller.signal}));
  await h.flush();
  controller.abort();
  expect((await joiner.then(()=>null,e=>e)).code).toBe('GATEWAY_CANCELLED');
  h.worker.calls[0].settle({status:200,body:{ok:true}});
  await expect(leader).resolves.toMatchObject({body:{ok:true}});
  expect(h.worker.calls.length).toBe(1);
 });

 test('close rejects queued work and closes the worker',async()=>{
  const held=swallow(h.gateway.call('request',GET('/backend-api/conversation/warm')));
  await h.flush();
  const queued=swallow(h.gateway.call('request',GET('/backend-api/conversation/next')));
  await h.gateway.close();
  expect((await queued.then(()=>null,e=>e)).message).toBe('Browser worker is closing.');
  expect(h.worker.closed()).toBe(true);
  h.worker.calls[0].settle({status:200,body:{}});
  await held;
  const after=await swallow(h.gateway.call('request',GET('/backend-api/conversations'))).then(()=>null,e=>e);
  expect(after.code).toBe('GATEWAY_CLOSING');
 });
});

describe('refusals never reach downstream',()=>{
 test('a policy refusal is immediate, typed, and makes no call',async()=>{
  const g=harness({policy:policyOf(()=>({permission:'refuse' as const,refusal:{code:'GATEWAY_FORBIDDEN',message:'takeout.run is forbidden by the active gateway profile; no request was sent.',action:'Switch activeProfile before retrying.',retryable:false}}))});
  const error=await swallow(g.gateway.call('request',GET('/backend-api/conversations'))).then(()=>null,e=>e);
  expect(error.code).toBe('GATEWAY_FORBIDDEN');
  expect(error.retryable).toBe(false);
  await g.advance(60_000);
  expect(g.worker.calls.length).toBe(0);
  expect(g.decisions()).toEqual([expect.objectContaining({decision:'refused',code:'GATEWAY_FORBIDDEN'})]);
 });

 test('a frozen account refuses at admission and at the dispatch boundary',async()=>{
  const g=harness({account:frozenAccount});
  const held=swallow(g.gateway.call('request',GET('/backend-api/conversation/warm')));
  await g.flush();
  const queued=Array.from({length:20},(_,i)=>swallow(g.gateway.call('request',GET(`/backend-api/conversation/q${i}`))));
  setFreeze(frozenAccount,true,{by:'test',reason:'rate limits'});
  try{
   const admitted=await swallow(g.gateway.call('request',GET('/backend-api/conversations'))).then(()=>null,e=>e);
   expect(admitted.code).toBe('FROZEN');
   expect(admitted.message.endsWith('no request was sent (request).')).toBe(true);
   g.worker.calls[0].settle({status:200,body:{}});
   await held;
   await g.advance(600_000);
   for(const p of queued)expect((await p.then(()=>null,(e:any)=>e.code))).toBe('FROZEN');
   expect(g.worker.calls.length).toBe(1);        // only the call admitted before the freeze ever ran
  }finally{setFreeze(frozenAccount,false,{by:'test'});}
 });

 test('an unknown outcome poisons the key and blocks every later replay',async()=>{
  const args={path:'/backend-api/conversation',method:'POST',body:{message:'hi'}};
  const first=swallow(h.gateway.call('request',args));
  await h.flush();
  h.worker.calls[0].fail(Object.assign(new Error('Browser request timed out.'),{requestId:'req-1'}));
  expect((await first.then(()=>null,e=>e)).message).toBe('Browser request timed out.');
  const before=h.worker.calls.length;
  const second=await swallow(h.gateway.call('request',args)).then(()=>null,e=>e);
  expect(second.code).toBe('NEEDS_RECONCILIATION');
  expect(second.retryable).toBe(false);
  expect(second.priorRequestId).toBe('req-1');
  await h.advance(900_000);
  expect(h.worker.calls.length).toBe(before);    // nothing was replayed
  expect(h.gateway.reconcile(h.events.find(e=>e.type==='gateway.poisoned').key)).toBe(true);
 });

 test('every admission emits exactly one structured decision event',async()=>{
  swallow(h.gateway.call('request',GET('/backend-api/conversations')));
  swallow(h.gateway.call('request',GET('/backend-api/conversations')));
  swallow(h.gateway.call('request',{path:'/backend-api/conversation',method:'POST',body:{a:1}}));
  swallow(h.gateway.call('request',{path:'/backend-api/conversation',method:'POST',body:{a:1}}));
  await h.flush();
  expect(h.decisions().map(d=>d.decision)).toEqual(['admitted','joined','admitted','refused']);
  for(const d of h.decisions())expect(typeof d.op).toBe('string');
  expect(h.dispatched()[0]).toMatchObject({op:'request',scope:'/backend-api/conversations'});
 });

 test('direct mode still carries no site-bound operation',()=>{
  expect([...DIRECT_READ_OPERATIONS].sort()).toEqual([
   'adapter.get','adapter.validate','capabilities.list','conversations.cached','conversations.search',
   'flow.status','flow.validate','freeze.set','freeze.status','invoices.watcher','map.capabilities',
   'monitor.events','online.list','online.status','receipts.get','receipts.list','takeout.audit',
   'takeout.status','takeout.watch-status',
  ]);
 });
});

describe('window caps',()=>{
 test('a sliding window caps a burst that per-call spacing alone would have let through',async()=>{
  // The incident shape: 11 requests, each individually paced, none of them counted.
  const g=harness({policy:policyOf(()=>({spacingMs:1000,window:{maxRequests:3,intervalMs:60000}}))});
  const sent:Promise<any>[]=[];
  for(let i=0;i<6;i++)sent.push(swallow(g.gateway.call('request',GET(`/backend-api/conversations?p=${i}`))));
  for(let i=0;i<6;i++){await g.advance(1000);g.worker.calls.at(-1)?.settle({status:200,body:{}});await g.flush();}
  expect(g.worker.calls.length).toBe(3);         // spacing alone would have sent all six
  await g.advance(57_000);
  expect(g.worker.calls.length).toBe(4);         // the window slid at t=60s, exactly one more went
  g.worker.calls.at(-1)?.settle({status:200,body:{}});
  await g.flush();
  expect(g.worker.calls.length).toBe(5);         // and the next one follows the window, not the spacing
  await g.gateway.close();                       // drains the still-queued sixth
  for(const call of g.worker.calls)call.settle({status:200,body:{}});
  await g.flush();
  await Promise.all(sent.map(p=>p.catch(()=>null)));
 });
});

describe('reconciliation with gateway-policy.ts',()=>{
 const loaded=()=>policyModule.loadGatewayPolicy(account.id,()=>null);   // no file on disk: built-in config

 test("the policy module's built-in config reproduces today's 5s/1s spacing through this runner",async()=>{
  expect(loaded().status).toBe('builtin');
  const g=harness({policy:policyFromDecider(policyModule.decide,loaded())});
  swallow(g.gateway.call('request',GET('/backend-api/conversation/abc')));
  await g.flush();
  g.worker.calls[0].settle({status:200,body:{}});
  await g.flush();
  swallow(g.gateway.call('request',GET('/backend-api/conversation/def')));
  await g.advance(4999);
  expect(g.worker.calls.length).toBe(1);
  await g.advance(1);
  expect(g.worker.calls.length).toBe(2);
  g.worker.calls[1].settle({status:200,body:{}});
  await g.flush();
  swallow(g.gateway.call('request',GET('/backend-api/conversations')));
  await g.flush();
  g.worker.calls[2].settle({status:200,body:{}});
  await g.flush();
  swallow(g.gateway.call('request',GET('/backend-api/conversations?offset=28')));
  await g.advance(999);
  expect(g.worker.calls.length).toBe(3);
  await g.advance(1);
  expect(g.worker.calls.length).toBe(4);
 });

 test('a GET read stays shareable even though the config engine classifies the worker op as write',async()=>{
  const g=harness({policy:policyFromDecider(policyModule.decide,loaded())});
  const a=swallow(g.gateway.call('request',GET('/backend-api/conversations')));
  const b=swallow(g.gateway.call('request',GET('/backend-api/conversations')));
  await g.flush();
  expect(g.worker.calls.length).toBe(1);
  g.worker.calls[0].settle({status:200,body:{ok:true}});
  await expect(a).resolves.toMatchObject({body:{ok:true}});
  await expect(b).resolves.toMatchObject({body:{ok:true}});
  const post={path:'/backend-api/conversation',method:'POST',body:{a:1}};
  swallow(g.gateway.call('request',post));
  const refused=await swallow(g.gateway.call('request',post)).then(()=>null,e=>e);
  expect(refused.code).toBe('GATEWAY_WRITE_IN_FLIGHT');
  await g.gateway.close();
 });

 test('a forbidding profile refuses through the adapter and never reaches the worker',async()=>{
  const file=JSON.stringify({...policyModule.BUILTIN_GATEWAY,activeProfile:'locked',
   profiles:{normal:{},locked:{forbid:['request']}}});
  const locked=policyModule.loadGatewayPolicy(account.id,()=>file);
  expect(locked.status).toBe('loaded');
  const g=harness({policy:policyFromDecider(policyModule.decide,locked)});
  const error=await swallow(g.gateway.call('request',GET('/backend-api/conversations'))).then(()=>null,e=>e);
  expect(error.code).toBe('GATEWAY_FORBIDDEN');
  await g.advance(60_000);
  expect(g.worker.calls.length).toBe(0);
 });

 test('an unparseable config fails closed: every site-bound call is refused, none is sent',async()=>{
  const broken=policyModule.loadGatewayPolicy(account.id,()=>'{not json');
  expect(broken.status).toBe('invalid');
  const g=harness({policy:policyFromDecider(policyModule.decide,broken)});
  const error=await swallow(g.gateway.call('request',GET('/backend-api/conversations'))).then(()=>null,e=>e);
  expect(error.code).toBe('GATEWAY_CONFIG_INVALID');
  expect(error.retryable).toBe(false);
  await g.advance(60_000);
  expect(g.worker.calls.length).toBe(0);
 });
});
