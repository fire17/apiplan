import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Built} from '/Users/magic/Creations/APIPlan/src/providers.ts';
import type {Account} from '/Users/magic/Creations/APIPlan/src/chatgpt/accounts.ts';
import {openOnlineRequest,type OnlineRequest} from '/Users/magic/Creations/APIPlan/src/chatgpt/online-runtime.ts';

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const selected:Account={id:'fixture',label:'Fixture',baseURL:'https://chatgpt.com',cdpURL:'http://127.0.0.1:9222',transportMode:'attached',workspace:'space',userId:'user-1',created:'2026-09-15T00:00:00.000Z'};
const request=():OnlineRequest=>({version:1,model:'online-chat-latest',accountId:selected.id,accountUserId:selected.userId!,accountWorkspace:selected.workspace,turns:[{role:'user',text:'Use lookup'}],options:{tools:[{name:'lookup',parameters:{type:'object'}}]},selection:{mode:'Chat',model:'Latest',effort:'Instant'}});
const built=():Built=>({url:'apiplan-online://website/generate',headers:{},body:request()});
const parse=async(response:Response)=>{const text=await response.text();return text.trim().split('\n').map(line=>JSON.parse(line));};
const fixture=(send:(agent:any,text:string,emit:(event:any)=>void)=>Promise<any>)=>{const root=mkdtempSync(join(tmpdir(),'online-runtime-'));roots.push(root);let opens=0,closes=0;return {root,get opens(){return opens;},get closes(){return closes;},deps:{account:(id:string)=>{expect(id).toBe(selected.id);return selected;},root:()=>root,driver:async()=>{opens++;return {send,close:async()=>{closes++;}};}}};};

test('streams verified display and semantic tool deltas, writes a complete receipt, and replays without another website send',async()=>{
 let sends=0;const f=fixture(async(_agent,prompt,emit)=>{sends++;const run=/<tool_call run="([^"]+)">/.exec(prompt)![1]!;const protocol=`<tool_call run="${run}">\n{"id":"tool-1","tool":"lookup","args":{"key":"alpha"}}\n</tool_call>`;emit({type:'submitted',verified:true,conversation:'chat-1'});emit({type:'text',text:'Checking.\n'});for(const part of [protocol.slice(0,19),protocol.slice(19)])emit({type:'protocol.text',text:part});return {text:'Checking.\n'+protocol,protocolText:protocol,conversation:'chat-1',url:'https://chatgpt.com/c/chat-1',driver:{submission:{verified:true},selection:{mode:'Chat',model:'Latest',effort:'Instant'}}};});
 const response=await openOnlineRequest(built(),undefined,f.deps as any);expect(response.status).toBe(200);const rows=await parse(response);
 expect(rows.map(row=>row.delta||row)).toEqual([
  {toolStart:{ref:'tool-1',id:'tool-1',name:'lookup'}},
  {toolArgs:{ref:'tool-1',json:'{"key":"alpha"}'}},
  {toolStop:{ref:'tool-1'}},
  {text:'Checking.\n'},
  {stopReason:'tool_use'},
  {terminal:true},
 ]);
 const requestId=response.headers.get('x-apiplan-online-request')!;const receipt=JSON.parse(readFileSync(join(f.root,'online',requestId,'api-receipt.json'),'utf8'));
 expect(receipt).toMatchObject({status:'complete',requestId,conversation:'chat-1'});expect(receipt.deltas).toEqual(rows.slice(0,-1).map(row=>row.delta));
 const replay=await openOnlineRequest(built(),undefined,f.deps as any);expect(replay.headers.get('x-apiplan-online-replayed')).toBe('true');expect(await parse(replay)).toEqual(rows);expect(sends).toBe(1);expect(f.opens).toBe(1);expect(f.closes).toBe(1);
});

test('a proven pre-submit failure is retryable but never auto-replayed',async()=>{
 let sends=0;const f=fixture(async()=>{sends++;throw Object.assign(new Error('preflight failed'),{code:'NOT_SUBMITTED',submissionState:'not-submitted'});});
 const first=await openOnlineRequest(built(),undefined,f.deps as any);expect(first.status).toBe(400);expect(await first.json()).toMatchObject({error:{code:'NOT_SUBMITTED'}});
 const second=await openOnlineRequest(built(),undefined,f.deps as any);expect(second.status).toBe(400);expect(await second.json()).toMatchObject({error:{code:'NOT_SUBMITTED'}});expect(sends).toBe(2);
});

test('one exact preparation timeout retries on the same driver and records no-content retry evidence',async()=>{
 let sends=0,submitted=0;const f=fixture(async(_agent,_prompt,emit)=>{sends++;if(sends===1)throw Object.assign(new Error('surface was not ready'),{code:'NOT_SUBMITTED',submissionState:'not-submitted',causeCode:'HARNESS_PREPARATION_TIMEOUT'});submitted++;emit({type:'submitted',verified:true});return {text:'ready',displayText:'ready',protocolText:'',conversation:'chat-ready',url:'https://chatgpt.com/c/chat-ready',driver:{submission:{verified:true},selection:{mode:'Chat',model:'Latest',effort:'Instant'}}};});
 const response=await openOnlineRequest(built(),undefined,f.deps as any);expect(response.status).toBe(200);await response.text();expect({sends,submitted,opens:f.opens,closes:f.closes}).toEqual({sends:2,submitted:1,opens:1,closes:1});
 const requestId=response.headers.get('x-apiplan-online-request')!,receipt=JSON.parse(readFileSync(join(f.root,'online',requestId,'api-receipt.json'),'utf8'));
 expect(receipt).toMatchObject({status:'complete',preparationAttempts:2,preparationRetries:[{attempt:1,delayMs:250,causeCode:'HARNESS_PREPARATION_TIMEOUT',submissionState:'not-submitted'}]});
 expect(JSON.stringify(receipt.preparationRetries)).not.toContain('surface was not ready');
});

