import {createHash} from 'node:crypto';
import {isFrozen,allowedWhileFrozen,frozenError} from './freeze.ts';
import {shouldJournal} from './receipts.ts';
import {classifyError} from './monitor.ts';
import type {Account} from './accounts.ts';
// Types only: erased at runtime, so this file never loads the policy module and the two can land
// independently. The runtime `decide` function is injected (see policyFromDecider below).
import type {Decision as PolicyDecision,LoadedGatewayPolicy,OperationKind as PolicyOperationKind} from './gateway-policy.ts';

/**
 * The one deduped access point for a ChatGPT account's site traffic.
 *
 * Born from the 2026-09-15 19:51 incident ("STOP EVERYTHING IMMEDIATELY"): a bulk archive crawl drew
 * five 429s on /backend-api/conversation/{id} and there was no single place to stop or pace traffic,
 * so the recovery was `kill -STOP` on six processes.
 *
 * It WRAPS one downstream caller (in production `BrowserWorker.call`); it never replaces it. The
 * freeze gate inside transport.ts stays the last line of defence below this class, so a bug here
 * cannot remove the stop switch, and a caller that somehow bypasses the gateway still hits freeze.
 *
 * Everything that varies is injected — clock, sleep, downstream, policy, emitter, breaker
 * persistence — so the protocol changes with a config file and never with code, and so every test is
 * deterministic and none of them sleeps in real time.
 *
 * What it owns: admission (dedupe, refusal), ordering (priority + aging), pacing (per-scope spacing,
 * optional token buckets), the per-scope circuit breaker, and cancellation. What it must never own:
 * durable idempotency. `online-runtime.ts` (api-<40hex> + active.lock) and `receipts.ts`
 * (OperationJournal exclusive-create) are the only components allowed to decide that a write already
 * happened; the gateway's dedupe answers only "is an identical call happening RIGHT NOW".
 */

/* ------------------------------------------------------------------------------------------------
 * Decision shape.
 *
 * RECONCILED with src/chatgpt/gateway-policy.ts (owned by another agent in this run). That module is
 * the pure CONFIG engine: `decide(loaded,request)` resolves gateway.json into permission, kind,
 * scope, rate, concurrency, timeout, backoff and an active-429 deadline. It deliberately carries no
 * SCHEDULING state — no class/rank, no dedupe caps, no queue depth, no aging, no shed flag — because
 * those are properties of the runner, not of the file on disk.
 *
 * `GatewayDecision` below is that runner contract: the config engine's output plus the scheduling
 * fields. `policyFromDecider()` maps one onto the other, so the coordinator needs no glue code:
 *
 *   new Gateway({..., policy: policyFromDecider(decide, loadGatewayPolicy(account.id, read))})
 *
 * Remaining gap for the coordinator: the scheduling fields have no config section yet. They come
 * from SCHEDULING_DEFAULTS here until gateway.json grows one; adding it must not change the meaning
 * of any field the policy module already owns.
 * ---------------------------------------------------------------------------------------------- */

/** Traffic class of an operation; drives scheduling only, never identity. Same union as the policy module. */
export type OperationKind=PolicyOperationKind;
/** Scheduling class. `interactive` is his live typing and must never queue behind a crawl. */
export type GatewayClass='interactive'|'write'|'background';

export interface GatewayBucket{
 /** Calls that may ignore spacing after an idle period. The entire burst allowance in the system. */
 burst:number;
 /** Token refill rate. Tokens start at ZERO on construction: a crash loop must not emit a burst per boot. */
 refillPerMinute:number;
}

export interface GatewayBackoff{
 /** First penalty on a 429 with no usable Retry-After. Today: 60000 (service.ts:41). */
 baseMs:number;
 /** Exponent base. Today: 2. */
 factor:number;
 /** Exponent cap. Today: Math.min(rateFailures-1,4). */
 maxExponent:number;
 /** Hard ceiling on one penalty. Today: 900000. Also clamps a wall-clock jump (hazard H7). */
 ceilingMs:number;
 /** 'max' = today's Math.max(computed,retryAfter): the site may extend the wait, never shorten it.
  *  'site' = obey Retry-After verbatim. */
 retryAfter:'max'|'site';
 /** Retry-After above this is clamped and reported. */
 retryAfterCeilingMs:number;
 /** Quiet period after which a scope's failure counter resets. Today: 900000 (service.ts:43). */
 recoveryMs:number;
}

export interface GatewayRefusal{code:string;message:string;action:string;retryable:boolean;retryAfterMs?:number}

