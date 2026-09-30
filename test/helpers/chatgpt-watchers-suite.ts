import {describe,expect,test} from 'bun:test';
import {mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const TEST_HOME=join(tmpdir(),`apiplan-chatgpt-tests-${process.pid}`);
mkdirSync(TEST_HOME,{recursive:true});
process.env.CHATGPT_HOME=TEST_HOME;

const [watchers,accounts,freeze]=await Promise.all([
 import('../../src/chatgpt/watchers.ts'),
 import('../../src/chatgpt/accounts.ts'),
 import('../../src/chatgpt/freeze.ts'),
]);
const {InvoiceWatcher,MIN_WATCH_INTERVAL_MS,DEFAULT_WATCH_INTERVAL_MS,MAX_WATCH_INTERVAL_MS,FREEZE_RECHECK_MS}=watchers;
const {setFreeze,FREEZE_CODE}=freeze;
const account=(id:string)=>({id,label:id,baseURL:'https://chatgpt.com',created:'2026-09-15T00:00:00.000Z',source:{provider:'managed' as const}});

type Sleep={milliseconds:number;signal:AbortSignal;settled:boolean;resolve:()=>void};
class ManualScheduler {
 time=Date.parse('2026-09-15T00:00:00.000Z');
 sleeps:Sleep[]=[];
 now=()=>this.time;
 sleep=(milliseconds:number,signal:AbortSignal)=>new Promise<void>(resolve=>{
  const entry:Sleep={milliseconds,signal,settled:false,resolve:()=>{}};
  const settle=()=>{if(entry.settled)return;entry.settled=true;signal.removeEventListener('abort',settle);resolve();};
  entry.resolve=settle;this.sleeps.push(entry);
  if(signal.aborted)settle();else signal.addEventListener('abort',settle,{once:true});
 });
 pending(){return this.sleeps.filter(sleep=>!sleep.settled);}
 async advance(){const sleep=this.pending()[0];if(!sleep)throw new Error('No scheduled watcher sleep.');this.time+=sleep.milliseconds;sleep.resolve();await flush();return sleep.milliseconds;}
}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

process.on('exit',()=>rmSync(TEST_HOME,{recursive:true,force:true}));

describe('invoice watcher configuration',()=>{
 test('defaults to a disabled six-hour schedule and enforces bounded absolute configuration',()=>{
  const watcher=new InvoiceWatcher(account('config'),async()=>({}),{scheduler:new ManualScheduler()});
  expect(watcher.config()).toMatchObject({enabled:false,intervalMs:DEFAULT_WATCH_INTERVAL_MS,backoffBaseMs:MIN_WATCH_INTERVAL_MS,maxBackoffMs:DEFAULT_WATCH_INTERVAL_MS});
  expect(()=>watcher.config({intervalMs:MIN_WATCH_INTERVAL_MS-1})).toThrow('must be an integer from 60000');
  expect(()=>watcher.config({intervalMs:MAX_WATCH_INTERVAL_MS+1})).toThrow('must be an integer from 60000');
  expect(()=>watcher.config({projectPath:'relative/invoices'})).toThrow('must be absolute');
  expect(()=>watcher.config({backoffBaseMs:120_000,maxBackoffMs:60_000})).toThrow('cannot exceed');
 });

 test('persists configuration for a new daemon instance',()=>{
  const scheduler=new ManualScheduler(),a=account('persist-config');
  const first=new InvoiceWatcher(a,async()=>({}),{scheduler});
  first.config({enabled:true,intervalMs:120_000,projectPath:'/tmp/invoices'});
  const replacement=new InvoiceWatcher(a,async()=>({}),{scheduler});
  expect(replacement.config()).toMatchObject({enabled:true,intervalMs:120_000,projectPath:'/tmp/invoices'});
 });
});

describe('invoice watcher scheduling and isolation',()=>{
 test('reads fresh config at the cycle boundary and never overlaps one pending sync',async()=>{
  const scheduler=new ManualScheduler(),gate=deferred<any>(),seen:string[]=[],events:any[]=[];
  const watcher=new InvoiceWatcher(account('single-flight'),async config=>{seen.push(config.projectPath!);return gate.promise;},{scheduler,emit:event=>events.push(event)});
  watcher.config({enabled:true,intervalMs:60_000,projectPath:'/first'});
  expect(watcher.start()).toMatchObject({started:true,running:true});
  expect(scheduler.pending()[0].milliseconds).toBe(60_000);

  watcher.config({projectPath:'/second'});
  await scheduler.advance();
  expect(seen).toEqual(['/second']);
  expect(watcher.start()).toMatchObject({started:false,pendingOutcome:true,inFlight:true});
  expect(seen).toHaveLength(1);

  expect(watcher.stop({disable:false})).toMatchObject({stopped:true,pendingOutcome:true,enabled:true});
  expect(watcher.start()).toMatchObject({started:false,pendingOutcome:true});
  gate.resolve({items:[{id:'invoice'}],complete:true});
  await flush();
  expect(seen).toHaveLength(1);
  expect(watcher.status()).toMatchObject({running:false,inFlight:false});
  expect(events.some(event=>event.type==='invoice.watcher.sync.completed'&&event.cancelledAfterStart===true)).toBe(true);
 });

 test('schedules the normal interval only after a completed cycle',async()=>{
  const scheduler=new ManualScheduler(),events:any[]=[];
  const watcher=new InvoiceWatcher(account('success'),async()=>({items:[1,2],complete:true}),{scheduler,emit:event=>events.push(event)});
  watcher.config({enabled:true,intervalMs:180_000});watcher.start();
  await scheduler.advance();
  expect(scheduler.pending()[0].milliseconds).toBe(180_000);
  expect(watcher.status()).toMatchObject({running:true,inFlight:false,failures:0});
  expect(events.find(event=>event.type==='invoice.watcher.sync.completed')).toMatchObject({count:2,complete:true,cancelledAfterStart:false});
  watcher.stop();
 });

 test('backs off retryable failures with one structured error event',async()=>{
  const scheduler=new ManualScheduler(),events:any[]=[],concurrency:number[]=[];let calls=0,active=0;
  const watcher=new InvoiceWatcher(account('backoff'),async()=>{calls++;active++;concurrency.push(active);try{if(calls===1)throw new Error('503 socket unavailable');return {items:[],complete:true};}finally{active--;}},{scheduler,emit:event=>events.push(event)});
  watcher.config({enabled:true,intervalMs:600_000,backoffBaseMs:60_000,maxBackoffMs:240_000});watcher.start();
  await scheduler.advance();
  expect(scheduler.pending()[0].milliseconds).toBe(60_000);
  expect(events.find(event=>event.type==='invoice.watcher.sync.error')).toMatchObject({code:'UPSTREAM_UNAVAILABLE',retryable:true,retryScheduled:true,failures:1,delayMs:60_000});
  await scheduler.advance();
  expect(calls).toBe(2);expect(Math.max(...concurrency)).toBe(1);
  expect(scheduler.pending()[0].milliseconds).toBe(600_000);
  watcher.stop();
 });

 test('pauses an unknown mutation outcome instead of replaying it',async()=>{
  const scheduler=new ManualScheduler(),events:any[]=[];let calls=0;
  const watcher=new InvoiceWatcher(account('unknown'),async()=>{calls++;throw new Error('Invoice import timed out without a completion receipt.');},{scheduler,emit:event=>events.push(event)});
  watcher.config({enabled:true,intervalMs:60_000});watcher.start();
  await scheduler.advance();
  expect(calls).toBe(1);
  expect(scheduler.pending()).toHaveLength(0);
  expect(watcher.status()).toMatchObject({running:false,paused:'outcome-unknown',failures:1});
  expect(events.find(event=>event.type==='invoice.watcher.sync.error')).toMatchObject({code:'OUTCOME_UNKNOWN',retryScheduled:false,paused:'outcome-unknown'});
 });
});

describe('daemon restart recovery',()=>{
 test('restores a clean persisted deadline without an immediate duplicate sync',async()=>{
  const scheduler=new ManualScheduler(),a=account('restore-clean');let calls=0;
  const watcher=new InvoiceWatcher(a,async()=>{calls++;return {};},{scheduler});
  watcher.config({enabled:true,intervalMs:120_000});
  accounts.atomicJSON(join(accounts.accountDir(a),'invoice-watcher-state.json'),{version:1,failures:0,nextRunAt:scheduler.now()+90_000});
  expect(watcher.start({restore:true})).toMatchObject({started:true,running:true});
  expect(scheduler.pending()[0].milliseconds).toBe(90_000);
  expect(calls).toBe(0);
  watcher.stop({disable:false});
 });

 test('turns a crash-era in-flight marker into an acknowledged pause, never a replay',()=>{
  const scheduler=new ManualScheduler(),events:any[]=[],a=account('restore-ambiguous');let calls=0;
  const watcher=new InvoiceWatcher(a,async()=>{calls++;return {};},{scheduler,emit:event=>events.push(event)});
  watcher.config({enabled:true,intervalMs:60_000});
  accounts.atomicJSON(join(accounts.accountDir(a),'invoice-watcher-state.json'),{version:1,failures:0,inFlight:true,operationStartedAt:scheduler.now()-30_000});
  expect(watcher.start({restore:true})).toMatchObject({started:false,running:false,paused:'previous-outcome-unknown'});
  expect(calls).toBe(0);expect(scheduler.pending()).toHaveLength(0);
  expect(events.find(event=>event.type==='invoice.watcher.recovered')).toMatchObject({paused:true,reason:'previous-outcome-unknown'});

  expect(watcher.start({acknowledgeAmbiguous:true})).toMatchObject({started:true,running:true,paused:null});
  expect(scheduler.pending()[0].milliseconds).toBe(60_000);
  expect(calls).toBe(0);
  watcher.stop();
 });
});


// ---------------------------------------------------------------- freeze + resumable filing
// A frozen account is fire17's deliberate stop. It must never look like an outage: no site work,
// no failure count, no exponential backoff — just a flat re-check until he thaws.
const PDF='%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n';
function download(a:any,name='invoice.pdf'){
 const dir=join(accounts.accountDir(a),'downloads',name.replace(/\W/g,'-')+'-dir');
 mkdirSync(dir,{recursive:true});
 const path=join(dir,name);
 writeFileSync(path,PDF+name);
 return {path,sha256:createHash('sha256').update(PDF+name).digest('hex')};
}
function importerStub(status:'added'|'duplicate'|'error',file='openai/2026.09.15-fire17-288ils-openai-invoice-paid-881C5514-0002.pdf'){
 const calls:string[][]=[];
 const importer=async(paths:string[],options:{projectPath?:string})=>{
  calls.push(paths);
  const results=paths.map(path=>({source:path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),status,...(status==='error'?{message:'Existing invoice importer failed during confirm (ApiError tool_missing 503).',stage:'confirm' as const,staged:true,resumable:true}:{file})}));
  return {projectPath:options.projectPath||'/invoices',results:results as any,added:status==='added'?paths.length:0,duplicates:status==='duplicate'?paths.length:0,failed:status==='error'?paths.length:0,warnings:[]};
 };
 return {importer,calls};
}

