import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebsiteHarnessDriver} from '../src/chatgpt/harness-web.ts';

// Measured from fire17's own receipts: every API request opened a NEW tab and cold-booted the whole ChatGPT
// app, and a chain of such requests eventually landed on a page that never rendered (controlCount 2 against a
// loaded page's 61). Recycling keeps the warm tab and resets only the conversation, so the next request starts
// clean without paying for another cold boot. These tests pin that behavior, including what it must refuse.

const account={id:'recycle-fixture',label:'Fixture',userId:'user-fixture',baseURL:'https://chatgpt.com',cdpURL:'http://127.0.0.1:9222',transportMode:'attached' as const,created:''};

function fixture(options:{unknown?:boolean;hold?:Promise<void>}={}){
 const directory=mkdtempSync(join(tmpdir(),'harness-recycle-'));
 const calls:any[]=[];let conversation=0,epoch=0;
 const worker={
  async start(){},
  async close(){calls.push(['close',{}]);},
  async call(op:string,args:any={}){
   calls.push([op,args]);
   if(op==='session')return {authenticated:true,user:{id:'user-fixture'}};
   if(op==='surface.open')return {surface:args.surface,url:args.url,rendering:{enabled:true,visibilityState:'visible',hidden:false}};
   if(op==='surface.close')return {closed:true};
   return {};
  },
 };
 const snapshot=()=>({epoch:'epoch-'+(++epoch),url:'https://chatgpt.com/c/chat-'+conversation,title:'ChatGPT',text:'',controls:[{id:'prompt-textarea',role:'textbox',name:'Chat with ChatGPT',disabled:false},{role:'radio',name:'Chat',disabled:false}],messages:[],harnessDOM:{visibilityState:'visible',hidden:false}});
 const dependencies={
  worker:()=>worker,
  actions:()=>({
   idle:async()=>snapshot(),
   snapshot:async()=>snapshot(),
   async mode(value:string){return {verified:true,selected:value};},
   async choose(kind:string,value:string){return {verified:true,selected:value};},
   async composer(){return {written:true};},
   async submit(){
    conversation++;
    if(options.hold)await options.hold;
    if(options.unknown)throw Object.assign(new Error('submit outcome unknown'),{code:'OUTCOME_UNKNOWN'});
    return {submitted:true,url:'https://chatgpt.com/c/chat-'+conversation};
   },
   async waitReply(){return {text:'ok',displayText:'ok',url:'https://chatgpt.com/c/chat-'+conversation,conversation:'chat-'+conversation,messages:[]};},
   async stop(){return {stopped:true};},
  }),
 } as any;
 return {directory,calls,dependencies,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}

const opened=(calls:any[])=>calls.filter(([op])=>op==='surface.open').map(([,args])=>args.surface);

test('recycle reuses the same tab and clears the conversation, so no cold boot and no context bleed',async()=>{
 const f=fixture();
 const events:any[]=[];
 const driver=new WebsiteHarnessDriver(account,{directory:f.directory,emit:(e:any)=>events.push(e)},f.dependencies);
 try{
  const first=await driver.send({id:'agent',name:'Agent'},'First request').catch((e:any)=>e);
  const surfacesAfterFirst=opened(f.calls);
  expect(surfacesAfterFirst.length).toBe(1);

  const recycled=await driver.recycle({id:'agent',name:'Agent'});
  expect(recycled.reusedTab).toBe(true);
  expect(recycled.surface).toBe(surfacesAfterFirst[0]);
  expect(events.some(e=>e.type==='harness.recycled')).toBe(true);
  // Recycling must not close the tab: closing it is what forces the next cold boot.
  expect(f.calls.some(([op])=>op==='surface.close')).toBe(false);

  await driver.send({id:'agent',name:'Agent'},'Second request').catch(()=>{});
  const surfaces=opened(f.calls);
  // Two preparations, ONE tab: the second surface.open names the same surface, which the worker reuses.
  expect(surfaces.length).toBe(2);
  expect(new Set(surfaces).size).toBe(1);
  // A recycled agent starts at the site root, never inside the previous conversation.
  const urls=f.calls.filter(([op])=>op==='surface.open').map(([,args])=>args.url);
  expect(urls[1]).toBe('https://chatgpt.com/');
  expect(first).toBeDefined();
 }finally{await driver.close().catch(()=>{});f.cleanup();}
});

test('recycle refuses while a turn is active',async()=>{
 let release!:()=>void;
 const f=fixture({hold:new Promise<void>(resolve=>{release=resolve;})});
 const driver=new WebsiteHarnessDriver(account,{directory:f.directory},f.dependencies);
 try{
  const inFlight=driver.send({id:'agent',name:'Agent'},'First').catch(()=>{});
  await Bun.sleep(20);
  await expect(driver.recycle({id:'agent',name:'Agent'})).rejects.toMatchObject({code:'AGENT_BUSY'});
  release();
  await inFlight;
 }finally{await driver.close().catch(()=>{});f.cleanup();}
});

test('an uncertain submission is quarantined, never recycled away',async()=>{
 const f=fixture({unknown:true});
 const driver=new WebsiteHarnessDriver(account,{directory:f.directory},f.dependencies);
 try{
  await driver.send({id:'agent',name:'Agent'},'First').catch(()=>{});
  // load() blocks replay after an unknown outcome; recycle must inherit that block rather than clearing it.
  await expect(driver.recycle({id:'agent',name:'Agent'})).rejects.toMatchObject({code:'NEEDS_RECONCILIATION'});
 }finally{await driver.close().catch(()=>{});f.cleanup();}
});

test('closing the driver releases the tab name so a later driver opens a fresh tab',async()=>{
 const f=fixture();
 const first=new WebsiteHarnessDriver(account,{directory:f.directory},f.dependencies);
 await first.send({id:'agent',name:'Agent'},'First').catch(()=>{});
 await first.close().catch(()=>{});
 expect(f.calls.some(([op])=>op==='surface.close')).toBe(true);
 const second=new WebsiteHarnessDriver(account,{directory:f.directory},f.dependencies);
 try{
  await second.send({id:'agent',name:'Agent'},'Second').catch(()=>{});
  const surfaces=opened(f.calls);
  expect(new Set(surfaces).size).toBe(2);// a new driver never adopts a closed driver's tab
 }finally{await second.close().catch(()=>{});f.cleanup();}
});
