import {expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectTakeoutRecovery,readTakeoutWatchStatus,setTakeoutSupervisorPaused,TakeoutSupervisor} from '../src/chatgpt/takeout-supervisor.ts';

function fixture(run:(root:string,account:string)=>Promise<void>|void){const account=mkdtempSync(join(tmpdir(),'takeout-supervisor-')),root=join(account,'takeout');mkdirSync(root);const now=Date.now(),manifest={version:1,account:{id:'test'},started:new Date(now-10_000).toISOString(),updated:new Date(now-1_000).toISOString(),complete:false,files:{one:{}},coverage:{'conversation:one':{required:true,status:'complete'},'conversation:two':{required:true,status:'partial'},'tasks.list':{required:true,status:'partial'}}};writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest));return Promise.resolve(run(root,account)).finally(()=>rmSync(account,{recursive:true,force:true}));}
function active(account:string,root:string,now:number,pid=42,ended=false,rotated=false){writeFileSync(join(root,'.writer.lock'),String(pid));const start={time:new Date(now-1000).toISOString(),type:'operation.start',id:'run',operation:'takeout.run'},events=[start,...(ended?[{time:new Date(now-500).toISOString(),type:'operation.complete',id:'run',operation:'takeout.run'}]:[])];writeFileSync(join(account,rotated?'events.jsonl.1':'events.jsonl'),events.map(x=>JSON.stringify(x)).join('\n')+'\n');}

test('requires an active operation receipt in addition to the daemon PID and reports concrete gaps',()=>fixture((root,account)=>{const now=Date.now();active(account,root,now,42,false,true);writeFileSync(join(account,'request-state.json'),JSON.stringify({rateLimitedUntil:now+60_000,rateFailures:3,limitedScope:'/backend-api/conversation/{id}'}));const state=inspectTakeoutRecovery(root,{now,isPidAlive:()=>true,accountRoot:account});expect(state.state).toBe('rate-limited');expect(state.writer.activeOperation).toBe(true);expect(state.progress.conversations).toEqual({complete:1,partial:1,total:2});expect(state.progress.gaps).toEqual({conversation:1,'tasks.list':1});expect(state.rateLimit?.failures).toBe(3);}));

test('missing event evidence never makes a live daemon lock safe to clear',()=>fixture((root)=>{writeFileSync(join(root,'.writer.lock'),'42');expect(inspectTakeoutRecovery(root,{now:Date.now(),staleAfterMs:60_000,isPidAlive:()=>true}).state).toBe('uncertain-lock');const stalled=inspectTakeoutRecovery(root,{now:Date.now()+1000,staleAfterMs:0,isPidAlive:()=>true});expect(stalled.state).toBe('uncertain-lock');expect(stalled.writer.stalled).toBe(true);expect(stalled.writer.stale).toBe(false);}));

test('a matching terminal receipt makes a leftover live-daemon lock recoverable',()=>fixture(async(root,account)=>{const now=Date.now();active(account,root,now,42,true);let launches=0;const supervisor=new TakeoutSupervisor({output:root,accountRoot:account,now:()=>now,isPidAlive:()=>true,launch:async()=>{launches++;}});expect((await supervisor.tick()).state).toBe('ready-to-resume');expect(launches).toBe(1);expect(existsSync(join(root,'.writer.lock'))).toBe(false);}));

test('clears a revalidated stale lock and submits exactly one resume for an unchanged checkpoint',()=>fixture(async root=>{writeFileSync(join(root,'.writer.lock'),'404');let launches=0;const supervisor=new TakeoutSupervisor({output:root,staleAfterMs:0,isPidAlive:()=>false,launch:async()=>{launches++;}});await supervisor.tick();await supervisor.tick();expect(launches).toBe(1);expect(existsSync(join(root,'.writer.lock'))).toBe(false);expect(JSON.parse(readFileSync(join(root,'recovery-status.json'),'utf8')).state).toBe('ready-to-resume');}));

