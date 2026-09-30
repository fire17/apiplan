import {randomUUID} from 'node:crypto';
import {realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {serve} from '../../src/api.ts';
if(process.env.APIPLAN_ONLINE_LIVE!=='1')throw new Error('Set APIPLAN_ONLINE_LIVE=1 to authorize this opt-in live website test.');
const runtime=realpathSync(process.env.APIPLAN_OM_RUNTIME||join(homedir(),'.om/runtime-current'));
const {Agent}=await import(join(runtime,'node_modules/@oh-my-pi/pi-agent-core/src/agent.ts'));
const {buildModel}=await import(join(runtime,'node_modules/@oh-my-pi/pi-catalog/src/build.ts'));
const runId='online-om-live-'+Date.now(),modelId=process.env.ONLINE_TEST_MODEL||'online-chat-latest';
if(modelId!=='online-chat-latest')throw new Error('Live tests are restricted to Chat/Instant while Work quota is exhausted.');
const resultPath=process.env.APIPLAN_ONLINE_LIVE_RECEIPT||join(tmpdir(),runId+'.json');
const evidence:any={runId,runtime,modelId,started:new Date().toISOString(),rounds:[],events:{},toolExecutions:[],requests:[],complete:false};
const log=(event:any)=>process.stdout.write(JSON.stringify({at:new Date().toISOString(),...event})+'\n');
const persist=()=>writeFileSync(resultPath,JSON.stringify(evidence,null,2),{mode:0o600});
const server=serve({port:0,host:'127.0.0.1',token:'online-test-local'});
const model=buildModel({id:modelId,name:modelId,api:'anthropic-messages',provider:'apiplan',baseUrl:'http://127.0.0.1:'+server.port,reasoning:true,input:['text'],contextWindow:32000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},thinking:{mode:'anthropic-adaptive',efforts:['low']}});
const answers=new Map<number,string>();
const tool={name:'lookup_probe',label:'Local synthetic probe',description:'Return the real unpredictable probe value for a requested round. Call exactly once per requested round, then report its actual returned value.',parameters:{type:'object',properties:{round:{type:'integer',minimum:1,maximum:5}},required:['round'],additionalProperties:false},execute:async(id:string,args:any)=>{if(answers.has(args.round))throw new Error('Duplicate execution for round '+args.round);const value=randomUUID().replaceAll('-','').slice(0,16);answers.set(args.round,value);evidence.toolExecutions.push({id,round:args.round,value,at:new Date().toISOString()});persist();log({type:'tool.executed',round:args.round,id});return {content:[{type:'text',text:JSON.stringify({round:args.round,value})}],details:{round:args.round}};}};
const agent=new Agent({initialState:{model,systemPrompt:'You are testing the real APIPlan website provider with the real OM agent loop. Use only the provided lookup_probe tool for requested values. Never invent its result. Follow the current user instruction. No setup acknowledgment.',thinkingLevel:'low',tools:[tool],messages:[]},sessionId:runId,getApiKey:()=> 'online-test-local',onPayload:(payload:any)=>{evidence.requests.push({at:new Date().toISOString(),messageCount:payload.messages?.length,toolCount:payload.tools?.length,effort:payload.output_config?.effort});persist();log({type:'request',number:evidence.requests.length,messages:payload.messages?.length});}});
agent.subscribe((event:any)=>{evidence.events[event.type]=(evidence.events[event.type]||0)+1;if(['turn_start','turn_end','tool_execution_start','tool_execution_end','agent_end'].includes(event.type))log({type:event.type,...(event.toolName?{tool:event.toolName}:{})});});
const deadline=setTimeout(()=>agent.abort(),18*60*1000);
process.on('SIGTERM',()=>agent.abort());
process.on('SIGINT',()=>agent.abort());
try{
 log({type:'started',runId,modelId,runtime,resultPath,port:server.port});
 if(process.env.ONLINE_TEST_SETUP_ONLY==='1'){evidence.setupOnly=true;log({type:'setup.ok'});}
 else for(let round=1;round<=5;round++){
  const start=Date.now();await agent.prompt(`Round ${round} of 5. Call lookup_probe with round=${round} exactly once. When its actual result arrives, reply with exactly ROUND_${round}: followed by the returned value, no spaces or formatting. Keep earlier rounds in context. Run identifier ${runId}.`);
  const messages=agent.state.messages,final=[...messages].reverse().find((message:any)=>message.role==='assistant'),text=(final?.content||[]).filter((part:any)=>part.type==='text').map((part:any)=>part.text).join('');
  const expected='ROUND_'+round+':'+answers.get(round),ok=answers.has(round)&&text.trim()===expected&&!final?.errorMessage&&final?.stopReason==='stop';
  evidence.rounds.push({round,ok,elapsedMs:Date.now()-start,stopReason:final?.stopReason,error:final?.errorMessage,text,expected,messages:messages.length});persist();log({type:'round.completed',round,ok,elapsedMs:Date.now()-start,stopReason:final?.stopReason,error:final?.errorMessage});
  if(!ok)throw new Error('Round '+round+' failed; inspect '+resultPath);
 }
 evidence.complete=evidence.rounds.length===5&&evidence.toolExecutions.length===5;evidence.finished=new Date().toISOString();persist();log({type:'finished',complete:evidence.complete,resultPath,rounds:evidence.rounds.length});
}catch(error:any){evidence.error=error.message;evidence.finished=new Date().toISOString();persist();log({type:'failed',error:error.message,resultPath});process.exitCode=1;}finally{clearTimeout(deadline);agent.abort();server.stop(true);}
