import {Gateway,policyFromDecider} from './gateway.ts';
import {loadGatewayPolicy,decide as decideGateway} from './gateway-policy.ts';
import {recordEvent,classifyError} from './monitor.ts';
import {accountDir,atomicJSON,readJSON,type Account} from './accounts.ts';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * ONE gateway per account, shared by every worker in the process.
 *
 * The online and harness paths build their own `BrowserWorker` (harness-web.ts), so before this
 * registry existed a second, entirely unpaced access point hit `/backend-api/conversation/{id}` —
 * the exact endpoint whose five 429s produced "STOP EVERYTHING IMMEDIATELY" on 2026-09-15 19:51.
 * Two limiters that each believe they are under the limit are not a limit.
 *
 * Each worker keeps dispatching its own calls; only the LIMITER is shared. The per-call dispatcher
 * travels on a Symbol-keyed property, which `JSON.stringify` drops, so it can never reach the browser
 * worker and can never be forged by anything that arrives as JSON.
 */
export const DISPATCH=Symbol('chatgpt.gatewayDispatch');
/** Marks which worker a call belongs to, so worker-scoped reads are never shared across workers. */
const WORKER_TAG='__gatewayWorker';
/** Breaker state lives in its own file: request-state.json is rewritten on every 429 by the service. */
function breakerFile(account:Account){return join(accountDir(account),'gateway-breaker.json');}

type State=()=>{rateLimitedUntil?:number;limitedScope?:string};
const gateways=new Map<string,{gateway:Gateway|null;status:string}>();
let workerSeq=0;

/** Test seam: drop every memoised gateway so a suite can install a different config. */
export function resetGatewayRegistry(){gateways.clear();}

/**
 * The account's gateway, or undefined when the account has not opted in.
 *
 * With no gateway.json the loader reports `builtin` and this returns undefined, so a machine that has
 * not opted in keeps the shipped behaviour exactly. A malformed or too-new file still returns a
 * gateway, on purpose: it then fails closed and refuses site traffic while local reads and freeze
 * keep working.
 */
export function accountGateway(account:Account,state?:State):Gateway|undefined{
 const existing=gateways.get(account.id);
 if(existing)return existing.gateway??undefined;
 try{
  const loaded=loadGatewayPolicy(account.id,path=>existsSync(path)?readFileSync(path,'utf8'):null);
  if(loaded.status==='builtin'){gateways.set(account.id,{gateway:null,status:loaded.status});return undefined;}
  const gateway=new Gateway({
   account,
   downstream:{
    call:(op,args,timeout)=>{
     const dispatch=(args as any)?.[DISPATCH];
     if(typeof dispatch!=='function')throw Object.assign(new Error('Gateway call reached the downstream without a worker dispatcher.'),{code:'GATEWAY_NO_DISPATCH',retryable:false,action:'Route worker calls through routeWorkerThroughGateway.'});
     const {[WORKER_TAG]:_tag,...clean}=args||{};
     return dispatch(op,clean,timeout);
    },
   },
   policy:policyFromDecider(decideGateway,loaded,{layer:'worker',...(state?{state}:{})}),
   clock:{now:()=>Date.now(),monotonic:()=>Bun.nanoseconds()/1e6},
   sleep:(ms:number,signal?:AbortSignal)=>Bun.sleep(ms).then(()=>{signal?.throwIfAborted();}),
   emit:event=>recordEvent(account,event),
   // A restart is not a way to clear a rate limit: an open breaker outlives the process that tripped it.
   restore:()=>readJSON<any>(breakerFile(account),{}),
   persist:scopes=>{try{atomicJSON(breakerFile(account),scopes);}catch{}},
  });
  gateways.set(account.id,{gateway,status:loaded.status});
  recordEvent(account,{type:'gateway.installed',status:loaded.status,profile:loaded.profile,path:loaded.path,reason:loaded.reason});
  return gateway;
 }catch(error:any){
  // A broken gateway must never take the client down: without it the shipped pacing still applies.
  gateways.set(account.id,{gateway:null,status:'error'});
  recordEvent(account,{type:'gateway.install.failed',...classifyError(error)});
  return undefined;
 }
}

type Routable={setRouter(router?:(op:string,args:any,timeout:number)=>Promise<any>):void;rawCall(op:string,args?:any,timeout?:number):Promise<any>};

/**
 * Point one worker's calls at the account's shared gateway. Returns true when routing was installed.
 *
 * Only `request` ops may be shared between workers: an HTTP read of the same path is the same answer
 * for the whole account. Everything else is worker-scoped — a snapshot of surface "main" means a
 * different page in a different worker — so those calls carry a worker tag that keeps their dedupe
 * keys distinct. The tag is stripped again before the call reaches the browser.
 */
export function routeWorkerThroughGateway(account:Account,worker:Routable,state?:State){
 const gateway=accountGateway(account,state);
 if(!gateway)return false;
 const workerId=`w${++workerSeq}`;
 worker.setRouter((op,args,timeout)=>{
  const tagged:any={...(args||{})};
  if(op!=='request')tagged[WORKER_TAG]=workerId;
  tagged[DISPATCH]=(o:string,a:any,t:number)=>worker.rawCall(o,a,t);
  return gateway.call(op,tagged,timeout);
 });
 return true;
}
