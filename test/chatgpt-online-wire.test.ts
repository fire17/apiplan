import {expect,test} from 'bun:test';
import type {CallOpts,Delta,Turn} from '/Users/magic/Creations/APIPlan/src/providers.ts';
import {ONLINE_DISPLAY_TAIL_CODEPOINTS,OnlineReplyDecoder,onlinePrompt,onlineVisibleText} from '/Users/magic/Creations/APIPlan/src/chatgpt/online-wire.ts';

const tool={name:'lookup',description:'Look up a value',parameters:{type:'object',properties:{key:{type:'string'}},required:['key']}};
const frame=(run:string,id='call-1',name='lookup',args:Record<string,unknown>={key:'alpha'})=>`<tool_call run="${run}">\n${JSON.stringify({id,tool:name,args})}\n</tool_call>`;
const fault=(fn:()=>unknown,code:string)=>{try{fn();throw new Error('expected failure');}catch(error:any){expect(error.code).toBe(code);}};

test('prompt preserves ordered roles, tool calls, results, system data, and literal Unicode',()=>{
 const turns:Turn[]=[
  {role:'user',text:'first שלום'},
  {role:'assistant',text:'calling',toolUses:[{id:'old-call',name:'lookup',input:{key:'α'}}]},
  {role:'user',text:'result',toolResults:[{toolUseId:'old-call',content:'β'}]},
  {role:'assistant',text:'developer policy',isSystem:true},
 ];
 const prompt=onlinePrompt('run-history',turns,{system:'top system',systemBlocks:[{type:'text',text:'block'}],tools:[tool],toolChoice:{name:'lookup'}});
 const history=JSON.parse(prompt.slice(prompt.lastIndexOf('HISTORY_JSON ')+13).split('\n\nContinue')[0]!);
 expect(history).toEqual([
  {role:'user',text:'first שלום'},
  {role:'assistant',text:'calling',tool_calls:[{id:'old-call',name:'lookup',input:{key:'α'}}]},
  {role:'user',text:'result',tool_results:[{toolUseId:'old-call',content:'β'}]},
  {role:'system',text:'developer policy'},
 ]);
 expect(prompt).toContain('SYSTEM_JSON {"text":"top system","blocks":[{"type":"text","text":"block"}]}');
 expect(prompt).toContain('TOOL_CHOICE_JSON {"name":"lookup"}');
});

test('prompt rejects invalid media, tool definitions, choices, history, and configured size before submission',()=>{
 const base:Turn[]=[{role:'user',text:'go'}];
 fault(()=>onlinePrompt('run',[],{}),'INVALID_REQUEST');
 fault(()=>onlinePrompt('run',[{role:'user',text:'go',images:[{url:'file:///tmp/x'}]}],{}),'UNSUPPORTED_MEDIA');
 fault(()=>onlinePrompt('run',base,{genImage:true}),'UNSUPPORTED_MEDIA');
 fault(()=>onlinePrompt('run',base,{tools:[tool,tool]}),'INVALID_TOOLS');
 fault(()=>onlinePrompt('run',base,{tools:[],toolChoice:'required'}),'INVALID_TOOL_CHOICE');
 fault(()=>onlinePrompt('run',base,{tools:[tool],toolChoice:{name:'missing'}}),'INVALID_TOOL_CHOICE');
 fault(()=>onlinePrompt('run',[{role:'assistant',text:'',toolUses:[{id:'same',name:'lookup',input:{}},{id:'same',name:'lookup',input:{}}]}],{}),'INVALID_HISTORY');
 fault(()=>onlinePrompt('run',[{role:'user',text:'',toolResults:[{toolUseId:'missing',content:'x'}]}],{}),'INVALID_HISTORY');
 const old=process.env.APIPLAN_ONLINE_MAX_PROMPT_BYTES;
 try{process.env.APIPLAN_ONLINE_MAX_PROMPT_BYTES='1024';fault(()=>onlinePrompt('run',[{role:'user',text:'x'.repeat(2000)}],{}),'CONTEXT_LIMIT');}
 finally{if(old===undefined)delete process.env.APIPLAN_ONLINE_MAX_PROMPT_BYTES;else process.env.APIPLAN_ONLINE_MAX_PROMPT_BYTES=old;}
});

