import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {openSync,closeSync,unlinkSync} from 'node:fs';
import type {Built,CallOpts,Delta,Turn} from '../providers.ts';
import {account,accountDir,atomicJSON,privateDir,readJSON,type Account} from './accounts.ts';
import {fresh} from './fresh.ts';
const {OnlineReplyDecoder,onlineFault,onlinePrompt}=await fresh('online-wire');

export type OnlineRequest={version:1;model:string;accountId:string;accountUserId:string;accountWorkspace?:string;turns:Turn[];options:CallOpts;selection:{mode:'Chat'|'Work';model:string;effort:string}};
type Driver={send:(agent:{id:string;name:string},text:string,emit:(event:any)=>void)=>Promise<any>;close:()=>Promise<any>};
type Dependencies={account:(id:string)=>Account;driver:(account:Account,options:any)=>Promise<Driver>;root?:(account:Account)=>string};
const defaults:Dependencies={account,driver:async(a,o)=>{const {WebsiteHarnessDriver}=await fresh('harness-web');return new WebsiteHarnessDriver(a,o);}};
function jsonError(error:any){const status=Number.isInteger(error?.status)?error.status:error?.code==='NOT_SUBMITTED'?400:409;return Response.json({error:{type:status===401?'authentication_error':'online_request_error',code:error?.code||'ONLINE_ERROR',message:error?.message||String(error),...(error?.apiRequestId?{request_id:error.apiRequestId}:error?.requestId?{request_id:error.requestId}:{}),...(error?.apiRequestId&&error?.requestId?{website_operation_id:error.requestId}:{})}},{status});}
function canonical(value:any):any {if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])]));return value;}
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const frame=(delta:Delta)=>JSON.stringify({delta})+'\n';

/** Website writes have durable receipts. Identical requests recover a completed response or
 * refuse an uncertain write; callers never cause an automatic browser resubmission. */
