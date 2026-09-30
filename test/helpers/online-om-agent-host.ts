import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const root=mkdtempSync(join(tmpdir(),'apiplan-online-om-agent-'));
process.env.APIPLAN_HOME=join(root,'apiplan');
process.env.CHATGPT_HOME=join(root,'chatgpt');
process.env.APIPLAN_API_KEY='';
process.env.APIPLAN_KEYCHAIN_SERVICE='apiplan-online-agent-proof-no-keychain';
process.env.APIPLAN_GOOGLE_KEYCHAIN_SERVICE='apiplan-online-agent-proof-no-keychain';
process.env.APIPLAN_ANTHROPIC_CRED_FILE=join(root,'no-anthropic.json');
process.env.APIPLAN_CODEX_AUTH=join(root,'no-codex.json');
process.env.APIPLAN_GOOGLE_CRED_FILE=join(root,'no-google.json');

const account={id:'proof',label:'Proof account',baseURL:'https://chatgpt.com',cdpURL:'http://127.0.0.1:9222',transportMode:'attached',workspace:'workspace-proof',userId:'user-proof',created:new Date().toISOString()};
mkdirSync(join(root,'chatgpt'),{recursive:true});
await Bun.write(join(root,'chatgpt','accounts.json'),JSON.stringify({version:1,selected:'proof',accounts:[account]}));

const requestedRuntime=process.env.APIPLAN_OM_RUNTIME||'/Users/magic/.om/runtime-current';
const runtime=realpathSync(requestedRuntime);
const [{Agent},{buildModel},{serve},{PROVIDERS},{openOnlineRequest}]=await Promise.all([
 import(join(runtime,'node_modules/@oh-my-pi/pi-agent-core/src/agent.ts')),
 import(join(runtime,'node_modules/@oh-my-pi/pi-catalog/src/build.ts')),
 import('../../src/api.ts'),
 import('../../src/providers.ts'),
 import('../../src/chatgpt/online-runtime.ts'),
]);

type HistoryTurn={role:string;text:string;tool_calls?:Array<{id:string;name:string;input:any}>;tool_results?:Array<{toolUseId:string;content:any;isError?:boolean}>};
const historyFrom=(prompt:string):HistoryTurn[]=>JSON.parse(prompt.slice(prompt.lastIndexOf('HISTORY_JSON ')+13).split('\n\nContinue')[0]!);
const resultText=(content:any):string=>typeof content==='string'?content:Array.isArray(content)?content.filter(part=>part?.type==='text').map(part=>part.text).join(''):'';
const valueFrom=(result:{content:any})=>JSON.parse(resultText(result.content)).value as string;
const proof:any={version:1,runtime,started:new Date().toISOString(),requests:[],executions:[],events:{},closedDrivers:0};
let abortMode=false,abortDriverStartedResolve!:()=>void;
const abortDriverStarted=new Promise<void>(resolve=>{abortDriverStartedResolve=resolve;});
const driverDirectory=join(root,'driver');
const dependencies={
 account:()=>account,
 root:()=>driverDirectory,
 driver:async(_account:any,options:any)=>{
  let closed=false,rejectPending:((error:Error)=>void)|undefined;
  return {
   close:async()=>{if(closed)return;closed=true;proof.closedDrivers++;rejectPending?.(new Error('fixture driver closed'));},
   send:async(_agent:any,prompt:string,emit:(event:any)=>void)=>{
    const history=historyFrom(prompt),toolCalls=history.flatMap(turn=>turn.tool_calls||[]),toolResults=history.flatMap(turn=>turn.tool_results||[]);
    proof.requests.push({mode:options.mode,model:options.model,effort:options.effort,toolCallIds:toolCalls.map(call=>call.id),toolResultIds:toolResults.map(result=>result.toolUseId),roles:history.map(turn=>turn.role)});
    emit({type:'submitted',verified:true,conversation:'fixture-conversation'});
    if(abortMode){abortDriverStartedResolve();return await new Promise((_resolve,reject)=>{rejectPending=reject;});}
    for(let index=0;index<toolResults.length;index++){
     if(toolCalls[index]?.id!==`call-${index+1}`||toolResults[index]?.toolUseId!==toolCalls[index]?.id)throw new Error('Tool history correlation failed at '+index);
    }
    const run=/<tool_call run="([^"]+)">/.exec(prompt)?.[1];if(!run)throw new Error('Missing bound online run ID');
    if(toolResults.length<6){
     const round=toolResults.length+1,id=`call-${round}`,frame=`<tool_call run="${run}">\n${JSON.stringify({id,tool:'lookup_probe',args:{round}})}\n</tool_call>`;
     for(const char of frame)emit({type:'protocol.text',text:char});
     return {text:frame,displayText:frame,authoritativeText:frame,protocolText:frame,conversation:'fixture-conversation',url:'https://chatgpt.com/c/fixture-conversation',driver:{submission:{verified:true},selection:options}};
    }
    const values=toolResults.map(valueFrom),text='FINAL:'+values.join(',');
    for(const char of text)emit({type:'text',text:char});
    return {text,displayText:text,authoritativeText:text,protocolText:'',conversation:'fixture-conversation',url:'https://chatgpt.com/c/fixture-conversation',driver:{submission:{verified:true},selection:options}};
   },
  };
 },
};
const originalOpen=PROVIDERS.online.open;
PROVIDERS.online.open=(built:any,signal?:AbortSignal)=>openOnlineRequest(built,signal,dependencies as any);
const server=serve({port:0,host:'127.0.0.1',token:'proof-token'});
const model=buildModel({id:'online-gpt-6-astra',name:'Online Astra',api:'anthropic-messages',provider:'apiplan',baseUrl:`http://127.0.0.1:${server.port}`,reasoning:true,input:['text'],contextWindow:32000,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},thinking:{mode:'anthropic-adaptive',efforts:['low']}});
const tool={name:'lookup_probe',label:'Local random lookup',description:'Return a fresh harmless local value for the requested round.',intent:'omit',parameters:{type:'object',properties:{round:{type:'integer',minimum:1,maximum:6}},required:['round'],additionalProperties:false},execute:async(id:string,args:any)=>{const value=randomUUID().replaceAll('-','').slice(0,16);proof.executions.push({id,round:args.round,value});return {content:[{type:'text',text:JSON.stringify({round:args.round,value})}],details:{round:args.round}};}};
const makeAgent=()=>new Agent({initialState:{model,systemPrompt:['Use the supplied local tool. Never invent its result.'],thinkingLevel:'low',tools:[tool],messages:[]},sessionId:'online-om-agent-proof',getApiKey:()=>'proof-token'});