export interface GatewayDecision{
 /** 'refuse' never reaches downstream and never enters the queue. */
 permission:'allow'|'refuse';
 refusal?:GatewayRefusal;
 kind:OperationKind;
 class:GatewayClass;
 /** Lower runs first. 0 interactive, 1 write, 2 background. */
 rank:number;
 /** Normalised pacing/breaker key, e.g. '/backend-api/conversation/{id}'. */
 scope:string;
 /** May this call share an in-flight identical call? The gateway re-checks the read allowlist itself. */
 shareable:boolean;
 /** Minimum gap between two dispatches in this scope. */
 spacingMs:number;
 /** Sliding-window cap for this scope: at most `maxRequests` dispatches per `intervalMs`. Spacing
  *  alone is what let 11 requests reach the site during the 19:51 incident — each individually paced,
  *  none of them counted. Absent here (today's behaviour) means spacing-only. */
 window?:{maxRequests:number;intervalMs:number};
 /** Wall-clock instant this call must not be dispatched before — an active 429 penalty recovered
  *  from request-state.json by the policy engine. Data, never a sleep. */
 notBeforeWall?:number;
 /** Where the gap is measured from. 'start' reproduces today exactly (service.ts:37 sets
  *  nextRequestAt BEFORE the await); 'settle' fixes contradiction 4 for long binary transfers. */
 spacingFrom?:'start'|'settle';
 /** Worker call timeout handed to downstream. */
 timeoutMs:number;
 /** Max downstream calls in flight across the account. Today: 1 (the service.ts:36 promise chain). */
 concurrency:number;
 /** Max concurrent generations. Today: 1 (`this.busy`, service.ts:97). */
 generationConcurrency:number;
 /** A call that can hold the slot for minutes (binary transfer, generation). It is admitted only
  *  when no interactive waiter is queued — hazard H13 with concurrency 1. */
 longRunning?:boolean;
 /** Ready-queue cap. Overflow drops the lowest-priority, NEWEST waiter. */
 queueDepth:number;
 /** A waiter older than this is promoted one rank, never to rank 0. Bounds background starvation. */
 agingMs:number;
 /** Cap on joiners sharing one in-flight read. */
 maxJoiners:number;
 /** Age past which a still-running entry is reported stale and refuses NEW joiners. It is never
  *  evicted: evicting would let a second identical write go out. */
 staleAfterMs:number;
 /** Shed this call (instead of holding it for up to 15 minutes) when its scope trips a 429. */
 shedWhileLimited?:boolean;
 bucket?:GatewayBucket;
 backoff:GatewayBackoff;
}

export interface GatewayMeta{priority?:GatewayClass;signal?:AbortSignal;requestId?:string;[k:string]:any}
export interface GatewayPolicyRequest{account:Account;op:string;args:any;timeout?:number;meta?:GatewayMeta}
export interface GatewayPolicy{decide(request:GatewayPolicyRequest):GatewayDecision}

export interface GatewayDownstream{
 call(op:string,args:any,timeout:number):Promise<any>;
 start?(headless?:boolean):Promise<any>;
 close?():Promise<any>;
}
export interface GatewayClock{now():number;monotonic():number}
export type GatewayBreakerState={openUntilWall:number;failures:number;lastAtWall:number};

export interface GatewayDeps{
 account:Account;
 downstream:GatewayDownstream;
 policy:GatewayPolicy;
 clock:GatewayClock;
 /** Resolves after `ms`, or early when `signal` aborts. Rejection on abort is tolerated. */
 sleep(ms:number,signal?:AbortSignal):Promise<void>;
 /** One structured event per decision, plus lifecycle events. Wired to monitor.recordEvent by the
  *  caller so this module imports nothing stateful and never writes to the account directory. */
 emit(event:any):void;
 /** Breaker state recovered at construction. A restart is NOT a way to clear a rate limit. */
 restore?():Record<string,GatewayBreakerState>;
 /** Called on every trip. The caller owns request-state.json; two writers to one file is a race. */
 persist?(scopes:Record<string,GatewayBreakerState>):void;
}

/* ------------------------------------------------------------------------------------------------
 * Built-in policy: byte-equal to today's hardcoded behaviour, so a machine with no config file
 * behaves exactly as the shipped code does.
 * ---------------------------------------------------------------------------------------------- */

/** Ops whose RESULT two callers may share. Membership is decided by what the operation PERMITS,
 *  never by what its caller intends — the same doctrine, and the same reason, as FROZEN_ALLOWED_OPS.
 *  `snapshot.evaluate` is deliberately absent: it runs caller-supplied source in the page. */
export const SHAREABLE_READS=new Set(['request','snapshot','status','network','request.info']);

export const BUILTIN_BACKOFF:GatewayBackoff={baseMs:60000,factor:2,maxExponent:4,ceilingMs:900000,retryAfter:'max',retryAfterCeilingMs:900000,recoveryMs:900000};

const CONVERSATION_PATH=/^\/backend-api\/conversation\//;
/** The exact expression at service.ts:41. Segment-normalised, no config-supplied regex (ReDoS). */
export function scopeOfPath(path:string){return String(path||'').split('?')[0].replace(/\/conversation\/[^/]+$/,'/conversation/{id}');}

export function shareableCall(op:string,args:any={}){
 if(!SHAREABLE_READS.has(op))return false;
 if(shouldJournal(op))return false;
 if(op==='request'&&String(args?.method??'GET').toUpperCase()!=='GET')return false;
 if(op==='request'&&args?.binary===true)return false;               // writes bytes into transfers/ then unlinks them; two sharers race that unlink
 return true;
}

const RANK:Record<GatewayClass,number>={interactive:0,write:1,background:2};

/** Today's numbers, exactly. Non-`request` ops are UNPACED here because they are unpaced today
 *  (contradiction 5: only service.request() is limited). They still pass through admission, the
 *  freeze gate, dedupe and the concurrency slot; a config may add spacing without a code change. */
