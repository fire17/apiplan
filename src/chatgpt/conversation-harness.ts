import {createHash} from 'node:crypto';
import {appendFileSync,chmodSync,existsSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {atomicJSON,privateDir} from './accounts.ts';
import {fresh,freshRevision} from './fresh.ts';
import type {ToolCall,ToolProtocolError} from './harness-protocol.ts';

const protocolRevision=new URL(import.meta.url).searchParams.get('revision')||freshRevision('conversation-harness');
const {StreamToolParser,harnessBootstrap}=await fresh('harness-protocol',protocolRevision);

export type HarnessAgent={id:string;name:string;parentId?:string};
export type HarnessDriver={protocolChannel?:boolean;send(agent:HarnessAgent,text:string,emit:(event:any)=>void):Promise<{text:string;protocolText?:string;conversation?:string;url?:string;[key:string]:any}>};
export type HarnessEvent={seq:number;at:string;runId:string;type:string;agentId:string;[key:string]:any};
export type ConversationHarnessOptions={runId:string;driver:HarnessDriver;directory?:string;onEvent?:(event:HarnessEvent)=>void;maxAgents?:number;maxTurns?:number;maxCalls?:number};
type AgentRecord=HarnessAgent&{task:string;bootstrapped:boolean;bootstrapPromise?:Promise<void>;status:'idle'|'running'|'failed';turns:number;tail:Promise<void>;inbox:HarnessEvent[]};
type CallRecord={signature:string;status:'running'|'complete'|'error';tool:string;result?:any;error?:{code:string;message:string}};
const contextId=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const canonical=(value:any):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const hash=(value:any)=>createHash('sha256').update(canonical(value)).digest('hex');
const fault=(code:string,message:string)=>Object.assign(new Error(message),{code});
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const resultFrame=(runId:string,callId:string,result:any)=>`<tool_result run="${runId}">
${JSON.stringify({callId,ok:true,result})}
</tool_result>`;
const errorFrame=(runId:string,callId:string,error:{code:string;message:string})=>`<tool_result run="${runId}">
${JSON.stringify({callId,ok:false,error})}
</tool_result>`;
const messageFrame=(runId:string,value:any)=>`<agent_message run="${runId}">
${JSON.stringify(value)}
</agent_message>`;
function exactArgs(args:Record<string,unknown>,allowed:string[]){const extra=Object.keys(args).filter(key=>!allowed.includes(key));if(extra.length)throw fault('INVALID_TOOL_ARGS','Unexpected '+extra.map(key=>JSON.stringify(key)).join(', ')+' argument.');}
function requiredText(value:unknown,label:string){if(typeof value!=='string'||!value.trim())throw fault('INVALID_TOOL_ARGS',label+' must be a non-empty string.');if(Buffer.byteLength(value)>64*1024)throw fault('MESSAGE_TOO_LARGE',label+' is limited to 64 KiB.');return value;}
function publicError(error:any){return {code:String(error?.code||'TOOL_FAILED'),message:String(error?.message||error)};}

export class ConversationHarness{
 readonly runId:string;readonly driver:HarnessDriver;readonly maxAgents:number;readonly maxTurns:number;readonly maxCalls:number;
 private readonly agents=new Map<string,AgentRecord>();private readonly names=new Map<string,string>();private readonly calls=new Map<string,CallRecord>();
 private readonly pending=new Set<Promise<any>>();private readonly onEvent?:ConversationHarnessOptions['onEvent'];private readonly root?:string;
 private seq=0;private turnCount=0;private callCount=0;private childSequence=0;private stateVersion=0;
 constructor(options:ConversationHarnessOptions){
  if(!contextId.test(options.runId))throw fault('INVALID_HARNESS','runId must be a bounded protocol identifier.');
  if(!options.driver||typeof options.driver.send!=='function')throw fault('INVALID_HARNESS','A harness driver is required.');
  this.runId=options.runId;this.driver=options.driver;this.maxAgents=this.bound(options.maxAgents,4,1,4,'maxAgents');this.maxTurns=this.bound(options.maxTurns,40,1,40,'maxTurns');this.maxCalls=this.bound(options.maxCalls,64,1,64,'maxCalls');this.onEvent=options.onEvent;
  if(options.directory){this.root=resolve(options.directory);if(existsSync(this.root)&&lstatSync(this.root).isSymbolicLink())throw fault('UNSAFE_HARNESS_PATH','Harness directory cannot be a symlink.');privateDir(this.root);chmodSync(this.root,0o700);}
  this.addAgent({id:'parent',name:'parent'},'Parent conversation coordinator.');this.record('run.started','parent',{limits:{agents:this.maxAgents,turns:this.maxTurns,calls:this.maxCalls}});
 }
 private bound(value:number|undefined,fallback:number,min:number,max:number,label:string){const n=value??fallback;if(!Number.isSafeInteger(n)||n<min||n>max)throw fault('INVALID_HARNESS',label+' must be an integer from '+min+' to '+max+'.');return n;}
 private addAgent(identity:HarnessAgent,task:string){const record:AgentRecord={...identity,task,bootstrapped:false,status:'idle',turns:0,tail:Promise.resolve(),inbox:[]};this.agents.set(identity.id,record);this.names.set(identity.name.toLowerCase(),identity.id);return record;}
 private getAgent(id:string){const agent=this.agents.get(id);if(!agent)throw fault('AGENT_NOT_FOUND','Unknown harness agent '+id+'.');return agent;}
 private record(type:string,agentId:string,fields:Record<string,any>={}){
  const event:HarnessEvent={seq:++this.seq,at:new Date().toISOString(),runId:this.runId,type,agentId,...fields};
  if(['agent.created','agent.status','turn.completed','turn.failed','agent.message.queued'].includes(type))this.stateVersion++;
  if(this.root){const path=join(this.root,this.runId+'.events.jsonl');appendFileSync(path,JSON.stringify(event)+'\n',{mode:0o600});chmodSync(path,0o600);}
  try{this.onEvent?.(event);}catch{}this.persist();return event;
 }
 private persist(){if(this.root)atomicJSON(join(this.root,this.runId+'.snapshot.json'),this.snapshot());}
 private track<T>(promise:Promise<T>){this.pending.add(promise);promise.finally(()=>{this.pending.delete(promise);this.persist();}).catch(()=>{});return promise;}
 private enqueueRaw(agent:AgentRecord,text:string,kind:'bootstrap'|'turn'|'tool-result'|'agent-message',gate?:Promise<void>){
  requiredText(text,'Harness turn');const previous=agent.tail;
  const scheduled=previous.then(async()=>{
   if(gate)await gate;if(this.turnCount>=this.maxTurns)throw fault('TURN_LIMIT','Harness turn limit of '+this.maxTurns+' was reached.');
   this.turnCount++;agent.turns++;agent.status='running';const turnId='turn-'+this.turnCount;this.record('agent.status',agent.id,{status:'running'});this.record('turn.started',agent.id,{turnId,kind});
   let protocol='',source:'stream'|'final'='stream';const protocolChannel=this.driver.protocolChannel===true,emitted=new Map<string,string>();
   const failProtocol=(detail:{code:string;message:string;callId?:string})=>{this.record('protocol.error',agent.id,{turnId,error:detail,...(detail.callId?{callId:detail.callId}:{})});throw Object.assign(fault('TOOL_PROTOCOL_ERROR',detail.message),{causeCode:detail.code,...(detail.callId?{callId:detail.callId}:{})});};
   const scanProtocol=(final:boolean)=>{
    if(kind==='bootstrap')return;const candidates:ToolCall[]=[],errors:ToolProtocolError[]=[];
    const parser=new StreamToolParser({runId:this.runId,agentId:agent.id,onCall:call=>candidates.push(call),onError:error=>errors.push(error)});parser.replace(protocol);if(final)parser.finish();
    // Semantic DOM replacements can contain a temporary renderer newline inside an
    // unfinished tag. Only a fresh, clean observation may dispatch a call; final text is strict.
    if(errors.length){if(final)failProtocol(errors[0]);return;}
    const observed=new Map(candidates.map(call=>[call.id,hash({tool:call.tool,args:call.args})]));
    for(const call of candidates){const signature=observed.get(call.id)!,previous=emitted.get(call.id);if(previous!==undefined){if(previous!==signature)failProtocol({code:'CALL_ID_CONFLICT',message:'Tool call ID was revised after it was dispatched.',callId:call.id});continue;}emitted.set(call.id,signature);void this.acceptCall(agent,call,source,turnId);}
    if(final)for(const [callId,signature] of emitted)if(observed.get(callId)!==signature)failProtocol({code:'FINAL_CALL_MISMATCH',message:'Final website reply omitted or revised a tool call already dispatched.',callId});
   };
   try{
    const result=await this.driver.send({id:agent.id,name:agent.name,...(agent.parentId?{parentId:agent.parentId}:{})},text,event=>{
     this.record('turn.event',agent.id,{turnId,event});
     if(protocolChannel){if(event?.type==='protocol.text'){protocol+=String(event.text||'');scanProtocol(false);}else if(event?.type==='protocol.replace'){protocol=String(event.text||'');scanProtocol(false);}}
     else if(event?.type==='text'){protocol+=String(event.text||'');scanProtocol(false);}else if(event?.type==='replace'){protocol=String(event.text||'');scanProtocol(false);}
    });
    source='final';const finalProtocol=protocolChannel?result?.protocolText:result?.text;if(typeof finalProtocol==='string')protocol=finalProtocol;scanProtocol(true);agent.status='idle';this.record('turn.completed',agent.id,{turnId,kind,result});this.record('agent.status',agent.id,{status:'idle'});return result;
   }catch(error){agent.status='failed';this.record('turn.failed',agent.id,{turnId,kind,error:publicError(error)});this.record('agent.status',agent.id,{status:'failed'});throw error;}
  });
  agent.tail=scheduled.then(()=>{},()=>{});this.track(scheduled);return scheduled;
 }
 private ensureBootstrap(agent:AgentRecord,task:string){
  if(agent.bootstrapped)return Promise.resolve();if(agent.bootstrapPromise)return agent.bootstrapPromise;
  const text=harnessBootstrap({runId:this.runId,agentId:agent.id,...(agent.parentId?{parentId:agent.parentId}:{}),task})+'\n\nFor this bootstrap turn only, acknowledge protocol readiness. Do not execute the assignment and do not emit a tool_call. The task arrives in the next user turn.';
  const sent=this.enqueueRaw(agent,text,'bootstrap');
  const ready=sent.then(()=>{agent.bootstrapped=true;this.record('agent.status',agent.id,{status:'idle',bootstrapped:true});},error=>{agent.bootstrapPromise=undefined;throw error;});
  agent.bootstrapPromise=ready;this.track(ready);return ready;
 }
 turn(agentId:string,text:string){const agent=this.getAgent(agentId),message=requiredText(text,'Turn text'),bootstrap=this.ensureBootstrap(agent,agent.task==='Parent conversation coordinator.'?message:agent.task);return this.enqueueRaw(agent,message,'turn',bootstrap);}
 private route(agent:AgentRecord,event:Omit<HarnessEvent,'seq'|'at'|'runId'|'agentId'>,frame:string,kind:'tool-result'|'agent-message'){
  const delivered=this.record(event.type,agent.id,Object.fromEntries(Object.entries(event).filter(([key])=>key!=='type')));agent.inbox.push(delivered);this.record('agent.message.queued',agent.id,{kind,sourceType:event.type,...('callId' in event?{callId:(event as any).callId}:{})});this.persist();
  if(agent.id!=='parent')this.enqueueRaw(agent,frame,kind,this.ensureBootstrap(agent,agent.task)).catch(()=>{});
 }
 private acceptCall(agent:AgentRecord,call:ToolCall,source:'stream'|'final',turnId:string){
  const key=agent.id+':'+call.id,signature=hash({tool:call.tool,args:call.args}),prior=this.calls.get(key);
  if(prior){if(prior.signature!==signature){const error={code:'CALL_ID_CONFLICT',message:'Tool call ID was reused with different tool or arguments.'};this.route(agent,{type:'tool.error',turnId,callId:call.id,tool:call.tool,ok:false,error},errorFrame(this.runId,call.id,error),'tool-result');}return Promise.resolve();}
  if(this.callCount>=this.maxCalls){const error={code:'CALL_LIMIT',message:'Harness tool call limit of '+this.maxCalls+' was reached.'};this.route(agent,{type:'tool.error',turnId,callId:call.id,tool:call.tool,ok:false,error},errorFrame(this.runId,call.id,error),'tool-result');return Promise.resolve();}
  this.callCount++;const record:CallRecord={signature,status:'running',tool:call.tool};this.calls.set(key,record);this.record('tool.call',agent.id,{turnId,callId:call.id,tool:call.tool,args:call.args,source});
  const work=(async()=>{try{const result=await this.executeTool(agent,call);record.status='complete';record.result=result;this.route(agent,{type:'tool.result',turnId,callId:call.id,tool:call.tool,ok:true,result},resultFrame(this.runId,call.id,result),'tool-result');}
   catch(error){const detail=publicError(error);record.status='error';record.error=detail;this.route(agent,{type:'tool.error',turnId,callId:call.id,tool:call.tool,ok:false,error:detail},errorFrame(this.runId,call.id,detail),'tool-result');}})();
  return this.track(work);
 }
 private resolveTarget(args:Record<string,unknown>){exactArgs(args,['agentId','name','message']);const hasId=typeof args.agentId==='string'&&!!args.agentId,hasName=typeof args.name==='string'&&!!args.name;if(hasId===hasName)throw fault('INVALID_TOOL_ARGS','agents.send requires exactly one agentId or name.');const id=hasId?String(args.agentId):this.names.get(String(args.name).toLowerCase());return id?this.agents.get(id):undefined;}
 private registrySnapshot(){return {agents:[...this.agents.values()].map(agent=>({id:agent.id,name:agent.name,...(agent.parentId?{parentId:agent.parentId}:{}),status:agent.status,bootstrapped:agent.bootstrapped,turns:agent.turns}))};}
 private async executeTool(requester:AgentRecord,call:ToolCall){
  const args=call.args;
  if(call.tool==='echo'){exactArgs(args,['value']);if(!Object.hasOwn(args,'value'))throw fault('INVALID_TOOL_ARGS','echo requires value.');return {value:args.value};}
  if(call.tool==='agents.list'){exactArgs(args,[]);return this.registrySnapshot();}
  if(call.tool==='agents.create'){
   exactArgs(args,['name','task']);const task=requiredText(args.task,'agents.create task');if(this.agents.size>=this.maxAgents)throw fault('AGENT_LIMIT','Harness agent limit of '+this.maxAgents+' was reached.');
   const proposed=args.name===undefined?'agent-'+(this.childSequence+1):requiredText(args.name,'agents.create name').trim();if(proposed.length>64)throw fault('INVALID_TOOL_ARGS','Agent name is too long.');if(this.names.has(proposed.toLowerCase()))throw fault('AGENT_EXISTS','Agent name already exists.');
   const id='agent-'+(++this.childSequence);this.addAgent({id,name:proposed,parentId:requester.id},task);this.record('agent.created',requester.id,{child:{id,name:proposed,parentId:requester.id}});
   this.turn(id,task).then(result=>{const value={fromAgentId:id,fromName:proposed,text:String(result?.text||'')};this.route(requester,{type:'agent.message',...value},messageFrame(this.runId,value),'agent-message');},error=>{const value={fromAgentId:id,fromName:proposed,error:publicError(error)};this.route(requester,{type:'agent.message',...value},messageFrame(this.runId,value),'agent-message');});
   return {agentId:id,name:proposed,status:'scheduled'};
  }
  if(call.tool==='agents.send'){
   const message=requiredText(args.message,'agents.send message'),target=this.resolveTarget(args);if(!target)throw fault('AGENT_NOT_FOUND','agents.send target does not exist.');
   if(target.id==='parent'){const value={fromAgentId:requester.id,fromName:requester.name,text:message};this.route(target,{type:'agent.message',...value},messageFrame(this.runId,value),'agent-message');return {delivered:true,agentId:target.id};}
   this.turn(target.id,message).then(result=>{const value={fromAgentId:target.id,fromName:target.name,text:String(result?.text||'')};this.route(requester,{type:'agent.message',...value},messageFrame(this.runId,value),'agent-message');},error=>{const value={fromAgentId:target.id,fromName:target.name,error:publicError(error)};this.route(requester,{type:'agent.message',...value},messageFrame(this.runId,value),'agent-message');});return {delivered:true,agentId:target.id};
  }
  if(call.tool==='agents.wait'){
   exactArgs(args,['milliseconds']);const milliseconds=args.milliseconds;if(!Number.isSafeInteger(milliseconds)||Number(milliseconds)<0||Number(milliseconds)>5000)throw fault('INVALID_TOOL_ARGS','agents.wait milliseconds must be an integer from 0 to 5000.');
   const started=Date.now(),version=this.stateVersion;while(this.stateVersion===version&&Date.now()-started<Number(milliseconds)){const remaining=Number(milliseconds)-(Date.now()-started);await sleep(Math.min(20,remaining));}
   return {waitedMs:Date.now()-started,changed:this.stateVersion!==version,...this.registrySnapshot()};
  }
  throw fault('TOOL_NOT_ALLOWED','Tool '+call.tool+' is not available in this harness.');
 }
 drain(agentId:string){const agent=this.getAgent(agentId),events=agent.inbox.splice(0);this.persist();return events;}
 async waitForIdle(timeoutMs:number){if(!Number.isFinite(timeoutMs)||timeoutMs<0)throw fault('INVALID_TIMEOUT','timeoutMs must be a non-negative finite number.');const deadline=Date.now()+timeoutMs;for(;;){if(!this.pending.size)return true;const remaining=deadline-Date.now();if(remaining<=0)return false;await Promise.race([Promise.allSettled([...this.pending]),sleep(Math.min(remaining,20))]);}}
 snapshot(){return {schema:1,runId:this.runId,limits:{maxAgents:this.maxAgents,maxTurns:this.maxTurns,maxCalls:this.maxCalls},counts:{agents:this.agents.size,turns:this.turnCount,calls:this.callCount,pending:this.pending.size},agents:[...this.agents.values()].map(agent=>({id:agent.id,name:agent.name,...(agent.parentId?{parentId:agent.parentId}:{}),bootstrapped:agent.bootstrapped,status:agent.status,turns:agent.turns,inbox:[...agent.inbox]})),calls:[...this.calls.entries()].map(([key,value])=>({key,status:value.status,tool:value.tool,signature:value.signature,...(value.result!==undefined?{result:value.result}:{}),...(value.error?{error:value.error}:{})})),sequence:this.seq,updated:new Date().toISOString()};}
}