export async function openOnlineRequest(built:Built,signal?:AbortSignal,dependencies:Dependencies=defaults):Promise<Response>{
 let lock:string|undefined,driver:Driver|undefined,accepted=false,settled=false,aborted=false;
 try{
  const request=built.body as OnlineRequest;
  if(request?.version!==1||!Array.isArray(request.turns)||!request.selection)throw onlineFault('INVALID_REQUEST','Invalid internal online request.');
  if(signal?.aborted)throw onlineFault('CANCELLED','Request cancelled before submission.',499);
  const selected=dependencies.account(request.accountId);
  if(!selected.userId||selected.userId!==request.accountUserId||selected.workspace!==request.accountWorkspace)throw onlineFault('ACCOUNT_MISMATCH','Selected website account identity changed before submission.',401);
  const directory=privateDir(join(dependencies.root?.(selected)||accountDir(selected),'online'));
  const digest=hash({account:{id:selected.id,userId:selected.userId,workspace:selected.workspace},request});
  const runId='api-'+digest.slice(0,40),runDirectory=privateDir(join(directory,runId)),receiptPath=join(runDirectory,'api-receipt.json');
  const previous=readJSON<any>(receiptPath,null);
  if(previous){
   if(previous.status==='complete'&&Array.isArray(previous.deltas))return new Response(previous.deltas.map(frame).join('')+JSON.stringify({terminal:true})+'\n',{headers:{'content-type':'application/x-ndjson','x-apiplan-online-request':runId,'x-apiplan-online-replayed':'true'}});
   if(previous.status!=='not-submitted')throw onlineFault('NEEDS_RECONCILIATION','This exact website API request has an incomplete receipt. Run chatgpt online status '+runId+' before submitting again.',409);
  }
  const prompt=onlinePrompt(runId,request.turns,request.options);
  lock=join(runDirectory,'active.lock');
  try{const fd=openSync(lock,'wx',0o600);closeSync(fd);}catch{lock=undefined;throw onlineFault('REQUEST_IN_PROGRESS','This website API request is already active or requires reconciliation.',409);}
  // Recheck under the exclusive lock; another process may have finished between reads.
  const lockedReceipt=readJSON<any>(receiptPath,null);
  if(lockedReceipt&&lockedReceipt.status!=='not-submitted')throw onlineFault('NEEDS_RECONCILIATION','A receipt appeared while acquiring the request lock. Inspect the saved request.',409);
  const started=new Date().toISOString(),deltas:Delta[]=[],preparationRetries:any[]=[];let preparationAttempts=0;
  const receiptBase=()=>({version:1,requestId:runId,digest,model:request.model,accountId:selected.id,started,preparationAttempts,preparationRetries});
  atomicJSON(receiptPath,{...receiptBase(),status:'preparing'});
  driver=await dependencies.driver(selected,{directory:runDirectory,mode:request.selection.mode,model:request.selection.model,effort:request.selection.effort,timeout:600000});
  let controller:ReadableStreamDefaultController<Uint8Array>|undefined,readyResolve!:()=>void,readyReject!:(error:any)=>void;
  const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const encoder=new TextEncoder();let buffered=0;
  const push=(delta:Delta)=>{
   if(aborted)throw onlineFault('CANCELLED','API client cancelled the website observation.',499);
   const encoded=encoder.encode(frame(delta));buffered+=encoded.byteLength;
   if(buffered>8*1024*1024)throw onlineFault('OUTPUT_LIMIT','Website response exceeded the local 8 MiB response limit.',409);
   deltas.push(delta);controller!.enqueue(encoded);
  };
  const decoder=new OnlineReplyDecoder(runId,request.options,push,new Set(request.turns.flatMap(turn=>(turn.toolUses||[]).map(call=>call.id))));
  const cancel=()=>{if(settled)return;aborted=true;void driver?.close().catch(()=>{});};
  const stream=new ReadableStream<Uint8Array>({start(c){controller=c;},cancel(){cancel();}});
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const ownedLock=lock;lock=undefined;
  void (async()=>{
   try{
    if(aborted)throw onlineFault('CANCELLED','Request cancelled before website submission.',499);
    let result:any;for(;;){
     preparationAttempts++;atomicJSON(receiptPath,{...receiptBase(),status:'preparing'});
     try{result=await driver!.send({id:'api',name:'APIPlan online'},prompt,event=>{
      if(event.type==='submitted'&&event.verified===true){accepted=true;atomicJSON(receiptPath,{...receiptBase(),status:'submitted',submission:event});readyResolve();}
      decoder.event(event);
     });break;}catch(error:any){
      const retry=preparationAttempts===1&&!accepted&&!aborted&&error?.submissionState==='not-submitted'&&error?.causeCode==='HARNESS_PREPARATION_TIMEOUT';
      if(!retry)throw error;
      preparationRetries.push({attempt:preparationAttempts,at:new Date().toISOString(),delayMs:250,causeCode:'HARNESS_PREPARATION_TIMEOUT',submissionState:'not-submitted'});
      atomicJSON(receiptPath,{...receiptBase(),status:'preparing',retryScheduled:true});await Bun.sleep(250);
      if(aborted)throw onlineFault('CANCELLED','Request cancelled before the preparation retry.',499);
     }
    }
    if(aborted)throw onlineFault('CANCELLED','Request cancellation was requested; completion is not assumed.',499);
    if(!accepted||result.driver?.submission?.verified!==true)throw onlineFault('SUBMISSION_UNVERIFIED','Website submission was not positively observed.',409);
    decoder.finish(result);
    atomicJSON(receiptPath,{...receiptBase(),status:'complete',completed:new Date().toISOString(),conversation:result.conversation,url:result.url,selection:result.driver.selection,deltas});
    controller!.enqueue(encoder.encode(JSON.stringify({terminal:true})+'\n'));controller!.close();readyResolve();
   }catch(error:any){
    error.apiRequestId=runId;
    const status=accepted||error?.submissionState!=='not-submitted'?'unknown':'not-submitted';
    atomicJSON(receiptPath,{...receiptBase(),status,error:{code:error?.code||'ONLINE_ERROR',message:error?.message||String(error)},cancellationRequested:aborted});
    readyReject(error);
    // Error frame is terminal for the transport only; never supplies a success stopReason.
    try{controller!.enqueue(encoder.encode(frame({error:(error?.message||String(error))+' Request: '+runId,errorType:'online_outcome_unknown'})));controller!.close();}catch{}
   }finally{
    settled=true;signal?.removeEventListener('abort',cancel);await driver!.close().catch(()=>{});try{unlinkSync(ownedLock!);}catch{}
   }
  })();
  try{await ready;}catch(error){return jsonError(error);}
  return new Response(stream,{headers:{'content-type':'application/x-ndjson','x-apiplan-online-request':runId}});
 }catch(error){return jsonError(error);}
 finally{if(lock){try{unlinkSync(lock);}catch{}}}
}