export const BUILTIN_GATEWAY_POLICY:GatewayPolicy={
 decide({op,args={},timeout,meta}){
  const request=op==='request';
  const path=request?String(args?.path??''):'';
  const method=request?String(args?.method??'GET').toUpperCase():'';
  const binary=request&&args?.binary===true;
  const write=shouldJournal(op)||op==='action'||op==='upload'||(request&&method!=='GET');
  const priority=meta?.priority;
  const cls:GatewayClass=priority==='interactive'&&!write?'interactive':write?'write':'background';
  const kind:OperationKind=write?'write':'read';
  return {
   permission:'allow',
   kind,class:cls,rank:RANK[cls],
   scope:request?scopeOfPath(path):`op:${op}`,
   shareable:shareableCall(op,args),
   spacingMs:request?(CONVERSATION_PATH.test(path)?5000:1000):0,
   spacingFrom:'start',
   timeoutMs:timeout??(binary?600000:45000),
   concurrency:1,generationConcurrency:1,
   longRunning:binary,
   queueDepth:2000,agingMs:60000,maxJoiners:64,staleAfterMs:30000,
   shedWhileLimited:false,
   backoff:BUILTIN_BACKOFF,
  };
 },
};

/** Scheduling fields gateway.json does not describe yet. */
export const SCHEDULING_DEFAULTS={queueDepth:2000,agingMs:60000,maxJoiners:64,staleAfterMs:30000,spacingFrom:'start' as const};

/** The shape of `decide` exported by gateway-policy.ts, taken as a parameter so this module never
 *  imports that one at runtime and the two files can land, and be tested, independently. */
export type PolicyDecider=(loaded:LoadedGatewayPolicy,request:{op:string;args?:any;layer?:'service'|'worker';path?:string;method?:string;frozen?:boolean;state?:{rateLimitedUntil?:number;limitedScope?:string};now?:number})=>PolicyDecision;

/**
 * Bridge the config engine to the runner. The split is deliberate:
 *
 *  - gateway-policy.ts decides WHETHER and HOW FAST from the file on disk — permission, scope,
 *    spacing, window, concurrency, backoff, and any active 429 deadline. It is the config vocabulary.
 *  - this adapter decides WHAT KIND OF TRAFFIC this is from the op and its args — scheduling class,
 *    shareability, shed eligibility, long-running-ness. Those are properties of the worker-layer
 *    operation ('request', 'snapshot', 'action'), not of a service verb name, and membership is
 *    decided by what the operation PERMITS, never by what its caller intends.
 *
 * The caller's explicit timeout wins at the worker layer: service.ts already passes 45000 / 600000
 * per call, and a config timeout for a service verb does not describe one worker round trip.
 */
export function policyFromDecider(decide:PolicyDecider,loaded:LoadedGatewayPolicy,options:{layer?:'service'|'worker';state?:()=>{rateLimitedUntil?:number;limitedScope?:string};scheduling?:Partial<typeof SCHEDULING_DEFAULTS>}={}):GatewayPolicy{
 const scheduling={...SCHEDULING_DEFAULTS,...options.scheduling};
 return {decide(request){
  const {op,args={},timeout,meta}=request;
  const isRequest=op==='request';
  const path=isRequest?String(args?.path??''):undefined;
  const method=isRequest?String(args?.method??'GET').toUpperCase():undefined;
  const decision=decide(loaded,{op,args,layer:options.layer??'worker',...(path?{path}:{}),...(method?{method}:{}),...(options.state?{state:options.state()}:{})});
  const shareable=shareableCall(op,args);
  const write=!shareable||decision.kind==='write';
  const cls:GatewayClass=decision.kind==='generation'?'interactive'
   :meta?.priority==='interactive'&&!write?'interactive'
   :write?'write':'background';
  const refusal=decision.error??{code:'GATEWAY_FORBIDDEN',message:`${op} is refused by the active gateway profile (${decision.profile}); no request was sent.`,action:`Inspect ${decision.configPath} in gateway.json, then retry.`,retryable:false as const};
  return {
   permission:decision.outcome==='allow'?'allow':'refuse',
   ...(decision.outcome==='allow'?{}:{refusal:{...refusal,retryable:false}}),
   kind:decision.kind,class:cls,rank:RANK[cls],
   scope:decision.scope,
   shareable,
   spacingMs:decision.rate.minSpacingMs,
   ...(decision.rate.maxRequests!==undefined&&decision.rate.intervalMs!==undefined?{window:{maxRequests:decision.rate.maxRequests,intervalMs:decision.rate.intervalMs}}:{}),
   ...(decision.rate.burst&&decision.rate.burst>0?{bucket:{burst:decision.rate.burst,refillPerMinute:60000/Math.max(1,decision.rate.minSpacingMs)}}:{}),
   spacingFrom:scheduling.spacingFrom,
   timeoutMs:timeout??decision.timeoutMs,
   concurrency:Math.min(decision.concurrency.global,decision.concurrency.scope),
   generationConcurrency:decision.concurrency.generation,
   longRunning:args?.binary===true||(timeout??decision.timeoutMs)>=600000,
   queueDepth:scheduling.queueDepth,agingMs:scheduling.agingMs,maxJoiners:scheduling.maxJoiners,staleAfterMs:scheduling.staleAfterMs,
   shedWhileLimited:cls==='background'&&shareable,
   ...(decision.notBeforeMs?{notBeforeWall:decision.notBeforeMs}:{}),
   backoff:decision.backoff,
  };
 }};
}

/* ------------------------------------------------------------------------------------------------ */

type Waiter={
 seq:number;rank:number;cls:GatewayClass;
 resolve(value:any):void;reject(error:any):void;
 settled:boolean;detach?:()=>void;
};
type Entry={
 key:string;op:string;args:any;timeout:number;decision:GatewayDecision;scope:string;shareable:boolean;
 waiters:Waiter[];admittedMono:number;startedMono:number;started:boolean;stale:boolean;
};

const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical)
 :v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])]))
 :v;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Per-caller plumbing, never part of a request's identity (matches receipts.ts argsFingerprint). */
