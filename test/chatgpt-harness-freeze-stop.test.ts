import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebsiteHarnessDriver} from '../src/chatgpt/harness-web.ts';
import {ALLOW_WHILE_FROZEN,allowedWhileFrozen,frozenError} from '../src/chatgpt/freeze.ts';

// A freeze must be able to halt a generation that is ALREADY streaming (the
// 2026-09-15 19:51 "STOP EVERYTHING IMMEDIATELY" incident). The harness cancel path
// clicks the website's own Stop control, which is an `action` — not in
// FROZEN_ALLOWED_OPS — so it needs the in-process capability, exactly as
// Actions.stop() does. Everything else the harness does stays refused while frozen.

const account={id:'fixture',label:'Fixture',userId:'user-fixture',baseURL:'https://chatgpt.com',cdpURL:'http://127.0.0.1:9222',transportMode:'attached' as const,created:''};

// Mirrors the real gate (transport.ts: `isFrozen(account) && !allowedWhileFrozen(op,args)`).
function frozenWorker(calls:any[]){
 let stopped=false;
 return {
  async start(){throw frozenError(account as any,'browser.start');},
  async close(){calls.push(['close']);},
  async call(op:string,args:any={}){
   if(!allowedWhileFrozen(op,args))throw frozenError(account as any,op);
   calls.push([op,args]);
   if(op==='snapshot')return {epoch:'frozen-epoch',url:'https://chatgpt.com/c/live',controls:stopped?[]:[{testId:'stop-button',ref:3,name:'Stop answering'}],messages:[]};
   if(op==='action'){stopped=true;return {clicked:true};}
   if(op==='surface.close')return {closed:true};
   throw new Error('Unexpected '+op);
  },
 };
}

test('a frozen account can still click the website Stop control on a streaming harness surface',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'harness-freeze-')),calls:any[]=[];
 const driver=new WebsiteHarnessDriver(account,{directory},{worker:()=>frozenWorker(calls)});
 (driver as any).surfaces.set('one',{surface:'harness-owned',state:{phase:'submitted'}});
 (driver as any).active.add('one');
 try{
  const result=await driver.cancel();
  expect(result.results[0]).toMatchObject({agentId:'one',requested:true,confirmed:true,source:'owned website stop control'});
  const click=calls.find(call=>call[0]==='action');
  expect(click).toBeDefined();
  expect(click[1]).toMatchObject({surface:'harness-owned',epoch:'frozen-epoch',ref:3,kind:'click'});
  expect(click[1][ALLOW_WHILE_FROZEN]).toBe(true);
 }finally{await driver.close();rmSync(directory,{recursive:true,force:true});}
});

test('a frozen account still refuses an ordinary harness turn, and the capability cannot be forged from JSON',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'harness-freeze-')),calls:any[]=[];
 const driver=new WebsiteHarnessDriver(account,{directory},{worker:()=>frozenWorker(calls)});
 try{
  await expect(driver.send({id:'one',name:'One'},'This must never reach the website')).rejects.toMatchObject({code:'NOT_SUBMITTED',causeCode:'FROZEN',submissionState:'not-submitted'});
  expect(calls.some(call=>['composer','submit','surface.open','snapshot.evaluate'].includes(call[0]))).toBe(false);
 }finally{await driver.close();rmSync(directory,{recursive:true,force:true});}

 // The gate itself: only the Stop click carries the capability.
 expect(allowedWhileFrozen('action',{kind:'click',[ALLOW_WHILE_FROZEN]:true})).toBe(true);
 expect(allowedWhileFrozen('action',{kind:'click'})).toBe(false);
 for(const op of ['surface.open','submit','key','type','mouse.click','snapshot.evaluate','evaluate','request'])
  expect(allowedWhileFrozen(op,{})).toBe(false);
 // A Symbol cannot cross JSON, a daemon RPC payload or a slash command.
 expect(allowedWhileFrozen('action',JSON.parse('{"chatgpt.allowWhileFrozen":true,"Symbol(chatgpt.allowWhileFrozen)":true}'))).toBe(false);
 expect(allowedWhileFrozen('action',JSON.parse(JSON.stringify({kind:'click',[ALLOW_WHILE_FROZEN]:true})))).toBe(false);
});