try{
 const agent=makeAgent();agent.subscribe((event:any)=>{proof.events[event.type]=(proof.events[event.type]||0)+1;});
 await agent.prompt('Call lookup_probe for rounds 1 through 6, one dependent round at a time. After all six real results, answer exactly FINAL:<value1>,<value2>,<value3>,<value4>,<value5>,<value6>.');
 const final=[...agent.state.messages].reverse().find((message:any)=>message.role==='assistant');
 const finalText=(final?.content||[]).filter((block:any)=>block.type==='text').map((block:any)=>block.text).join('');
 const expected='FINAL:'+proof.executions.map((row:any)=>row.value).join(',');
 proof.sequence={ok:finalText===expected&&proof.executions.length===6&&proof.requests.length===7,finalText,expected,messageCount:agent.state.messages.length};

 abortMode=true;const abortAgent=makeAgent();const prompt=abortAgent.prompt('Start one lookup_probe call for an abort propagation proof.');
 await abortDriverStarted;const began=Date.now();abortAgent.abort('fixture-user-cancel');await Promise.race([prompt,new Promise((_,reject)=>setTimeout(()=>reject(new Error('OM abort did not settle')),2000))]);
 const abortLast=[...abortAgent.state.messages].reverse().find((message:any)=>message.role==='assistant');
 let control:any;for(let i=0;i<50;i++){control=await (await fetch(`http://127.0.0.1:${server.port}/_apiplan/control`)).json();if(control.activeRequests===0)break;await Bun.sleep(20);}
 proof.abort={elapsedMs:Date.now()-began,stopReason:abortLast?.stopReason,errorMessage:abortLast?.errorMessage,activeRequests:control?.activeRequests,requestCountAfterAbort:proof.requests.length};
 proof.complete=proof.sequence.ok&&proof.abort.stopReason==='aborted'&&proof.abort.activeRequests===0&&proof.abort.requestCountAfterAbort===8&&proof.events.tool_execution_start===6&&proof.events.tool_execution_end===6;
 proof.finished=new Date().toISOString();
 if(process.env.APIPLAN_OM_AGENT_RECEIPT)await Bun.write(process.env.APIPLAN_OM_AGENT_RECEIPT,JSON.stringify(proof,null,2)+'\n');
 process.stdout.write(JSON.stringify(proof)+'\n');
 if(!proof.complete)process.exitCode=1;
}catch(error:any){proof.complete=false;proof.error=error?.stack||String(error);if(process.env.APIPLAN_OM_AGENT_RECEIPT)await Bun.write(process.env.APIPLAN_OM_AGENT_RECEIPT,JSON.stringify(proof,null,2)+'\n');process.stdout.write(JSON.stringify(proof)+'\n');process.exitCode=1;}
finally{PROVIDERS.online.open=originalOpen;server.stop(true);rmSync(root,{recursive:true,force:true});}