const IDENTITY_EXCLUDED=new Set(['requestId','_signal','signal','timeout','directory','emit','meta','priority']);

function refuse(code:string,message:string,action:string,extra:Record<string,any>={}){
 return Object.assign(new Error(message),{code,retryable:false,action,...extra});
}

export class Gateway{
 private inflight=new Map<string,Entry>();
 private poisoned=new Map<string,{code:string;at:number;requestId?:string}>();
 private ready:Entry[]=[];
 private buckets=new Map<GatewayClass,{tokens:number;lastRefillMono:number}>();
 private spacing=new Map<string,number>();
 private windows=new Map<string,number[]>();
 private breaker=new Map<string,GatewayBreakerState>();
 private running=0;
 private runningGenerations=0;
 private seq=0;
 private draining=false;
 private wakeAt?:number;
 private wakeAbort?:AbortController;

 constructor(private deps:GatewayDeps){
  const restored=deps.restore?.()??{};
  for(const [scope,state] of Object.entries(restored))
   this.breaker.set(scope,{openUntilWall:Number(state?.openUntilWall)||0,failures:Number(state?.failures)||0,lastAtWall:Number(state?.lastAtWall)||0});
  // Token buckets refill from EMPTY and the spacing map starts clean: a fresh process has sent nothing,
  // but it has also earned nothing.
 }

 get account(){return this.deps.account;}
 /** Facade so existing `service.browser.{start,call,close}` call sites keep compiling once wired. */
 get worker():GatewayDownstream{
  return {
   start:(headless?:boolean)=>this.deps.downstream.start?.(headless)??Promise.resolve(),
   call:(op:string,args:any={},timeout=45000)=>this.call(op,args,timeout),
   close:()=>this.close(),
  };
 }

 stats(){return {queued:this.ready.length,running:this.running,inflight:this.inflight.size,poisoned:this.poisoned.size,wakePending:this.wakeAt!==undefined};}
 /** Breaker state in the shape `persist` receives; the caller merges it into request-state.json. */
 breakerState():Record<string,GatewayBreakerState>{return Object.fromEntries([...this.breaker].map(([s,v])=>[s,{...v}]));}

 /** ADMISSION. Synchronous through the dedupe insert: no `await` between the map lookup and the map
  *  set, so two identical callers in one tick can never both become leaders (hazard H2). */
 call(op:string,args:any={},timeout?:number,meta:GatewayMeta={}):Promise<any>{
  const now=this.deps.clock.monotonic();
  if(this.draining)return Promise.reject(Object.assign(new Error('Browser worker is closing.'),{code:'GATEWAY_CLOSING',retryable:false,action:'The account gateway is shutting down. Start it again before retrying.'}));

  // 0. An already-cancelled caller is refused before admission: an abort that arrives a microtask
  //    later would find the call already dispatched, which is exactly the orphan this must prevent.
  if(meta.signal?.aborted){
   this.emit({type:'gateway.decision',decision:'refused',op,code:'GATEWAY_CANCELLED'});
   return Promise.reject(refuse('GATEWAY_CANCELLED','The caller cancelled before the request reached the browser; no request was sent.','Nothing was sent. Retry whenever you want.'));
  }

  // 1. Freeze first. The account owner's deliberate stop outranks every other reason for refusing,
  //    and it is re-checked at the dispatch boundary and again inside BrowserWorker.call.
  if(isFrozen(this.deps.account)&&!allowedWhileFrozen(op,args)){
   const error=frozenError(this.deps.account,op);
   this.emit({type:'gateway.decision',decision:'refused',op,code:'FROZEN'});
   return Promise.reject(error);
  }

  let decision:GatewayDecision;
  try{decision=this.deps.policy.decide({account:this.deps.account,op,args,timeout,meta});}
  catch(error:any){
   this.emit({type:'gateway.decision',decision:'refused',op,code:'GATEWAY_CONFIG_INVALID'});
   return Promise.reject(refuse('GATEWAY_CONFIG_INVALID',String(error?.message||'Gateway policy could not be evaluated; no request was sent.'),'Run chatgpt gateway validate, fix the reported field, then retry.'));
  }

  // 2. Policy refusal. Never queued, never dispatched.
  if(decision.permission!=='allow'){
   const r=decision.refusal??{code:'GATEWAY_FORBIDDEN',message:`${op} is forbidden by the active gateway profile; no request was sent.`,action:'Change activeProfile in gateway.json, or run the operation under a profile that permits it.',retryable:false};
   this.emit({type:'gateway.decision',decision:'refused',op,scope:decision.scope,class:decision.class,code:r.code});
   return Promise.reject(refuse(r.code,r.message,r.action,{retryable:r.retryable===true,...(r.retryAfterMs?{retryAfterMs:r.retryAfterMs}:{})}));
  }

  const key=this.keyFor(op,args);
  const shareable=decision.shareable&&shareableCall(op,args);

  // 3. An unknown outcome poisons the key. Never replay it; the durable half of this is the receipt
  //    on disk, which the journal re-checks on the very next admission.
  const poison=this.poisoned.get(key);
  if(poison){
   this.emit({type:'gateway.decision',decision:'refused',op,scope:decision.scope,class:decision.class,code:'NEEDS_RECONCILIATION',key});
   return Promise.reject(refuse('NEEDS_RECONCILIATION','This request has an unknown outcome; automatic replay is blocked. Inspect its receipt before another attempt.','Run chatgpt online status <requestId> --json, or chatgpt receipts get <requestId> --json, and inspect the website object. Then use a new request ID for an explicit retry.',poison.requestId?{priorRequestId:poison.requestId}:{}));
  }

  // 4. Identical call already in flight.
  const existing=this.inflight.get(key);
  if(existing){
   if(!existing.shareable||!shareable){
    this.emit({type:'gateway.decision',decision:'refused',op,scope:decision.scope,class:decision.class,code:'GATEWAY_WRITE_IN_FLIGHT',key});
    return Promise.reject(refuse('GATEWAY_WRITE_IN_FLIGHT','An identical write is already in flight for this account; no second submission was made.','Inspect the in-flight request receipt before attempting this write again. Automatic replay is blocked.'));
   }
   if(existing.started&&!existing.stale&&now-existing.startedMono>existing.decision.staleAfterMs){
    existing.stale=true;
    this.emit({type:'gateway.dedupe.stale',op,scope:existing.scope,key,ageMs:now-existing.startedMono});
   }
   if(existing.stale||existing.waiters.length>=decision.maxJoiners){
    const code=existing.stale?'GATEWAY_DEDUPE_STALE':'GATEWAY_TOO_MANY_JOINERS';
    this.emit({type:'gateway.decision',decision:'refused',op,scope:decision.scope,class:decision.class,code,key});
    return Promise.reject(refuse(code,existing.stale
     ?'An identical read has been in flight longer than the stale threshold; no new caller was attached to it.'
     :'Too many callers are already sharing this in-flight read; no new caller was attached to it.',
     'Wait for the in-flight call to settle, then retry. Nothing was sent for this caller.'));
   }
   const promise=this.attach(existing,decision,meta,true);
   this.emit({type:'gateway.decision',decision:'joined',op,scope:existing.scope,class:decision.class,key,joiners:existing.waiters.length});
   this.pump();
   return promise;
  }

  // 5. New entry. INSERT BEFORE ANY AWAIT.
  const entry:Entry={key,op,args,timeout:decision.timeoutMs,decision,scope:decision.scope,shareable,waiters:[],admittedMono:now,startedMono:0,started:false,stale:false};
  this.inflight.set(key,entry);
  const promise=this.attach(entry,decision,meta,false);
  this.ready.push(entry);
  this.emit({type:'gateway.decision',decision:'admitted',op,scope:entry.scope,class:decision.class,key,queued:this.ready.length});
  this.enforceQueueDepth(decision.queueDepth,now);
  this.pump();
  return promise;
 }