test('preparation retry is capped and never applies after submit or to another failure',async()=>{
 const exact=fixture(async()=>{throw Object.assign(new Error('still not ready'),{code:'NOT_SUBMITTED',submissionState:'not-submitted',causeCode:'HARNESS_PREPARATION_TIMEOUT'});});
 const exhausted=await openOnlineRequest(built(),undefined,exact.deps as any);expect(exhausted.status).toBe(400);const exhaustedBody:any=await exhausted.json();expect(exact.opens).toBe(1);expect(exact.closes).toBe(1);
 const exhaustedReceipt=JSON.parse(readFileSync(join(exact.root,'online',exhaustedBody.error.request_id,'api-receipt.json'),'utf8'));expect(exhaustedReceipt).toMatchObject({status:'not-submitted',preparationAttempts:2});

 let submittedSends=0;const afterSubmit=fixture(async(_agent,_prompt,emit)=>{submittedSends++;emit({type:'submitted',verified:true});throw Object.assign(new Error('submitted timeout'),{submissionState:'not-submitted',causeCode:'HARNESS_PREPARATION_TIMEOUT'});});
 const unknown=await openOnlineRequest(built(),undefined,afterSubmit.deps as any);expect(unknown.status).toBe(200);await unknown.text();expect(submittedSends).toBe(1);

 let otherSends=0;const other=fixture(async()=>{otherSends++;throw Object.assign(new Error('identity failure'),{code:'NOT_SUBMITTED',submissionState:'not-submitted',causeCode:'ACCOUNT_MISMATCH'});});
 const rejected=await openOnlineRequest(built(),undefined,other.deps as any);expect(rejected.status).toBe(400);await rejected.text();expect(otherSends).toBe(1);
 let unknownSends=0;const uncertain=fixture(async()=>{unknownSends++;throw Object.assign(new Error('preparation outcome unknown'),{submissionState:'unknown',causeCode:'HARNESS_PREPARATION_TIMEOUT'});});
 const blocked=await openOnlineRequest(built(),undefined,uncertain.deps as any);expect(blocked.status).toBe(409);await blocked.text();expect(unknownSends).toBe(1);
});

test('a verified submission followed by failure becomes an unknown terminal and never auto-replays',async()=>{
 let sends=0;const f=fixture(async(_agent,_prompt,emit)=>{sends++;emit({type:'submitted',verified:true});await Bun.sleep(5);throw new Error('lost after submit');});
 const first=await openOnlineRequest(built(),undefined,f.deps as any);expect(first.status).toBe(200);const rows=await parse(first);expect(rows).toHaveLength(1);expect(rows[0].delta).toMatchObject({errorType:'online_outcome_unknown'});expect(rows[0].delta.error).toContain('Request: api-');
 const second=await openOnlineRequest(built(),undefined,f.deps as any);expect(second.status).toBe(409);expect(await second.json()).toMatchObject({error:{code:'NEEDS_RECONCILIATION'}});expect(sends).toBe(1);
});

test('client cancellation closes observation, records unknown outcome, emits no success terminal, and leaves no active lock',async()=>{
 let rejectSend!:(error:Error)=>void;const f=fixture(async(_agent,_prompt,emit)=>{emit({type:'submitted',verified:true});return await new Promise((_resolve,reject)=>{rejectSend=reject;});});
 const controller=new AbortController();const response=await openOnlineRequest(built(),controller.signal,f.deps as any);controller.abort();rejectSend(new Error('driver closed after cancellation'));
 const rows=await parse(response);expect(rows.some(row=>row.terminal===true||row.delta?.stopReason)).toBe(false);expect(rows.at(-1)?.delta).toMatchObject({errorType:'online_outcome_unknown'});
 await Bun.sleep(10);const requestId=response.headers.get('x-apiplan-online-request')!;const receipt=JSON.parse(readFileSync(join(f.root,'online',requestId,'api-receipt.json'),'utf8'));expect(receipt).toMatchObject({status:'unknown',cancellationRequested:true});
 expect(()=>readFileSync(join(f.root,'online',requestId,'active.lock'))).toThrow();expect(f.closes).toBeGreaterThanOrEqual(1);
});

test('account identity is revalidated before driver creation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'online-runtime-'));roots.push(root);let opened=0;const response=await openOnlineRequest(built(),undefined,{account:()=>({...selected,userId:'other'}),root:()=>root,driver:async()=>{opened++;throw new Error('must not open');}} as any);
 expect(response.status).toBe(401);expect(await response.json()).toMatchObject({error:{code:'ACCOUNT_MISMATCH'}});expect(opened).toBe(0);
});

test('canonical request digest replays semantically identical reordered objects without a second send',async()=>{
 let sends=0;const f=fixture(async(_agent,_prompt,emit)=>{sends++;emit({type:'submitted',verified:true});return {text:'stable',displayText:'stable',protocolText:'',driver:{submission:{verified:true},selection:{mode:'Chat',model:'Latest',effort:'Instant'}}};});
 const first=built(),second=built();
 (first.body as any).turns[0].extra={alpha:1,beta:{left:2,right:3}};
 (second.body as any).turns[0].extra={beta:{right:3,left:2},alpha:1};
 const initial=await openOnlineRequest(first,undefined,f.deps as any);expect(initial.status).toBe(200);await initial.text();
 const replay=await openOnlineRequest(second,undefined,f.deps as any);expect(replay.status).toBe(200);expect(replay.headers.get('x-apiplan-online-replayed')).toBe('true');expect(sends).toBe(1);
});
