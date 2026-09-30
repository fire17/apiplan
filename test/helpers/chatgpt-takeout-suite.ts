import {afterAll,expect,test} from 'bun:test';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const TEST_HOME=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-takeout-home-'));
process.env.CHATGPT_HOME=TEST_HOME;
afterAll(()=>rmSync(TEST_HOME,{recursive:true,force:true}));

const {runTakeout,DEFAULT_CONVERSATION_READS}=await import('../../src/chatgpt/takeout.ts');
const {setFreeze,readFreeze}=await import('../../src/chatgpt/freeze.ts');
const account={id:'takeout-test',label:'Takeout test',baseURL:'https://chatgpt.com',created:'2026-09-15T00:00:00.000Z',source:{provider:'managed' as const}};

function tree(id:string,update_time:number,text:string){return {id,update_time,current_node:'message',mapping:{message:{parent:null,children:[],message:{id:'message',author:{role:'assistant'},status:'finished_successfully',content:{parts:[text]}}}}};}
function fixture(list:()=>any[],conversation:(id:string)=>Promise<any>){return {
 account,
 conversations:async()=>({items:list(),complete:true}),
 conversation,
 request:async()=>({}),
 dispatch:async(op:string)=>{
  if(op==='projects.list'||op==='gpts.list'||op==='media.list')return {items:[],complete:true};
  return {};
 },
};}
function archived(root:string,id:string){const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));return JSON.parse(readFileSync(join(root,manifest.files['conversation:'+id].path),'utf8'));}