describe('frozen account',()=>{
 test('defers every cycle while frozen: no site work, no failure, no exponential backoff',async()=>{
  const scheduler=new ManualScheduler(),events:any[]=[],a=account('frozen-defer');let calls=0;
  setFreeze(a,true,{by:'test',reason:'his stop'});
  const watcher=new InvoiceWatcher(a,async()=>{calls++;return {};},{scheduler,emit:event=>events.push(event)});
  watcher.config({enabled:true,intervalMs:3_600_000});watcher.start();
  await scheduler.advance();
  expect(calls).toBe(0);
  expect(scheduler.pending()[0].milliseconds).toBe(FREEZE_RECHECK_MS);
  await scheduler.advance();
  expect(calls).toBe(0);
  expect(scheduler.pending()[0].milliseconds).toBe(FREEZE_RECHECK_MS);   // flat, never doubling
  expect(watcher.status()).toMatchObject({running:true,frozen:true,deferred:'frozen',failures:0,paused:null});
  expect(events.filter(event=>event.type==='invoice.watcher.sync.deferred')).toHaveLength(2);
  expect(events.some(event=>event.type==='invoice.watcher.sync.started')).toBe(false);

  setFreeze(a,false,{by:'test'});
  await scheduler.advance();
  expect(calls).toBe(1);
  expect(watcher.status()).toMatchObject({frozen:false,deferred:null,failures:0});
  watcher.stop();
 });

 test('a freeze raised mid-cycle defers too, instead of parking the watcher',async()=>{
  const scheduler=new ManualScheduler(),events:any[]=[],a=account('frozen-midflight');let calls=0;
  const watcher=new InvoiceWatcher(a,async()=>{calls++;throw Object.assign(new Error('ChatGPT automation is frozen; no request was sent.'),{code:FREEZE_CODE,retryable:false,action:'Only the account owner lifts it.'});},{scheduler,emit:event=>events.push(event)});
  watcher.config({enabled:true,intervalMs:3_600_000});watcher.start();
  await scheduler.advance();
  expect(calls).toBe(1);
  expect(watcher.status()).toMatchObject({running:true,paused:null,failures:0,deferred:'frozen'});
  expect(scheduler.pending()[0].milliseconds).toBe(FREEZE_RECHECK_MS);
  expect(events.find(event=>event.type==='invoice.watcher.sync.deferred')).toMatchObject({reason:'frozen',source:'error'});
  watcher.stop();
 });
});

