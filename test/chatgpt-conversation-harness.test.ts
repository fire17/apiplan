import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationHarness,type HarnessAgent,type HarnessEvent} from '../src/chatgpt/conversation-harness.ts';
const frame=(runId:string,id:string,tool:string,args:Record<string,unknown>)=>`<tool_call run="${runId}">
${JSON.stringify({id,tool,args})}
</tool_call>`;
const until=async(test:()=>boolean,ms=1000)=>{const end=Date.now()+ms;while(!test()&&Date.now()<end)await Bun.sleep(1);expect(test()).toBe(true);};
const deferred=()=>{let resolve!:(value?:any)=>void;return {promise:new Promise<any>(r=>resolve=r),resolve};};

test('first turn is ack-only bootstrap, then exact task; streaming calls dispatch before settlement with provenance',async()=>{
 const events:HarnessEvent[]=[],calls:Array<{agent:HarnessAgent;text:string}>=[],release=deferred();let settled=false;
 const harness=new ConversationHarness({runId:'stream-run',onEvent:event=>events.push(event),driver:{async send(agent,text,emit){
  calls.push({agent,text});if(text.includes('ASSIGNMENT_JSON'))return {text:'PROTOCOL READY'};
  const value=frame('stream-run','p-call-1','echo',{value:'שלום 🌍'});emit({type:'text',text:value.slice(0,25)});emit({type:'text',text:value.slice(25)});await release.promise;settled=true;return {text:value,conversation:'parent-chat'};
 }}});
 const turn=harness.turn('parent','stage one exactly once');await until(()=>events.some(event=>event.type==='tool.call'));
 const call=events.find(event=>event.type==='tool.call')!;expect(call).toMatchObject({agentId:'parent',callId:'p-call-1',source:'stream'});expect(call.turnId).toMatch(/^turn-/);expect(settled).toBe(false);
 await until(()=>harness.snapshot().agents[0].inbox.some((event:any)=>event.type==='tool.result'));
 expect(calls).toHaveLength(2);expect(calls[0].text).toContain('acknowledge protocol readiness');expect(calls[0].text).toContain('Do not execute the assignment');expect(calls[1].text).toBe('stage one exactly once');
 release.resolve();await turn;expect(events.filter(event=>event.type==='tool.call')).toHaveLength(1);
 const inbox=harness.drain('parent');expect(inbox.find(event=>event.type==='tool.result')).toMatchObject({callId:'p-call-1',ok:true,result:{value:'שלום 🌍'}});
});

test('five parent turns serialize after one bootstrap and exact replay is run-wide idempotent',async()=>{
 const sends:string[]=[],events:HarnessEvent[]=[];let actual=0;
 const harness=new ConversationHarness({runId:'five-turns',onEvent:event=>events.push(event),driver:{async send(_agent,text,emit){sends.push(text);if(text.includes('ASSIGNMENT_JSON'))return {text:'READY'};actual++;const id=actual===3?'same-call':'same-call',reply=actual===2||actual===3?frame('five-turns',id,'echo',{value:1}):'answer '+actual;if(actual===2||actual===3)emit({type:'text',text:reply});return {text:reply};}}});
 for(let i=1;i<=5;i++)await harness.turn('parent','parent stage '+i);
 await harness.waitForIdle(1000);expect(sends).toHaveLength(6);expect(sends.filter(text=>text.includes('ASSIGNMENT_JSON'))).toHaveLength(1);expect(sends.slice(1)).toEqual([1,2,3,4,5].map(i=>'parent stage '+i));
 expect(events.filter(event=>event.type==='tool.call'&&event.callId==='same-call')).toHaveLength(1);expect(harness.snapshot().counts.turns).toBe(6);
});

