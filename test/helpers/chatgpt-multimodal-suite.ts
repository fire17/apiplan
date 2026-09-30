import {afterAll,expect,test} from 'bun:test';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rmSync} from 'node:fs';

const TEST_CHATGPT_HOME=join(tmpdir(),`apiplan-chatgpt-multimodal-${process.pid}`);
process.env.CHATGPT_HOME=TEST_CHATGPT_HOME;
afterAll(()=>rmSync(TEST_CHATGPT_HOME,{recursive:true,force:true}));

const snapshot=(media:any[]=[])=>({
 epoch:'snapshot',url:'https://chatgpt.com/c/multimodal-test',title:'CLI integration test',
 text:'',controls:[],messages:[],media,
});

test('media-only website replies complete without an assistant text node',async()=>{
 const {Actions}=await import('../../src/chatgpt/actions.ts');
 const before=snapshot(),image={tag:'img',src:'https://chatgpt.com/backend-api/estuary/content?id=file_test',alt:'Generated image: red circle'};
 const browser={account:{},call:async(op:string)=>{expect(op).toBe('snapshot');return snapshot([image]);}};
 const events:any[]=[];
 const result=await new Actions(browser as any).waitReply(before,event=>events.push(event),3500);
 expect(result.text).toBe('');
 expect(result.media).toEqual([image]);
 expect(events.some(event=>event.type==='media'&&event.items[0]===image)).toBe(true);
});

test('a failed file upload cannot fall through to composer submission',async()=>{
 const {ChatGPTService}=await import('../../src/chatgpt/service.ts');
 const service=Object.create(ChatGPTService.prototype) as InstanceType<typeof ChatGPTService>;
 service.busy=false;service.cancelled=false;
 service.identity=async()=>({authenticated:true}) as any;
 service.browser={call:async(op:string)=>{expect(op).toBe('upload');throw new Error('fixture file is missing');}} as any;
 let composed=false,submitted=false;
 service.actions={idle:async()=>snapshot(),composer:async()=>{composed=true;},snapshot:async()=>snapshot(),submit:async()=>{submitted=true;}} as any;
 await expect(service.send({text:'Read the fixture',files:['/tmp/missing-fixture.txt']},()=>{})).rejects.toThrow('fixture file is missing');
 expect({composed,submitted,busy:service.busy}).toEqual({composed:false,submitted:false,busy:false});
});

test('cancellation interrupts a stalled conversation receipt',async()=>{
 const {Actions}=await import('../../src/chatgpt/actions.ts');
 const placeholder={...snapshot(),messages:[{id:'assistant-placeholder',role:'assistant',text:''}]};
 const browser={account:{},call:async(op:string)=>{expect(op).toBe('snapshot');return placeholder;}};
 let reads=0,cancelled=false;
 const actions=new Actions(browser as any,async()=>{reads++;return new Promise(()=>{});});
 const timer=setTimeout(()=>{cancelled=true;},2700),started=performance.now();
 try{
  await expect(actions.waitReply(snapshot(),()=>{},8000,()=>cancelled)).rejects.toThrow('Generation cancelled');
  expect(reads).toBe(1);
  expect(performance.now()-started).toBeLessThan(4000);
 }finally{clearTimeout(timer);}
},5000);