 /** Cancellation is a per-caller event. An entry that has NOT dispatched is removed outright, so a
  *  cancelled caller never leaves an orphaned downstream call. An entry already past the dispatch
  *  boundary keeps running and its result is discarded: transport.ts has no cancel, and pretending
  *  otherwise would report a write as un-sent when it was sent. */
 private attach(entry:Entry,decision:GatewayDecision,meta:GatewayMeta,joining:boolean):Promise<any>{
  const rank=decision.rank;
  return new Promise<any>((resolve,reject)=>{
   const waiter:Waiter={seq:this.seq++,rank,cls:decision.class,settled:false,
    resolve:value=>{if(waiter.settled)return;waiter.settled=true;waiter.detach?.();resolve(value);},
    reject:error=>{if(waiter.settled)return;waiter.settled=true;waiter.detach?.();reject(error);}};

   const signal=meta.signal;
   const timers:AbortController[]=[];
   waiter.detach=()=>{for(const t of timers)t.abort();if(signal)signal.removeEventListener('abort',onAbort);};

   const onAbort=()=>{
    if(waiter.settled)return;
    const started=entry.started;
    this.drop(entry,waiter);
    this.emit({type:'gateway.cancelled',op:entry.op,scope:entry.scope,key:entry.key,started});
    waiter.reject(refuse('GATEWAY_CANCELLED',started
     ?'The caller cancelled while the request was already in flight; it may still have reached the site. Inspect status before retrying a write.'
     :'The caller cancelled before the request reached the browser; no request was sent.',
     started?'Inspect the operation receipt or the website object before any retry. Automatic replay is blocked.':'Nothing was sent. Retry whenever you want.'));
    this.pump();
   };

   if(signal&&!signal.aborted)signal.addEventListener('abort',onAbort,{once:true});

   // A joiner's patience is its own: the leader is unaffected when a joiner's timeout expires.
   if(joining&&Number.isFinite(decision.timeoutMs)&&decision.timeoutMs>0){
    const controller=new AbortController();timers.push(controller);
    void this.deps.sleep(decision.timeoutMs,controller.signal).then(()=>{
     if(waiter.settled||controller.signal.aborted)return;
     this.drop(entry,waiter);
     waiter.reject(Object.assign(new Error(`Browser ${entry.op} timed out. The operation may still be running; inspect status before retrying a write.`),{code:'OUTCOME_UNKNOWN',retryable:false,action:'Inspect the existing conversation/download before retrying. Writes may have completed.'}));
    },()=>{});
   }

   entry.waiters.push(waiter);
   this.sortReady(this.deps.clock.monotonic());
  });
 }

 /** Remove one waiter; drop the whole entry when the last waiter leaves before dispatch. */
 private drop(entry:Entry,waiter:Waiter){
  const i=entry.waiters.indexOf(waiter);
  if(i>=0)entry.waiters.splice(i,1);
  if(entry.waiters.length)return;
  if(entry.started)return;                       // in flight: let it settle, discard the result
  const q=this.ready.indexOf(entry);
  if(q>=0)this.ready.splice(q,1);
  if(this.inflight.get(entry.key)===entry)this.inflight.delete(entry.key);
 }