describe('recoverable filing failures',()=>{
 test('a filing failure parks with the staged PDF listed and the decision a human must make',async()=>{
  const scheduler=new ManualScheduler(),events:any[]=[],a=account('filing-parked');
  const {path}=download(a);
  const watcher=new InvoiceWatcher(a,async()=>{throw new Error('Invoice downloaded but filing failed: Existing invoice importer failed during stage (ApiError tool_missing 503).');},{scheduler,emit:event=>events.push(event)});
  watcher.config({enabled:true,intervalMs:60_000});watcher.start();
  await scheduler.advance();
  const status=watcher.status();
  expect(status).toMatchObject({paused:'action-required',failures:1,pendingFilings:1});
  expect(status.pendingPaths).toEqual([path]);
  expect(status.decision?.pending).toEqual([path]);
  expect(status.decision?.resume).toBe('chatgpt account invoice-resume');
  const view=watcher.inspect();
  expect(view.pending[0]).toMatchObject({path,bytes:PDF.length+'invoice.pdf'.length});
  expect(view.question).toContain('downloaded but not filed');
 });

 test('resume files the staged download exactly once and a second resume is a no-op',async()=>{
  const scheduler=new ManualScheduler(),events:any[]=[],a=account('filing-resume');
  const {path}=download(a);
  const {importer,calls}=importerStub('added');
  const watcher=new InvoiceWatcher(a,async()=>{throw new Error('Invoice downloaded but filing failed: importer said no.');},{scheduler,emit:event=>events.push(event),importer});
  watcher.config({enabled:true,intervalMs:60_000,projectPath:'/tmp/invoices-fixture'});watcher.start();
  await scheduler.advance();
  expect(watcher.status()).toMatchObject({paused:'action-required',pendingFilings:1});

  const first=await watcher.resumeFiling();
  expect(first).toMatchObject({resumed:true,filed:1,duplicates:0,failed:0,pendingFilings:0,paused:null,failures:0});
  expect(calls).toEqual([[path]]);
  expect(first.results[0]).toMatchObject({status:'added'});

  const second=await watcher.resumeFiling();
  expect(second).toMatchObject({resumed:false,filed:0,failed:0});
  expect(calls).toHaveLength(1);                                   // no second filing attempt at all
  expect(events.filter(event=>event.type==='invoice.filing.resumed')).toHaveLength(1);
  expect(events.some(event=>event.type==='invoice.filing.resume.noop')).toBe(true);
 });

 test('an already-filed invoice comes back as a duplicate and is never filed twice',async()=>{
  const scheduler=new ManualScheduler(),a=account('filing-duplicate');
  download(a);
  const {importer,calls}=importerStub('duplicate');
  const watcher=new InvoiceWatcher(a,async()=>({}),{scheduler,importer});
  watcher.config({enabled:true,intervalMs:60_000});
  const resumed=await watcher.resumeFiling();
  expect(resumed).toMatchObject({resumed:true,filed:0,duplicates:1,failed:0,pendingFilings:0});
  expect(await watcher.resumeFiling()).toMatchObject({resumed:false,filed:0});
  expect(calls).toHaveLength(1);
 });

 test('a failed resume keeps the pause, the pending PDF and a fresh decision',async()=>{
  const scheduler=new ManualScheduler(),a=account('filing-resume-fails');
  const {path}=download(a);
  const {importer}=importerStub('error');
  const watcher=new InvoiceWatcher(a,async()=>({}),{scheduler,importer});
  watcher.config({enabled:true,intervalMs:60_000});
  const resumed=await watcher.resumeFiling();
  expect(resumed).toMatchObject({resumed:true,filed:0,failed:1,paused:'action-required',pendingFilings:1});
  expect(resumed.pendingPaths).toEqual([path]);
  expect(watcher.status().lastError).toMatchObject({code:'FILING_FAILED',retryable:false});
  expect(watcher.status().decision?.pending).toEqual([path]);
 });

 test('an invoice the sync already imported is not pending work',()=>{
  const scheduler=new ManualScheduler(),a=account('filing-already-synced');
  const {path,sha256}=download(a);
  accounts.atomicJSON(join(accounts.accountDir(a),'invoice-sync.json'),{invoices:{in_test:{path,sha256,imported:true,at:'2026-09-15T09:18:05.840Z',file:'openai/filed.pdf'}}});
  const watcher=new InvoiceWatcher(a,async()=>({}),{scheduler});
  expect(watcher.pendingFilings()).toEqual([]);
  expect(watcher.status()).toMatchObject({pendingFilings:0});
  expect(watcher.inspect().question).toBe('Nothing is waiting to be filed.');
 });
});