test('two children bootstrap first and run in parallel; acknowledgments precede delayed child messages',async()=>{
 const events:HarnessEvent[]=[],sends:Array<{id:string;text:string}>=[],release=deferred();let active=0,maxActive=0,started=0;
 const parentCalls=frame('children','create-a','agents.create',{name:'alpha',task:'alpha task'})+'\n'+frame('children','create-b','agents.create',{name:'beta',task:'beta task'});
 const harness=new ConversationHarness({runId:'children',onEvent:event=>events.push(event),driver:{async send(agent,text,emit){
  sends.push({id:agent.id,text});if(text.includes('ASSIGNMENT_JSON'))return {text:'READY'};
  if(agent.id==='parent'){emit({type:'text',text:parentCalls});return {text:parentCalls};}
  started++;active++;maxActive=Math.max(maxActive,active);await release.promise;active--;return {text:agent.name+' complete'};
 }}});
 await harness.turn('parent','create both');await until(()=>started===2);
 const early=harness.drain('parent');expect(early.filter(event=>event.type==='tool.result')).toHaveLength(2);expect(early.filter(event=>event.type==='agent.message')).toHaveLength(0);expect(maxActive).toBe(2);expect(await harness.waitForIdle(2)).toBe(false);
 for(const id of ['agent-1','agent-2']){const own=sends.filter(send=>send.id===id);expect(own[0].text).toContain('ASSIGNMENT_JSON');expect(own[0].text).toContain('Do not execute the assignment');expect(own[1].text).toBe(id==='agent-1'?'alpha task':'beta task');}
 release.resolve();expect(await harness.waitForIdle(1000)).toBe(true);
 const late=harness.drain('parent');expect(late.filter(event=>event.type==='agent.message').map(event=>event.fromName).sort()).toEqual(['alpha','beta']);
});

test('child tool results wait behind its active turn and agents.send to parent only enters the parent mailbox',async()=>{
 const sends:Array<{id:string;text:string}>=[],taskRelease=deferred(),events:HarnessEvent[]=[];let taskStarted=false;
 const create=frame('routing','create','agents.create',{name:'worker',task:'do work'});
 const childCalls=frame('routing','echo','echo',{value:42})+'\n'+frame('routing','mail','agents.send',{agentId:'parent',message:'child notice'});
 const harness=new ConversationHarness({runId:'routing',onEvent:event=>events.push(event),driver:{async send(agent,text,emit){
  sends.push({id:agent.id,text});if(text.includes('ASSIGNMENT_JSON'))return {text:'READY'};if(agent.id==='parent'){emit({type:'text',text:create});return {text:create};}
  if(text==='do work'){taskStarted=true;emit({type:'text',text:childCalls});await taskRelease.promise;return {text:childCalls};}
  return {text:'child consumed routed data'};
 }}});
 await harness.turn('parent','create');await until(()=>taskStarted);await until(()=>events.some(event=>event.type==='tool.result'&&event.agentId==='agent-1'&&event.callId==='echo'));
 expect(sends.filter(send=>send.id==='agent-1')).toHaveLength(2);
 const beforeParent=sends.filter(send=>send.id==='parent').length;const early=harness.drain('parent');expect(early.some(event=>event.type==='agent.message'&&event.text==='child notice')).toBe(true);expect(sends.filter(send=>send.id==='parent')).toHaveLength(beforeParent);
 taskRelease.resolve();expect(await harness.waitForIdle(1000)).toBe(true);
 const child=sends.filter(send=>send.id==='agent-1');expect(child[2].text).toContain('"callId":"echo"');expect(child[2].text).toContain('"ok":true');expect(child[3].text).toContain('"callId":"mail"');
});