 private enforceQueueDepth(queueDepth:number,now:number){
  const depth=Math.max(1,Math.floor(queueDepth)||1);
  while(this.ready.length>depth){
   this.sortReady(now);
   // Drop the lowest-priority, NEWEST waiter — never an older one, never a higher class (hazard H11).
   const victim=this.ready[this.ready.length-1];
   this.ready.pop();
   if(this.inflight.get(victim.key)===victim)this.inflight.delete(victim.key);
   this.emit({type:'gateway.decision',decision:'refused',op:victim.op,scope:victim.scope,class:victim.decision.class,code:'GATEWAY_QUEUE_FULL',key:victim.key});
   const error=refuse('GATEWAY_QUEUE_FULL',`The gateway queue for this account is full (${depth}); no request was sent.`,'Let the queued work drain, or pause the bulk job, then retry.',{retryable:true});
   for(const w of [...victim.waiters])w.reject(error);
  }
 }

 /* ---- ordering ------------------------------------------------------------------------------ */

 private rankOf(entry:Entry,now:number){
  const base=Math.min(...entry.waiters.map(w=>w.rank),entry.decision.rank);
  // Aging: a waiter older than agingMs is promoted one rank. It can reach rank 1, never rank 0, so a
  // crawl cannot deadlock behind an endless stream of interactive calls and can never overtake typing.
  const aged=base>1&&now-entry.admittedMono>=entry.decision.agingMs?base-1:base;
  return Math.max(aged,base===0?0:1);
 }
 private seqOf(entry:Entry){return Math.min(...entry.waiters.map(w=>w.seq));}
 private sortReady(now:number){
  this.ready.sort((a,b)=>{const r=this.rankOf(a,now)-this.rankOf(b,now);return r!==0?r:this.seqOf(a)-this.seqOf(b);});
 }

 /* ---- pacing -------------------------------------------------------------------------------- */

 private bucketFor(cls:GatewayClass,now:number,spec:GatewayBucket){
  let b=this.buckets.get(cls);
  if(!b){b={tokens:0,lastRefillMono:now};this.buckets.set(cls,b);}   // empty, not full: no boot burst
  const elapsed=Math.max(0,now-b.lastRefillMono);
  b.tokens=Math.min(Math.max(1,spec.burst),b.tokens+elapsed*spec.refillPerMinute/60000);
  b.lastRefillMono=now;
  return b;
 }

 /** Remaining breaker wait in ms, clamped so a backwards wall-clock jump fails CLOSED but bounded. */
 private breakerRemaining(entry:Entry){
  const b=this.breaker.get(entry.scope);
  if(!b||!b.openUntilWall)return 0;
  return Math.max(0,Math.min(b.openUntilWall-this.deps.clock.now(),entry.decision.backoff.ceilingMs));
 }

 /** Prune the sliding window to the live interval and return it. */
 private windowFor(scope:string,now:number,spec:{maxRequests:number;intervalMs:number}){
  const stamps=(this.windows.get(scope)??[]).filter(at=>now-at<spec.intervalMs);
  this.windows.set(scope,stamps);
  return stamps;
 }

 private eligible(entry:Entry,now:number){
  if(this.breakerRemaining(entry)>0)return false;
  if(entry.decision.notBeforeWall&&entry.decision.notBeforeWall>this.deps.clock.now())return false;
  if((this.spacing.get(entry.scope)??0)>now)return false;
  if(entry.decision.window&&this.windowFor(entry.scope,now,entry.decision.window).length>=entry.decision.window.maxRequests)return false;
  if(entry.decision.kind==='generation'&&this.runningGenerations>=entry.decision.generationConcurrency)return false;
  // Hazard H13: a call that can hold the only slot for minutes yields to queued interactive work.
  if(entry.decision.longRunning&&this.ready.some(o=>o!==entry&&this.rankOf(o,now)===0))return false;
  if(entry.decision.bucket&&this.bucketFor(entry.decision.class,now,entry.decision.bucket).tokens<1)return false;
  return true;
 }

 private earliestEligible(entry:Entry,now:number){
  let at=now;
  const breaker=this.breakerRemaining(entry);
  if(breaker>0)at=Math.max(at,now+breaker);
  if(entry.decision.notBeforeWall)at=Math.max(at,now+Math.max(0,Math.min(entry.decision.notBeforeWall-this.deps.clock.now(),entry.decision.backoff.ceilingMs)));
  const spacing=this.spacing.get(entry.scope)??0;
  if(spacing>now)at=Math.max(at,spacing);
  if(entry.decision.window){
   const stamps=this.windowFor(entry.scope,now,entry.decision.window);
   if(stamps.length>=entry.decision.window.maxRequests)at=Math.max(at,stamps[stamps.length-entry.decision.window.maxRequests]+entry.decision.window.intervalMs);
  }
  if(entry.decision.bucket){
   const b=this.bucketFor(entry.decision.class,now,entry.decision.bucket);
   if(b.tokens<1)at=Math.max(at,now+(1-b.tokens)*60000/Math.max(1e-9,entry.decision.bucket.refillPerMinute));
  }
  // A generation slot, a busy runner and an interactive-yield all clear on settle, which pumps again.
  return at;
 }