test('decoder recognizes a semantic tool frame at every byte boundary and emits one correlated call',()=>{
 const value=frame('run-split','split-id','lookup',{key:'שלום 🌍'});
 for(let split=1;split<value.length;split++){
  const deltas:Delta[]=[];const decoder=new OnlineReplyDecoder('run-split',{tools:[tool]},delta=>deltas.push(delta));
  decoder.event({type:'protocol.text',text:value.slice(0,split)});
  expect(deltas).toHaveLength(0);
  decoder.event({type:'protocol.text',text:value.slice(split)});
  decoder.finish({text:'',protocolText:value});
  expect(deltas).toEqual([
   {toolStart:{ref:'split-id',id:'split-id',name:'lookup'}},
   {toolArgs:{ref:'split-id',json:JSON.stringify({key:'שלום 🌍'})}},
   {toolStop:{ref:'split-id'}},
   {stopReason:'tool_use'},
  ]);
 }
});

test('fenced examples stay visible and inert while closing tags inside JSON strings parse safely',()=>{
 const deltas:Delta[]=[];const decoder=new OnlineReplyDecoder('run-fence',{tools:[tool]},delta=>deltas.push(delta));
 const example='```xml\n'+frame('run-fence','example')+'\n```';
 const actual=frame('run-fence','real','lookup',{key:'literal </tool_call> value'});
 decoder.event({type:'replace',text:example+'\nvisible answer\n'+actual});
 decoder.event({type:'protocol.replace',text:example+'\n'+actual});
 decoder.finish({text:example+'\nvisible answer\n'+actual,protocolText:example+'\n'+actual});
 expect(deltas.filter(delta=>delta.toolStart).map(delta=>delta.toolStart?.id)).toEqual(['real']);
 expect(deltas.filter(delta=>delta.text).map(delta=>delta.text).join('')).toBe(example+'\nvisible answer\n');
 expect(deltas.at(-1)).toEqual({stopReason:'tool_use'});
 expect(onlineVisibleText('prefix\n<tool_',false)).toBe('prefix\n');
});

test('decoder fails closed for unobserved protocol, forbidden names and ids, missing required calls, and streamed revisions',()=>{
 fault(()=>new OnlineReplyDecoder('run',{},()=>{}).finish({text:'answer'}),'PROTOCOL_UNOBSERVED');
 const unknown=new OnlineReplyDecoder('run',{tools:[tool]},()=>{});fault(()=>unknown.event({type:'protocol.replace',text:frame('run','x','other')}),'TOOL_PROTOCOL_ERROR');
 const reused=new OnlineReplyDecoder('run',{tools:[tool]},()=>{},new Set(['old']));fault(()=>reused.event({type:'protocol.replace',text:frame('run','old')}),'TOOL_PROTOCOL_ERROR');
 const named=new OnlineReplyDecoder('run',{tools:[tool],toolChoice:{name:'lookup'}},()=>{});fault(()=>named.finish({text:'plain',protocolText:'plain'}),'TOOL_CHOICE_UNSATISFIED');
 const revised=new OnlineReplyDecoder('run',{},()=>{});revised.event({type:'text',text:'a'.repeat(ONLINE_DISPLAY_TAIL_CODEPOINTS+8)});fault(()=>revised.event({type:'replace',text:'b'+'a'.repeat(ONLINE_DISPLAY_TAIL_CODEPOINTS+7)}),'STREAM_REVISED');
});