test('final-text fallback is marked final; conflicts, unknown tools and limits fail closed once',async()=>{
 const outputs=[
  frame('limits','fallback','echo',{value:'final'}),
  frame('limits','fallback','echo',{value:'changed'}),
  frame('limits','unknown','shell.exec',{command:'id'}),
  frame('limits','too-many','echo',{value:2}),
 ];
 let index=0;const events:HarnessEvent[]=[];
 const harness=new ConversationHarness({runId:'limits',maxCalls:2,maxAgents:1,maxTurns:10,onEvent:event=>events.push(event),driver:{async send(_agent,text){if(text.includes('ASSIGNMENT_JSON'))return {text:'READY'};return {text:outputs[index++]};}}});
 for(let i=0;i<4;i++)await harness.turn('parent','turn '+i);await harness.waitForIdle(1000);
 expect(events.find(event=>event.type==='tool.call'&&event.callId==='fallback')).toMatchObject({source:'final'});
 expect(events.filter(event=>event.type==='tool.call'&&event.callId==='fallback')).toHaveLength(1);
 expect(events.some(event=>event.type==='tool.error'&&event.error?.code==='CALL_ID_CONFLICT')).toBe(true);
 expect(events.some(event=>event.type==='tool.error'&&event.error?.code==='TOOL_NOT_ALLOWED')).toBe(true);
 expect(events.some(event=>event.type==='tool.error'&&event.error?.code==='CALL_LIMIT')).toBe(true);
 expect(harness.snapshot().counts.calls).toBe(2);
});

test('wait is bounded, failed sends do not retry, turn/message bounds reject before side effects',async()=>{
 const events:HarnessEvent[]=[],calls:string[]=[];let fail=false;
 const harness=new ConversationHarness({runId:'failures',maxTurns:3,onEvent:event=>events.push(event),driver:{async send(_agent,text,emit){calls.push(text);if(text.includes('ASSIGNMENT_JSON'))return {text:'READY'};if(fail)throw Object.assign(new Error('uncertain'),{code:'OUTCOME_UNKNOWN'});const reply=frame('failures','bad-wait','agents.wait',{milliseconds:5001});emit({type:'text',text:reply});return {text:reply};}}});
 await harness.turn('parent','bad wait');await harness.waitForIdle(1000);expect(events.some(event=>event.type==='tool.error'&&event.error?.code==='INVALID_TOOL_ARGS')).toBe(true);
 fail=true;await expect(harness.turn('parent','uncertain once')).rejects.toMatchObject({code:'OUTCOME_UNKNOWN'});expect(calls.filter(text=>text==='uncertain once')).toHaveLength(1);
 await expect(harness.turn('parent','over turn limit')).rejects.toMatchObject({code:'TURN_LIMIT'});expect(calls.filter(text=>text==='over turn limit')).toHaveLength(0);
 expect(()=>harness.turn('parent','x'.repeat(64*1024+1))).toThrow('64 KiB');
});

test('durable journal and snapshot are private, gap-free, and retain correlated results',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'conversation-harness-'));try{
  const harness=new ConversationHarness({runId:'durable',directory,driver:{async send(_agent,text,emit){if(text.includes('ASSIGNMENT_JSON'))return {text:'READY'};const value=frame('durable','persisted','echo',{value:'saved'});emit({type:'replace',text:value});return {text:value};}}});
  await harness.turn('parent','persist');await harness.waitForIdle(1000);
  const log=join(directory,'durable.events.jsonl'),state=join(directory,'durable.snapshot.json'),events=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse),saved=JSON.parse(readFileSync(state,'utf8'));
  expect(events.map(event=>event.seq)).toEqual(events.map((_event,index)=>index+1));expect(events.find(event=>event.type==='tool.call')).toMatchObject({callId:'persisted',source:'stream'});expect(events.find(event=>event.type==='tool.result')).toMatchObject({callId:'persisted',ok:true});
  expect(saved.calls[0]).toMatchObject({status:'complete',result:{value:'saved'}});expect(saved.calls[0].signature).toMatch(/^[a-f0-9]{64}$/);expect(statSync(directory).mode&0o777).toBe(0o700);expect(statSync(log).mode&0o777).toBe(0o600);expect(statSync(state).mode&0o777).toBe(0o600);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('protocol-channel drivers never execute display text or raw final text',async()=>{
 const display=frame('protocol-only','display-call','echo',{value:'must not run'}),trusted=frame('protocol-only','trusted-call','echo',{value:'trusted'});
 const events:HarnessEvent[]=[];let n=0;
 const driver:any={protocolChannel:true,async send(_agent:HarnessAgent,text:string,emit:(event:any)=>void){if(text.includes('ASSIGNMENT_JSON'))return {text:'READY',protocolText:''};n++;emit({type:'text',text:display});if(n===1){emit({type:'protocol.replace',text:trusted});return {text:display,protocolText:trusted};}return {text:display};}};
 const harness=new ConversationHarness({runId:'protocol-only',driver,onEvent:event=>events.push(event)});
 await harness.turn('parent','trusted channel');await harness.turn('parent','display only');await harness.waitForIdle(1000);
 expect(events.filter(event=>event.type==='tool.call').map(event=>event.callId)).toEqual(['trusted-call']);
 expect(events.find(event=>event.callId==='trusted-call')).toMatchObject({source:'stream'});
 expect(events.some(event=>event.callId==='display-call')).toBe(false);
 expect(events.filter(event=>event.type==='turn.event'&&event.event?.type==='text')).toHaveLength(2);
});