 /** ONE wake timer for the whole queue, never one per waiter (hazard H3). */
 private scheduleWake(now:number){
  let target=Infinity;
  for(const entry of this.ready){
   const at=this.earliestEligible(entry,now);
   if(at>now&&at<target)target=at;
  }
  if(!Number.isFinite(target))return;
  if(this.wakeAt!==undefined&&this.wakeAt<=target)return;
  this.wakeAbort?.abort();
  const controller=new AbortController();
  this.wakeAbort=controller;this.wakeAt=target;
  const fire=()=>{if(controller.signal.aborted)return;this.wakeAt=undefined;this.wakeAbort=undefined;this.pump();};
  void this.deps.sleep(Math.max(0,target-now),controller.signal).then(fire,fire);
 }

 /* ---- runner -------------------------------------------------------------------------------- */

 /** The single loop. Exactly one place decides who goes next, and it never sleeps while holding a
  *  slot: it picks only an ELIGIBLE waiter and parks the rest on one timer. */
 private pump(){
  if(this.draining)return;
  for(;;){
   const now=this.deps.clock.monotonic();
   this.sortReady(now);
   if(!this.ready.length)return;
   if(this.running>=Math.max(1,this.ready[0].decision.concurrency))return;
   const index=this.ready.findIndex(entry=>this.eligible(entry,now));
   if(index<0){this.scheduleWake(now);return;}
   const entry=this.ready.splice(index,1)[0];

   // Spend the budget in the SAME synchronous block that selected the candidate (hazard H1).
   this.running++;
   entry.started=true;entry.startedMono=now;
   if(entry.decision.kind==='generation')this.runningGenerations++;
   if(entry.decision.spacingFrom!=='settle'&&entry.decision.spacingMs>0)this.spacing.set(entry.scope,now+entry.decision.spacingMs);
   if(entry.decision.window)this.windowFor(entry.scope,now,entry.decision.window).push(now);
   if(entry.decision.bucket)this.bucketFor(entry.decision.class,now,entry.decision.bucket).tokens-=1;
   this.emit({type:'gateway.dispatch',op:entry.op,scope:entry.scope,class:entry.decision.class,key:entry.key,waitedMs:now-entry.admittedMono,joiners:Math.max(0,entry.waiters.length-1)});
   void this.execute(entry,now);
  }
 }

 private async execute(entry:Entry,startedAt:number){
  let ok=false,value:any,error:any;
  try{
   // Freeze re-checked at the boundary: it may have been set while this entry was queued (hazard H8).
   if(isFrozen(this.deps.account)&&!allowedWhileFrozen(entry.op,entry.args))throw frozenError(this.deps.account,entry.op);
   value=await this.deps.downstream.call(entry.op,entry.args,entry.timeout);
   ok=true;
  }catch(err){error=err;}
  finally{
   this.running--;
   if(entry.decision.kind==='generation')this.runningGenerations--;
   const now=this.deps.clock.monotonic();
   if(entry.decision.spacingFrom==='settle'&&entry.decision.spacingMs>0)this.spacing.set(entry.scope,now+entry.decision.spacingMs);
   if(this.inflight.get(entry.key)===entry)this.inflight.delete(entry.key);
  }
  const ms=this.deps.clock.monotonic()-startedAt;
  if(ok)this.settleSuccess(entry,value,ms);
  else this.settleFailure(entry,error,ms);
  this.pump();                                                       // tail call on a fresh microtask, never nested recursion (hazard H16)
 }

 private settleSuccess(entry:Entry,value:any,ms:number){
  // BrowserWorker.call RESOLVES a 429; only service.request() turns it into a throw. The breaker has
  // to see it here or a crawl keeps its pace while the site is asking it to stop.
  if(value&&typeof value==='object'&&Number(value.status)===429)this.trip(entry,{status:429,retryAfter:value.retryAfter,retryAfterMs:value.retryAfterMs});
  else this.clearIfQuiet(entry);
  this.emit({type:'gateway.settle',op:entry.op,scope:entry.scope,key:entry.key,ok:true,ms,status:value?.status});
  const waiters=[...entry.waiters];entry.waiters.length=0;
  waiters.forEach((w,i)=>w.resolve(i===0?value:this.copy(value,entry)));
 }

 private settleFailure(entry:Entry,error:any,ms:number){
  if(Number(error?.status)===429)this.trip(entry,error);
  const classified=classifyError(error);
  if(classified.code==='OUTCOME_UNKNOWN'||error?.submissionState==='unknown'){
   this.poisoned.set(entry.key,{code:'NEEDS_RECONCILIATION',at:this.deps.clock.now(),requestId:error?.requestId});
   this.emit({type:'gateway.poisoned',op:entry.op,scope:entry.scope,key:entry.key,code:classified.code,requestId:error?.requestId});
  }
  this.emit({type:'gateway.settle',op:entry.op,scope:entry.scope,key:entry.key,ok:false,ms,code:classified.code});
  const waiters=[...entry.waiters];entry.waiters.length=0;
  waiters.forEach((w,i)=>w.reject(i===0?error:this.cloneError(error)));
 }

 /** A joiner never receives the leader's object: service.request() mutates its result (`delete r.path`)
  *  and service.dispatch() writes into what it is handed (hazard H5). */
 private copy(value:any,entry:Entry){
  if(value===null||typeof value!=='object')return value;
  try{return structuredClone(value);}
  catch{this.emit({type:'gateway.clone.failed',op:entry.op,key:entry.key});return value;}
 }
 /** requestId is deliberately NOT copied: a joiner did not make that request. */
 private cloneError(error:any){
  const clone=Object.assign(new Error(String(error?.message??error)),{});
  for(const field of ['code','status','retryAfterMs','action','retryable','frozen','name'])
   if(error?.[field]!==undefined)(clone as any)[field]=error[field];
  return clone;
 }