test('resume refreshes the catalog and captures a conversation created after a complete run',async()=>{
 const root=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-takeout-new-'));let rows=[{id:'a',update_time:1}];const calls:string[]=[];
 const service=fixture(()=>rows,async id=>{calls.push(id);return tree(id,1,id+' body');});
 try{
  await runTakeout(service,{output:root,maxRetries:0});
  rows=[{id:'a',update_time:1},{id:'b',update_time:1}];
  await runTakeout(service,{output:root,maxRetries:0});
  expect(calls).toEqual(['a','b']);
  expect(archived(root,'a').mapping.message.message.content.parts).toEqual(['a body']);
  expect(archived(root,'b').mapping.message.message.content.parts).toEqual(['b body']);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('resume refreshes a conversation tree only when catalog update time changes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-takeout-edited-'));let updated=1,calls=0;
 const service=fixture(()=>[{id:'edited',update_time:updated}],async()=>{calls++;return tree('edited',updated,updated===1?'before edit':'after edit');});
 try{
  await runTakeout(service,{output:root,maxRetries:0});
  await runTakeout(service,{output:root,maxRetries:0});
  expect(calls).toBe(1);
  updated=2;
  await runTakeout(service,{output:root,maxRetries:0});
  expect(calls).toBe(2);
  expect(archived(root,'edited').mapping.message.message.content.parts).toEqual(['after edit']);
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('early rate limit still checkpoints every catalog target and distinguishes unattempted reads',async()=>{
 const root=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-takeout-targets-'));let rows=[{id:'b'},{id:'a'},{id:'c'}];const calls:string[]=[];
 const service=fixture(()=>rows,async id=>{calls.push(id);throw Object.assign(new Error('429'),{status:429});});
 try{
  await runTakeout(service,{output:root,maxRetries:0});
  const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')),targets=JSON.parse(readFileSync(join(root,'conversations/targets.json'),'utf8'));
  expect(calls).toEqual(['b']);expect(targets.ids).toEqual(['a','b','c']);expect(targets.count).toBe(3);expect(targets.sourceCatalogsComplete).toBe(true);
  expect(manifest.coverage['conversation:a']).toMatchObject({required:true,status:'partial',reason:'Pending conversation detail read; no attempt recorded yet.'});
  expect(manifest.coverage['conversation:b'].reason).toBe('Read failed; resume to retry.');
  expect(manifest.coverage['conversations:targets']).toMatchObject({status:'complete',count:3});
  rows=[{id:'b'},{id:'a'},{id:'c'},{id:'new'}];await runTakeout(service,{output:root,maxRetries:0});
  const next=JSON.parse(readFileSync(join(root,'conversations/targets.json'),'utf8'));
  expect(next.count).toBe(4);expect(next.sha256).not.toBe(targets.sha256);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('incomplete catalog target set never certifies closure or discards historical trees',async()=>{
 const root=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-takeout-targets-partial-'));let rows=[{id:'old'}];
 const service=fixture(()=>rows,async id=>tree(id,1,id));
 try{
  await runTakeout(service,{output:root,maxRetries:0});rows=[{id:'new'}];service.conversations=async()=>({items:rows,complete:false});
  await runTakeout(service,{output:root,maxRetries:0});
  const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')),targets=JSON.parse(readFileSync(join(root,'conversations/targets.json'),'utf8'));
  expect(targets.sourceCatalogsComplete).toBe(false);expect(targets.historicalIds).toEqual(['old']);
  expect(manifest.coverage['conversations:targets'].status).toBe('partial');expect(archived(root,'old').id).toBe('old');
 }finally{rmSync(root,{recursive:true,force:true});}
});

const PENDING='Pending conversation detail read; no attempt recorded yet.';
const rowsFor=(count:number)=>Array.from({length:count},(_,index)=>({id:'c'+String(index).padStart(3,'0'),update_time:1}));
const conversationCoverage=(root:string)=>{const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));return Object.entries(manifest.coverage as Record<string,any>).filter(([name])=>name.startsWith('conversation:')).map(([name,value])=>({name,...value}));};

test('a bounded run stops exactly at its limit, reports what remains, and the next slice resumes without refetching',async()=>{
 const root=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-takeout-bounded-'));const rows=rowsFor(5),calls:string[]=[];
 const service=fixture(()=>rows,async id=>{calls.push(id);return tree(id,1,id+' body');});
 try{
  const first:any=await runTakeout(service,{output:root,maxRetries:0,maxConversations:2});
  expect(first).toMatchObject({stopped:true,deferred:false,reason:'read-limit',reads:2,limit:2,attempted:2,remaining:3,targets:5,complete:false});
  expect(calls).toEqual(['c000','c001']);
  const targets=JSON.parse(readFileSync(join(root,'conversations/targets.json'),'utf8'));
  expect(targets.count).toBe(5);expect(targets.sourceCatalogsComplete).toBe(true);
  const after=conversationCoverage(root);
  expect(after.filter(scope=>scope.status==='complete').length).toBe(2);
  expect(after.filter(scope=>scope.reason===PENDING).length).toBe(3);
  expect(after.some(scope=>scope.reason==='Read failed; resume to retry.')).toBe(false);
  const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
  expect(manifest.complete).toBe(false);
  expect(manifest.coverage['conversations:details']).toMatchObject({required:true,status:'partial',count:2});
  // The next slice continues where the first stopped: intact trees are never refetched.
  const second:any=await runTakeout(service,{output:root,maxRetries:0,maxConversations:2});
  expect(calls).toEqual(['c000','c001','c002','c003']);
  expect(second).toMatchObject({stopped:true,reads:2,attempted:4,remaining:1});
  const third:any=await runTakeout(service,{output:root,maxRetries:0,maxConversations:'all'});
  expect(calls).toEqual(['c000','c001','c002','c003','c004']);
  expect(third.stopped).toBeUndefined();
  expect(conversationCoverage(root).every(scope=>scope.status==='complete')).toBe(true);
  expect(JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')).coverage['conversations:details']).toBeUndefined();
 }finally{rmSync(root,{recursive:true,force:true});}
},20000);

test('the default run is a bounded slice and a short slice never hides an unattempted target',async()=>{
 const root=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-takeout-default-bound-'));const rows=rowsFor(DEFAULT_CONVERSATION_READS+3),calls:string[]=[];
 const service=fixture(()=>rows,async id=>{calls.push(id);return tree(id,1,id+' body');});
 try{
  const result:any=await runTakeout(service,{output:root,maxRetries:0});
  expect(DEFAULT_CONVERSATION_READS).toBe(25);
  expect(calls.length).toBe(DEFAULT_CONVERSATION_READS);
  expect(result).toMatchObject({stopped:true,reason:'read-limit',reads:DEFAULT_CONVERSATION_READS,limit:DEFAULT_CONVERSATION_READS,remaining:3,targets:rows.length});
  expect(JSON.parse(readFileSync(join(root,'conversations/targets.json'),'utf8')).count).toBe(rows.length);
  const coverage=conversationCoverage(root);
  expect(coverage.length).toBe(rows.length);
  expect(coverage.filter(scope=>scope.reason===PENDING).map(scope=>scope.name)).toEqual(['conversation:c025','conversation:c026','conversation:c027']);
  expect(coverage.some(scope=>scope.reason==='Read failed; resume to retry.')).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
},20000);

test('a frozen account defers the whole run: no site read, no writer lock, no failure, checkpoint untouched',async()=>{
 const root=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-takeout-frozen-'));const rows=rowsFor(5);let lists=0;const calls:string[]=[];
 const service=fixture(()=>{lists++;return rows;},async id=>{calls.push(id);return tree(id,1,id+' body');});
 try{
  await runTakeout(service,{output:root,maxRetries:0,maxConversations:2});
  const before=readFileSync(join(root,'manifest.json'),'utf8'),listsBefore=lists,callsBefore=calls.length;
  setFreeze(account,true,{by:'test',reason:'his STOP'});
  expect(readFreeze(account).frozen).toBe(true);
  const deferred:any=await runTakeout(service,{output:root,maxRetries:0,maxConversations:2});
  expect(deferred).toMatchObject({deferred:true,paused:true,reason:'frozen',freezeReason:'his STOP',reads:0,attempted:0,complete:false});
  expect(deferred.integrity).toBe(true);
  expect(lists).toBe(listsBefore);expect(calls.length).toBe(callsBefore);
  expect(readFileSync(join(root,'manifest.json'),'utf8')).toBe(before);
  expect(existsSync(join(root,'.writer.lock'))).toBe(false);
  setFreeze(account,false,{by:'test'});
  const resumed:any=await runTakeout(service,{output:root,maxRetries:0,maxConversations:2});
  expect(resumed.reads).toBe(2);expect(calls.length).toBe(callsBefore+2);
 }finally{setFreeze(account,false,{by:'test'});rmSync(root,{recursive:true,force:true});}
},20000);

test('a freeze that lands mid-run defers the rest and counts nothing as a failure',async()=>{
 const root=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-takeout-frozen-midrun-'));const rows=rowsFor(5),calls:string[]=[],events:any[]=[];
 const service=fixture(()=>rows,async id=>{calls.push(id);if(calls.length===2)setFreeze(account,true,{by:'test',reason:'mid-run STOP'});return tree(id,1,id+' body');});
 try{
  const result:any=await runTakeout(service,{output:root,maxRetries:0,maxConversations:'all'},event=>events.push(event));
  expect(calls.length).toBe(2);
  expect(result).toMatchObject({deferred:true,stopped:false,reason:'frozen',reads:2,attempted:2,remaining:3,targets:5,complete:false});
  expect(events.some(event=>event.type==='takeout.deferred'&&event.reason==='frozen')).toBe(true);
  const coverage=conversationCoverage(root);
  expect(coverage.filter(scope=>scope.status==='complete').length).toBe(2);
  expect(coverage.filter(scope=>scope.reason===PENDING).length).toBe(3);
  expect(coverage.some(scope=>scope.reason==='Read failed; resume to retry.')).toBe(false);
  expect(JSON.parse(readFileSync(join(root,'coverage.json'),'utf8'))).toMatchObject({reason:'frozen',remaining:3});
 }finally{setFreeze(account,false,{by:'test'});rmSync(root,{recursive:true,force:true});}
},20000);

test('a 429 checkpoints and stops with resumable progress instead of crawling on',async()=>{
 const root=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-takeout-429-'));const rows=rowsFor(5),calls:string[]=[];let limited=true;
 const service=fixture(()=>rows,async id=>{calls.push(id);if(limited&&calls.length===2)throw Object.assign(new Error('429 Too Many Requests'),{status:429});return tree(id,1,id+' body');});
 try{
  const stopped:any=await runTakeout(service,{output:root,maxRetries:0,maxConversations:'all'});
  expect(calls).toEqual(['c000','c001']);
  expect(stopped).toMatchObject({paused:true,deferred:false,stopped:false,reason:'rate-limit',reads:2,attempted:1,remaining:4,targets:5,complete:false});
  const coverage=conversationCoverage(root);
  expect(coverage.filter(scope=>scope.status==='complete').length).toBe(1);
  expect(coverage.filter(scope=>scope.reason==='Read failed; resume to retry.').length).toBe(1);
  expect(coverage.filter(scope=>scope.reason===PENDING).length).toBe(3);
  expect(JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')).coverage['conversations:details'].reason).toContain('Rate limit');
  limited=false;
  const resumed:any=await runTakeout(service,{output:root,maxRetries:0,maxConversations:'all'});
  expect(calls).toEqual(['c000','c001','c001','c002','c003','c004']);
  expect(resumed.paused).toBeUndefined();
  expect(conversationCoverage(root).every(scope=>scope.status==='complete')).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
},20000);