test('semantic replacement errors are transient but the final call ledger is strict',async()=>{
 const good=frame('semantic-ledger','stable','echo',{value:1}),transient=good.replace('</tool_call>','</tool_\n'),events:HarnessEvent[]=[];
 let mode:'recover'|'omit'|'revise'|'malformed'='recover';
 const harness=new ConversationHarness({runId:'semantic-ledger',onEvent:event=>events.push(event),driver:{protocolChannel:true,async send(_agent,text,emit){
  if(text.includes('ASSIGNMENT_JSON'))return {text:'READY',protocolText:''};
  if(mode==='recover'){emit({type:'protocol.replace',text:transient});emit({type:'protocol.replace',text:good});return {text:'',protocolText:good};}
  if(mode==='omit'){emit({type:'protocol.replace',text:good});return {text:'',protocolText:''};}
  if(mode==='revise'){emit({type:'protocol.replace',text:good});emit({type:'protocol.replace',text:frame('semantic-ledger','stable','echo',{value:2})});return {text:'',protocolText:good};}
  return {text:'',protocolText:transient};
 }}});
 await harness.turn('parent','recover transient renderer text');await harness.waitForIdle(1000);
 expect(events.filter(event=>event.type==='tool.call'&&event.callId==='stable')).toHaveLength(1);
 expect(events.filter(event=>event.type==='protocol.error')).toHaveLength(0);
 mode='omit';await expect(harness.turn('parent','omit final call')).rejects.toMatchObject({code:'TOOL_PROTOCOL_ERROR',causeCode:'FINAL_CALL_MISMATCH',callId:'stable'});
 mode='revise';await expect(harness.turn('parent','revise emitted call')).rejects.toMatchObject({code:'TOOL_PROTOCOL_ERROR',causeCode:'CALL_ID_CONFLICT',callId:'stable'});
 mode='malformed';await expect(harness.turn('parent','malformed final')).rejects.toMatchObject({code:'TOOL_PROTOCOL_ERROR',causeCode:'MALFORMED_FRAME'});
 await harness.waitForIdle(1000);
 const failed=events.filter(event=>event.type==='turn.failed');expect(failed).toHaveLength(3);
 expect(events.filter(event=>event.type==='turn.completed'&&event.kind==='turn')).toHaveLength(1);
 expect(events.filter(event=>event.type==='protocol.error').map(event=>event.error.code)).toEqual(['FINAL_CALL_MISMATCH','CALL_ID_CONFLICT','MALFORMED_FRAME']);
 expect(events.filter(event=>event.type==='tool.call'&&event.callId==='stable')).toHaveLength(1);
 expect(harness.drain('parent').filter(event=>event.type==='protocol.error')).toHaveLength(0);
});