 /* ---- breaker ------------------------------------------------------------------------------- */

 private retryAfterMs(error:any,backoff:GatewayBackoff){
  const direct=Number(error?.retryAfterMs);
  let ms=Number.isFinite(direct)&&direct>0?direct:undefined;
  if(ms===undefined&&error?.retryAfter!==undefined&&error?.retryAfter!==null&&error?.retryAfter!==''){
   const seconds=Number(error.retryAfter);
   ms=Number.isFinite(seconds)?seconds*1000:Math.max(0,Date.parse(String(error.retryAfter))-this.deps.clock.now());
  }
  if(ms===undefined)return undefined;
  if(ms>backoff.retryAfterCeilingMs){
   this.emit({type:'rate.retry-after.clamped',retryAfterMs:ms,ceilingMs:backoff.retryAfterCeilingMs});
   ms=backoff.retryAfterCeilingMs;
  }
  return Math.max(0,ms);
 }

 private trip(entry:Entry,error:any){
  const backoff=entry.decision.backoff;
  const state=this.breaker.get(entry.scope)??{openUntilWall:0,failures:0,lastAtWall:0};
  state.failures+=1;state.lastAtWall=this.deps.clock.now();
  const site=this.retryAfterMs(error,backoff);
  const floor=Math.min(backoff.ceilingMs,backoff.baseMs*backoff.factor**Math.min(Math.max(0,state.failures-1),backoff.maxExponent));
  const openMs=backoff.retryAfter==='site'&&site!==undefined?site:Math.max(floor,site??0);
  state.openUntilWall=this.deps.clock.now()+openMs;
  this.breaker.set(entry.scope,state);
  try{this.deps.persist?.(this.breakerState());}catch{/* persistence never turns a paced call into a failure */}
  this.emit({type:'rate.limit',scope:entry.scope,resource:entry.op==='request'?String(entry.args?.path??'').split('?')[0]:entry.op,retryAt:new Date(state.openUntilWall).toISOString(),retryAfterMs:openMs,failures:state.failures});
  this.shed(entry.scope,openMs,state.openUntilWall);
 }

 /** Shedding matching-scope background work is what prevents the 15-minute head-of-line stall. The
  *  crawl's own supervisor decides to resume it; the gateway must never silently retry shed work.
  *  Other scopes keep flowing — scope isolation is the point. */
 private shed(scope:string,retryAfterMs:number,openUntilWall:number){
  for(const entry of [...this.ready]){
   if(entry.scope!==scope||entry.decision.shedWhileLimited!==true)continue;
   const i=this.ready.indexOf(entry);
   if(i>=0)this.ready.splice(i,1);
   if(this.inflight.get(entry.key)===entry)this.inflight.delete(entry.key);
   this.emit({type:'gateway.shed',op:entry.op,scope,key:entry.key});
   const error=Object.assign(new Error(`ChatGPT rate limit is active for ${scope}; queued background work was shed. Retry after ${new Date(openUntilWall).toISOString()}.`),{code:'RATE_LIMITED',retryable:true,retryAfterMs,action:'Wait for the reported reset/retry-after before retrying safe reads.'});
   const waiters=[...entry.waiters];entry.waiters.length=0;
   for(const w of waiters)w.reject(error);
  }
 }

 private clearIfQuiet(entry:Entry){
  const state=this.breaker.get(entry.scope);
  if(!state||!state.failures)return;
  if(this.deps.clock.now()-state.lastAtWall<=entry.decision.backoff.recoveryMs)return;
  state.failures=0;state.openUntilWall=0;
  try{this.deps.persist?.(this.breakerState());}catch{}
 }

 /** Positive knowledge — a receipt reaching complete or not-submitted — is the only thing that lifts
  *  a poisoned key. Poison never expires on a timer. */
 reconcile(key:string){return this.poisoned.delete(key);}

 private keyFor(op:string,args:any){
  const a=this.deps.account;
  const target=op==='request'
   ?{path:String(args?.path??''),method:String(args?.method??'GET').toUpperCase()}
   :undefined;
  const rest=args&&typeof args==='object'
   ?Object.fromEntries(Object.entries(args).filter(([k])=>!IDENTITY_EXCLUDED.has(k)))
   :args;
  return sha(JSON.stringify(canonical({
   schema:1,
   account:{id:a.id,userId:a.userId??null,workspace:a.workspace??null},
   op,target,body:args?.body,binary:args?.binary===true,args:rest,
  })));
 }

 private emit(event:any){try{this.deps.emit(event);}catch{/* observability never turns success into failure */}}

 /** Drains queued work and closes the downstream worker. Entries already in flight settle on their
  *  own; nothing is invented for them. */
 async close(){
  this.draining=true;
  this.wakeAbort?.abort();this.wakeAt=undefined;
  const queued=[...this.ready];this.ready.length=0;
  for(const entry of queued){
   if(this.inflight.get(entry.key)===entry)this.inflight.delete(entry.key);
   const error=Object.assign(new Error('Browser worker is closing.'),{code:'GATEWAY_CLOSING',retryable:false,action:'The account gateway is shutting down. Start it again before retrying.'});
   const waiters=[...entry.waiters];entry.waiters.length=0;
   for(const w of waiters)w.reject(error);
  }
  await this.deps.downstream.close?.();
 }
}