test('decoder withholds a bounded Unicode tail and tolerates only revisions inside it',()=>{
 const deltas:Delta[]=[];const decoder=new OnlineReplyDecoder('run',{},delta=>deltas.push(delta));
 const stable='a'.repeat(140),provisional=stable.slice(0,90)+'_';
 decoder.event({type:'text',text:provisional});
 expect(deltas.map(delta=>delta.text).filter(Boolean).join('')).toBe(stable.slice(0,27));
 decoder.event({type:'replace',text:stable.slice(0,90)+'7'});
 decoder.event({type:'replace',text:stable.slice(0,82)});
 expect(deltas.map(delta=>delta.text).filter(Boolean).join('')).toBe(stable.slice(0,27));
 decoder.event({type:'replace',text:stable});
 expect(deltas.map(delta=>delta.text).filter(Boolean).join('')).toBe(stable.slice(0,76));
 decoder.finish({text:stable,displayText:stable,protocolText:''});
 expect(deltas.map(delta=>delta.text).filter(Boolean).join('')).toBe(stable);
 expect(deltas.at(-1)).toEqual({stopReason:'end_turn'});
});

test('short provisional caret is withheld until the verified final display',()=>{
 const deltas:Delta[]=[];const decoder=new OnlineReplyDecoder('run',{},delta=>deltas.push(delta));
 decoder.event({type:'text',text:'ROUND_1:abc_'});expect(deltas).toHaveLength(0);
 decoder.finish({text:'ROUND_1:abc7def012345678',displayText:'ROUND_1:abc7def012345678',protocolText:''});
 expect(deltas).toEqual([{text:'ROUND_1:abc7def012345678'},{stopReason:'end_turn'}]);
});

test('decoder uses the explicit DOM display channel and never rewrites emitted text from authoritative Markdown',()=>{
 const deltas:Delta[]=[];const decoder=new OnlineReplyDecoder('run',{},delta=>deltas.push(delta));decoder.event({type:'text',text:'Hello world'});
 decoder.finish({text:'Hello world',displayText:'Hello world',authoritativeText:'**Hello** world',protocolText:''});
 expect(deltas).toEqual([{text:'Hello world'},{stopReason:'end_turn'}]);
 const committed='Hello world '.repeat(8),missing=new OnlineReplyDecoder('run',{},()=>{});missing.event({type:'text',text:committed});fault(()=>missing.finish({text:'**Hello** world '+committed,protocolText:''}),'STREAM_REVISED');
});

test('transient malformed replacement is deferred, then a complete final semantic frame emits once',()=>{
 const deltas:Delta[]=[];const decoder=new OnlineReplyDecoder('run-transient',{tools:[tool]},delta=>deltas.push(delta)),complete=frame('run-transient','stable');
 const transient=complete.replace('</tool_call>','</tool_\n');decoder.event({type:'protocol.replace',text:transient});expect(deltas).toHaveLength(0);
 decoder.event({type:'protocol.replace',text:complete});decoder.finish({text:complete,displayText:complete,protocolText:complete});
 expect(deltas.filter(delta=>delta.toolStart)).toEqual([{toolStart:{ref:'stable',id:'stable',name:'lookup'}}]);expect(deltas.at(-1)).toEqual({stopReason:'tool_use'});
});

test('final protocol is strict and cannot remove or revise a tool call already emitted',()=>{
 const emitted=new OnlineReplyDecoder('run',{tools:[tool]},()=>{});emitted.event({type:'protocol.replace',text:frame('run','stable')});fault(()=>emitted.finish({text:'',protocolText:''}),'TOOL_PROTOCOL_ERROR');
 const revised=new OnlineReplyDecoder('run',{tools:[tool]},()=>{});revised.event({type:'protocol.replace',text:frame('run','stable','lookup',{key:'one'})});fault(()=>revised.event({type:'protocol.replace',text:frame('run','stable','lookup',{key:'two'})}),'TOOL_PROTOCOL_ERROR');
 const malformed=new OnlineReplyDecoder('run',{tools:[tool]},()=>{});malformed.event({type:'protocol.replace',text:'<tool_call run="run">\n{"id":"x"'});fault(()=>malformed.finish({text:'broken',protocolText:'<tool_call run="run">\n{"id":"x"'}),'TOOL_PROTOCOL_ERROR');
});