test('explicit pause prevents resume and unchanged active state stays quiet',()=>fixture(async(root,account)=>{const now=Date.now();active(account,root,now);setTakeoutSupervisorPaused(root,true);let launches=0;const paused=new TakeoutSupervisor({output:root,now:()=>now,isPidAlive:()=>true,launch:async()=>{launches++;}});expect((await paused.tick()).state).toBe('explicitly-paused');expect(launches).toBe(0);setTakeoutSupervisorPaused(root,false);const events:any[]=[];const watching=new TakeoutSupervisor({output:root,now:()=>now,isPidAlive:()=>true,emit:event=>events.push(event),launch:async()=>{launches++;}});await watching.tick();await watching.tick();expect(events.length).toBe(1);expect(launches).toBe(0);expect(readFileSync(join(root,'recovery-events.jsonl'),'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(2);}));

test('an active operation with no checkpoint movement is surfaced as stalled without competing',()=>fixture(async(root,account)=>{const now=Date.now()+1000;active(account,root,now-1000);let launches=0;const supervisor=new TakeoutSupervisor({output:root,now:()=>now,staleAfterMs:0,isPidAlive:()=>true,launch:async()=>{launches++;}});expect((await supervisor.tick()).state).toBe('stalled-active');expect(launches).toBe(0);}));

test('watch status is a synchronous disk read and reports configured supervisor liveness',()=>fixture((root,account)=>{const now=Date.now();active(account,root,now,42);writeFileSync(join(root,'.supervisor.lock'),'42');writeFileSync(join(account,'takeout-supervisor.json'),JSON.stringify({enabled:true,output:root}));const status=readTakeoutWatchStatus(account,undefined,{now,isPidAlive:pid=>pid===42});expect(status.source).toBe('local durable recovery state');expect(status.output).toBe(root);expect(status.enabled).toBe(true);expect(status.running).toBe(true);expect(status.supervisor).toEqual({present:true,pid:42,pidAlive:true,pidLiveness:'alive'});expect(status.writer.activeOperation).toBe(true);expect(status.progress.requiredIncomplete).toBe(2);}));

test('watch status does not report a differently configured archive as enabled',()=>fixture((root,account)=>{writeFileSync(join(account,'takeout-supervisor.json'),JSON.stringify({enabled:true,output:join(account,'other')}));const status=readTakeoutWatchStatus(account,root,{isPidAlive:()=>true});expect(status.enabled).toBe(false);expect(status.running).toBe(false);expect(status.output).toBe(root);}));

// Liveness has three answers. `kill(pid,0)` says ESRCH for a dead process and EPERM for one this user
// may not signal — a sandbox or another user answers EPERM for every PID, alive or dead. Reading EPERM
// as "alive" pinned the archive permanently: a killed writer's lock looked owned forever.
test('the three liveness answers permit three different things',()=>fixture(async(root,account)=>{
 const now=Date.now();writeFileSync(join(root,'.writer.lock'),'404');
 const unknown=inspectTakeoutRecovery(root,{now,staleAfterMs:0,pidLiveness:()=>'unknown',accountRoot:account});
 expect(unknown.state).toBe('uncertain-lock');expect(unknown.writer).toMatchObject({present:true,pid:404,pidAlive:false,pidLiveness:'unknown',stale:false});
 let unknownLaunches=0;const held=new TakeoutSupervisor({output:root,accountRoot:account,now:()=>now,staleAfterMs:0,pidLiveness:()=>'unknown',launch:async()=>{unknownLaunches++;}});
 expect((await held.tick()).state).toBe('uncertain-lock');expect(unknownLaunches).toBe(0);expect(existsSync(join(root,'.writer.lock'))).toBe(true);
 active(account,root,now,42);
 const alive=inspectTakeoutRecovery(root,{now,pidLiveness:()=>'alive',accountRoot:account});
 expect(alive.state).toBe('active');expect(alive.writer.pidLiveness).toBe('alive');expect(alive.writer.stale).toBe(false);
 let aliveLaunches=0;const waiting=new TakeoutSupervisor({output:root,accountRoot:account,now:()=>now,pidLiveness:()=>'alive',launch:async()=>{aliveLaunches++;}});
 expect((await waiting.tick()).state).toBe('active');expect(aliveLaunches).toBe(0);expect(existsSync(join(root,'.writer.lock'))).toBe(true);
 const dead=inspectTakeoutRecovery(root,{now,pidLiveness:()=>'dead',accountRoot:account});
 expect(dead.state).toBe('stale-lock');expect(dead.writer.pidLiveness).toBe('dead');expect(dead.writer.stale).toBe(true);
 let deadLaunches=0;const recovering=new TakeoutSupervisor({output:root,accountRoot:account,now:()=>now,pidLiveness:()=>'dead',launch:async()=>{deadLaunches++;}});
 expect((await recovering.tick()).state).toBe('ready-to-resume');expect(deadLaunches).toBe(1);expect(existsSync(join(root,'.writer.lock'))).toBe(false);
}));

test('an unprobeable owner with a matching completed receipt is still recoverable',()=>fixture(async(root,account)=>{
 const now=Date.now();active(account,root,now,42,true);let launches=0;
 const supervisor=new TakeoutSupervisor({output:root,accountRoot:account,now:()=>now,pidLiveness:()=>'unknown',launch:async()=>{launches++;}});
 expect((await supervisor.tick()).state).toBe('ready-to-resume');expect(launches).toBe(1);expect(existsSync(join(root,'.writer.lock'))).toBe(false);
}));

test('a frozen account defers without launching, records no failure, and resumes once after the thaw',()=>fixture(async(root,account)=>{
 const now=Date.now();writeFileSync(join(account,'freeze.json'),JSON.stringify({frozen:true,by:'cli',reason:'his STOP'}));
 let launches=0;const events:any[]=[];
 const supervisor=new TakeoutSupervisor({output:root,accountRoot:account,now:()=>now,pidLiveness:()=>'dead',emit:event=>events.push(event),launch:async()=>{launches++;}});
 const frozen=await supervisor.tick();
 expect(frozen.state).toBe('frozen');expect(frozen.freeze).toMatchObject({frozen:true,reason:'his STOP'});expect(launches).toBe(0);
 expect(JSON.parse(readFileSync(join(root,'recovery-status.json'),'utf8')).state).toBe('frozen');
 await supervisor.tick();expect(launches).toBe(0);expect(events.some(event=>event.type==='takeout.supervisor.resume-error')).toBe(false);
 writeFileSync(join(account,'freeze.json'),JSON.stringify({frozen:false,thawedAt:new Date().toISOString()}));
 expect((await supervisor.tick()).state).toBe('ready-to-resume');expect(launches).toBe(1);
}));

test('a FROZEN refusal from the launcher is a deferral, not a failed resume',()=>fixture(async(root,account)=>{
 const now=Date.now();let launches=0,refuse=true;const events:any[]=[];
 const supervisor=new TakeoutSupervisor({output:root,accountRoot:account,now:()=>now,emit:event=>events.push(event),launch:async()=>{launches++;if(refuse)throw Object.assign(new Error('ChatGPT automation is frozen; no request was sent.'),{code:'FROZEN'});}});
 await supervisor.tick();
 expect(launches).toBe(1);expect(events.some(event=>event.type==='takeout.supervisor.frozen')).toBe(true);expect(events.some(event=>event.type==='takeout.supervisor.resume-error')).toBe(false);
 refuse=false;await supervisor.tick();expect(launches).toBe(2);
}));

test('a supervisor never steals a lock whose owner cannot be probed',()=>fixture(async(root,account)=>{
 writeFileSync(join(root,'.supervisor.lock'),'404');
 await expect(new TakeoutSupervisor({output:root,accountRoot:account,pidLiveness:()=>'unknown',launch:async()=>{}}).run()).rejects.toThrow('cannot be probed');
 expect(existsSync(join(root,'.supervisor.lock'))).toBe(true);
 await expect(new TakeoutSupervisor({output:root,accountRoot:account,pidLiveness:()=>'alive',launch:async()=>{}}).run()).rejects.toThrow('already running');
 const controller=new AbortController();controller.abort();let launches=0;
 await new TakeoutSupervisor({output:root,accountRoot:account,staleAfterMs:0,pidLiveness:()=>'dead',signal:controller.signal,launch:async()=>{launches++;}}).run();
 expect(launches).toBe(1);expect(existsSync(join(root,'.supervisor.lock'))).toBe(false);
}));
