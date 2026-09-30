import {join} from 'node:path';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {accountDir,privateDir,atomicJSON,type Account} from './accounts.ts';
import {fresh,freshRevision} from './fresh.ts';
import type {WebsiteHarnessDriver as WebsiteHarnessDriverType} from './harness-web.ts';

function runDirectory(account:Account,id:string){if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id))throw new Error('Invalid harness run ID.');return join(accountDir(account),'harness',id);}
export function harnessStatus(account:Account,id?:string){const root=join(accountDir(account),'harness');if(!id)return {items:existsSync(root)?readdirSync(root).filter(id=>/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)).flatMap(id=>{try{return [JSON.parse(readFileSync(join(root,id,'run-state.json'),'utf8'))];}catch{return [];}}).sort((a,b)=>b.started.localeCompare(a.started)):[]};const file=join(runDirectory(account,id),'run-state.json');return JSON.parse(readFileSync(file,'utf8'));}
const encode=(events:any[])=>events.map(event=>{
 const tag=event.type==='tool.result'||event.type==='tool.error'?'tool_result':event.type==='agent.message'?'agent_message':'harness_event';
 return '<'+tag+' run="'+event.runId+'">\n'+JSON.stringify(event)+'\n</'+tag+'>';
}).join('\n');
export async function runHarness(account:Account,args:any={},emit:(event:any)=>void=()=>{}){
 const revision=new URL(import.meta.url).searchParams.get('revision')||freshRevision('harness-run');
 const [{WebsiteHarnessDriver},{ConversationHarness},{verifyHarnessRun}]=await Promise.all([fresh('harness-web',revision),fresh('conversation-harness',revision),fresh('harness-verify',revision)]);
 const test=args.test===true,turns=Number(args.turns??(test?6:8));if(!Number.isSafeInteger(turns)||turns<(test?5:1)||turns>20)throw new Error(test?'Harness test requires 5–20 parent turns.':'Harness run requires 1–20 parent turns.');
 if(!test&&!args.text?.trim())throw new Error('Supply the harness objective with --text.');
 const runId=args.runId||crypto.randomUUID(),directory=runDirectory(account,runId);if(existsSync(directory))throw new Error('Harness run already exists. Inspect its receipts; never blindly replay an existing run.');privateDir(directory);
 const state:any={schema:1,runId,account:{id:account.id,userId:account.userId,workspace:account.workspace},started:new Date().toISOString(),status:'preparing',test,requestedParentTurns:turns,model:args.model||'Latest',effort:args.effort||'Instant',directory,parentTurns:[],driverTurns:[],events:[],verification:{complete:false}};
 const save=()=>atomicJSON(join(directory,'run-state.json'),state);
 const event=(value:any)=>{const row={at:new Date().toISOString(),...value};state.events.push(row);try{emit({type:'harness.event',runId,event:row});}catch{/* Observer failures never replay website writes. */}};
 save();
 let web:WebsiteHarnessDriverType;
 try{web=new WebsiteHarnessDriver(account,{directory,model:state.model,effort:state.effort,timeout:Number(args.timeout||120000),emit:event});}
 catch(error:any){state.status='failed';state.error={code:error.code||'OPERATION_FAILED',message:error.message};state.finished=new Date().toISOString();save();throw Object.assign(error,{runId,evidencePath:join(directory,'run-state.json'),action:'Inspect chatgpt harness status --run-id '+runId+'. Existing submissions are preserved; do not replay uncertain turns.'});}
 const driver={protocolChannel:true,send:async(agent:any,text:string,onEvent:(event:any)=>void)=>{
  const startedEvent=state.events.findLast((event:any)=>event.type==='turn.started'&&event.agentId===agent.id);const row:any={agentId:agent.id,name:agent.name,kind:startedEvent?.kind,turnId:startedEvent?.turnId,started:new Date().toISOString(),submitted:false};state.driverTurns.push(row);save();
  try{const result=await web.send(agent,text,value=>{if(value.type==='submitted'){row.submitted=value.verified===true;row.submittedAt=new Date().toISOString();}onEvent(value);});row.finished=new Date().toISOString();row.text=result.text;row.conversation=result.conversation;row.url=result.url;row.driver=result.driver;row.requestId=result.requestId;row.selection=result.driver?.selection;row.identity=result.driver?.identity;row.submission=result.driver?.submission;save();return result;}
  catch(error:any){row.finished=new Date().toISOString();row.error={code:error.code||'OPERATION_FAILED',message:error.message};save();throw error;}
 }};
 const harness=new ConversationHarness({runId,driver,directory,onEvent:event,maxAgents:4,maxTurns:40,maxCalls:64});
 const token='bridge-'+crypto.randomUUID().slice(0,8);state.token=token;
 const stages=[
  `Integration stage 1. Emit real tool calls now: create agent named alpha with task "Remember value 42 and token ${token}. Reply exactly ALPHA_VALUE:42 TOKEN:${token}. Future instructions update this remembered value; reply ALPHA_VALUE:number TOKEN:${token}. No tool calls are needed for this simple task." Create agent beta with the same task but initial value 17 and BETA_VALUE. Also call echo with value ${token}. Create both workers without waiting for their replies. Use IDs beginning p1-.`,
  `Integration stage 2. Call agents.list. Send alpha: "Add 5 to your remembered value, remember the new value, and report ALPHA_VALUE:number TOKEN:${token}." Send beta: "Add 25 to your remembered value, remember the new value, and report BETA_VALUE:number TOKEN:${token}." These deliveries may queue while workers are busy. Use IDs beginning p2-.`,
  `Integration stage 3. Consume the actual tool results and asynchronous worker messages. Call agents.wait with milliseconds 250 and echo with value ${token}-round3. Report received values only; do not pretend pending responses have arrived. Use IDs beginning p3-.`,
  `Integration stage 4. Send alpha: "Subtract 5 from your current remembered value, remember it, and report ALPHA_VALUE:number TOKEN:${token}." Send beta: "Subtract 25 from your current remembered value, remember it, and report BETA_VALUE:number TOKEN:${token}." Use IDs beginning p4-.`,
  `Integration stage 5. Call agents.list and echo with value ${token}-round5. Account for received worker messages and pending calls without inventing any results. Use IDs beginning p5-.`,
 ];
 try{
  state.status='running';save();
  for(let n=0;n<turns;n++){
   if(test&&n===turns-1&&n>=5)state.childrenSettledBeforeFinal=await harness.waitForIdle(90000);
   const incoming=harness.drain('parent');
   const instruction=test?(n<stages.length?stages[n]:`Final verification stage ${n+1}. Use only the actual received agent messages to report the latest worker values and their remembered token. Reply exactly ALPHA_FINAL:<actual latest number> BETA_FINAL:<actual latest number> TOKEN:<actual token>. Use MISSING for any value not received. Do not infer the values from task instructions. No further tool calls.`):(n===0?args.text:'Continue the objective using these actual tool results and agent messages. Do not duplicate completed calls.');
   const prompt=(incoming.length?encode(incoming)+'\n\n':'')+instruction;
   const before=new Date().toISOString(),result=await harness.turn('parent',prompt);
   state.parentTurns.push({number:n+1,started:before,finished:new Date().toISOString(),deliveredEvents:incoming.length,deliveredEventSeqs:incoming.map((event:any)=>event.seq),text:result?.text,conversation:result?.conversation});state.snapshot=harness.snapshot();save();
   // Do not wait for every worker between parent turns: late results are delivered in later turns.
   if(n<turns-1)await Bun.sleep(100);
  }
  state.idle=await harness.waitForIdle(90000);state.remainingEvents=harness.drain('parent');state.snapshot=harness.snapshot();
  state.verification=verifyHarnessRun(state,token);
  state.status=state.verification.complete?'complete':'partial';state.finished=new Date().toISOString();save();return {runId,status:state.status,complete:state.verification.complete,directory,verification:state.verification,conversations:state.driverTurns.map((t:any)=>({agentId:t.agentId,name:t.name,conversation:t.conversation,url:t.url})),parentTurns:state.parentTurns.length};
 }catch(error:any){state.status='failed';state.error={code:error.code||'OPERATION_FAILED',message:error.message};state.snapshot=harness.snapshot();state.finished=new Date().toISOString();save();throw Object.assign(error,{runId,evidencePath:join(directory,'run-state.json'),action:'Inspect chatgpt harness status --run-id '+runId+'. Existing submissions are preserved; do not replay uncertain turns.'});}
 finally{await harness.waitForIdle(10000).catch(()=>false);await web.close();}
}
