import {expect,test} from 'bun:test';
import {WebsiteVoice} from '../src/chatgpt/voice.ts';

test('voice start foregrounds the dedicated tab and verifies website session controls',async()=>{
 const calls:any[]=[];let clicked=false;
 const browser={call:async(op:string,args:any)=>{calls.push({op,args});if(op==='action')clicked=true;return {};}} as any;
 const actions={
  find:async()=>({s:{epoch:'fresh'},c:{ref:7,name:'Start Voice'}}),
  snapshot:async()=>({url:'https://chatgpt.com/',epoch:'after',controls:clicked?[{name:'Turn off microphone',context:''},{name:'End Voice',context:''}]:[{name:'Start Voice',context:''}],media:[]}),
 } as any;
 const result=await new WebsiteVoice(browser,actions).start('voice');
 expect(calls.map(call=>call.op)).toEqual(['surface.activate','permission','action']);
 expect(calls[0].args).toEqual({surface:'main'});
 expect(result.verification).toBe('website session controls observed');
});
