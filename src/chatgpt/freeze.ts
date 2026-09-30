import {join} from 'node:path';
import {accountDir,atomicJSON,readJSON,type Account} from './accounts.ts';
import {recordEvent} from './monitor.ts';

/**
 * First-class "stop everything" switch for one ChatGPT account.
 *
 * Born from the 2026-09-15 19:51 incident ("STOP EVERYTHING IMMEDIATELY"): the only way to halt
 * site traffic was `kill -STOP` on six processes, which left a frozen daemon holding the lock.
 * A freeze is one durable flag (`freeze.json` in the account directory) that every site-bound path
 * consults on every call: browser launch, every worker call, and the service's start gate. Local
 * reads (index, journals, receipts, queue state) keep working. Only traffic-reducing calls stay
 * allowed while frozen (stop the current generation, close surfaces, close the worker).
 */
export type FreezeState={frozen:boolean;at?:string;by?:string;reason?:string;thawedAt?:string};

export const FREEZE_CODE='FROZEN';
/**
 * Worker ops that may run while frozen: they observe or reduce activity, never create it.
 *
 * `snapshot.evaluate` is deliberately NOT here, although it reads. It takes an arbitrary function
 * source and runs it in the page, so it could press Send as easily as read the DOM. What an operation
 * PERMITS decides this list, never what its current caller intends. `snapshot` stays allowed because
 * it returns a structured read and executes no caller-supplied code.
 */
export const FROZEN_ALLOWED_OPS=new Set(['status','close','surface.close','audio.output.stop','audio.clear','request.info','network','snapshot']);

export function freezeFile(account:Account){return join(accountDir(account),'freeze.json');}
export function readFreeze(account:Account):FreezeState{const state=readJSON<any>(freezeFile(account),{frozen:false});return {frozen:state?.frozen===true,...(state?.at?{at:state.at}:{}),...(state?.by?{by:state.by}:{}),...(state?.reason?{reason:state.reason}:{}),...(state?.thawedAt?{thawedAt:state.thawedAt}:{})};}
export function isFrozen(account:Account){return readFreeze(account).frozen;}

export function setFreeze(account:Account,frozen:boolean,options:{by?:string;reason?:string}={}):FreezeState{
 const previous=readFreeze(account),now=new Date().toISOString();
 const next:FreezeState=frozen
  ?{frozen:true,at:previous.frozen&&previous.at?previous.at:now,by:options.by||'cli',...(options.reason?{reason:options.reason}:previous.frozen&&previous.reason?{reason:previous.reason}:{})}
  :{frozen:false,thawedAt:now,by:options.by||'cli',...(options.reason?{reason:options.reason}:{})};
 atomicJSON(freezeFile(account),next);
 recordEvent(account,{type:frozen?'freeze.set':'freeze.cleared',by:next.by,...(next.reason?{reason:next.reason}:{}),changed:previous.frozen!==frozen});
 return next;
}

export function frozenError(account:Account,op?:string){
 const state=readFreeze(account);
 return Object.assign(new Error(`ChatGPT automation is frozen${state.reason?` (${state.reason})`:''}; no request was sent${op?` (${op})`:''}.`),{code:FREEZE_CODE,retryable:false,frozen:state,action:'This stop was set deliberately. Local reads, the index and receipts keep working while frozen. Only the account owner lifts it (chatgpt thaw, or /thaw in the TUI): ask first and never thaw automatically.'});
}

/**
 * In-process capability marking a call that REDUCES activity (clicking the website's own Stop control).
 * A Symbol cannot be expressed in JSON, so a daemon RPC payload, a slash command, or the website itself
 * can never forge it; JSON.stringify also drops it before args reach the python worker.
 */
export const ALLOW_WHILE_FROZEN=Symbol('chatgpt.allowWhileFrozen');
/** A worker call is allowed while frozen only if it observes activity or reduces it. */
export function allowedWhileFrozen(op:string,args:any={}){return FROZEN_ALLOWED_OPS.has(op)||args?.[ALLOW_WHILE_FROZEN]===true;}
