import {afterAll,expect,test} from 'bun:test';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const TEST_HOME=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-autostart-home-'));
process.env.CHATGPT_HOME=TEST_HOME;
afterAll(()=>rmSync(TEST_HOME,{recursive:true,force:true}));

const autostart=await import('../../src/chatgpt/autostart.ts');
const account={id:'managed_test',label:'Managed test',baseURL:'https://chatgpt.com',created:'2026-09-15T00:00:00.000Z',profilePath:join(TEST_HOME,'managed-profile'),source:{provider:'managed' as const}};
const jobLabel=(id:string)=>autostart.label({...account,id});
function harness(){
 const launchAgents=join(TEST_HOME,'Library','LaunchAgents'),calls:string[][]=[];let loaded=false,jobPid=4321;
 const run=async(argv:string[])=>{calls.push(argv);const op=argv[1];if(op==='print')return {ok:loaded,code:loaded?0:113,stdout:loaded?`state = running\npid = ${jobPid}\n`:''};if(op==='bootstrap')loaded=true;if(op==='bootout')loaded=false;return {ok:true,code:0};};
 return {launchAgents,calls,run,isLoaded:()=>loaded,setLoaded:(value:boolean)=>{loaded=value;},setJobPid:(value:number)=>{jobPid=value;}};
}
const options=(h:ReturnType<typeof harness>)=>({platform:'darwin',architecture:'arm64',uid:501,launchAgentsDir:h.launchAgents,bunPath:'/opt/bun/bin/bun',cliPath:'/work/APIPlan/bin/chatgpt.ts',workingDirectory:'/work/APIPlan',run:h.run,daemonActive:async()=>false});

test('installs one private current-user LaunchAgent with absolute daemon arguments',async()=>{
 const h=harness();
 const result=await autostart.install(account,options(h));
 const xml=readFileSync(result.plist,'utf8');
 expect(result).toMatchObject({supported:true,platform:'darwin',architecture:'arm64',account:'managed_test',label:jobLabel('managed_test'),installed:true,loaded:true,daemonActive:false,startupPending:true,program:['/opt/bun/bin/bun','/work/APIPlan/bin/chatgpt.ts','--account','managed_test','_daemon']});
 expect(result.label).toMatch(/^com\.apiplan\.chatgpt\.managed_test\.[0-9a-f]{12}$/);
 expect(xml).toContain('<string>/opt/bun/bin/bun</string>');
 expect(xml).toContain('<string>/work/APIPlan/bin/chatgpt.ts</string>');
 expect(xml).toContain('<string>managed_test</string>');
 expect(xml).toContain('<key>CHATGPT_HOME</key>');
 expect(xml).toContain('<key>RunAtLoad</key>');expect(xml).toContain('<key>KeepAlive</key>');
 expect(xml).not.toMatch(/token|cookie|authorization/i);
 expect(h.calls).toEqual([
  ['/bin/launchctl','print',`gui/501/${jobLabel('managed_test')}`],
  ['/bin/launchctl','enable',`gui/501/${jobLabel('managed_test')}`],
  ['/bin/launchctl','bootstrap','gui/501',result.plist],
 ]);
 if(process.platform!=='win32'){
  expect(statSync(result.plist).mode&0o777).toBe(0o600);
  expect(statSync(result.logs.stdout).mode&0o777).toBe(0o600);
  expect(statSync(result.logs.stderr).mode&0o777).toBe(0o600);
  expect(statSync(h.launchAgents).mode&0o777).toBe(0o700);
 }
 const state=await autostart.status(account,options(h));
 expect(state).toMatchObject({installed:true,loaded:true,jobPid:4321,daemonActive:false,ownership:'starting-or-unhealthy',ownershipMatch:null});
});

test('preserves an existing LaunchAgents directory mode',async()=>{
 const h=harness();
 mkdirSync(h.launchAgents,{recursive:true,mode:0o755});chmodSync(h.launchAgents,0o755);
 await autostart.install({...account,id:'mode_test'},options(h));
 if(process.platform!=='win32')expect(statSync(h.launchAgents).mode&0o777).toBe(0o755);
});

test('refuses an active daemon or already loaded job before replacing a plist',async()=>{
 const active=harness(),activeOptions={...options(active),daemonActive:async()=>true};
 await expect(autostart.install({...account,id:'active'},activeOptions)).rejects.toThrow('Stop it and reconcile existing jobs');
 expect(active.calls).toEqual([]);
 expect(existsSync(join(active.launchAgents,jobLabel('active')+'.plist'))).toBe(false);

 const loaded=harness();loaded.setLoaded(true);
 await expect(autostart.install({...account,id:'loaded'},options(loaded))).rejects.toThrow('already loaded');
 expect(loaded.calls).toEqual([['/bin/launchctl','print',`gui/501/${jobLabel('loaded')}`]]);
});

test('optionally waits a bounded interval for the bootstrapped daemon health',async()=>{
 const h=harness(),sleeps:number[]=[];let probes=0;
 const result=await autostart.install({...account,id:'wait_ready'},{...options(h),daemonActive:async()=>++probes>=3,waitForDaemonMs:1000,pollIntervalMs:50,sleep:async milliseconds=>{sleeps.push(milliseconds);}});
 expect(result).toMatchObject({loaded:true,daemonActive:true,startupPending:false,waitedMs:50});
 expect(probes).toBe(3);expect(sleeps).toEqual([50]);
});

test('status exposes a launchd and daemon PID ownership mismatch',async()=>{
 const h=harness(),selected={...account,id:'pid_mismatch'};await autostart.install(selected,options(h));h.setJobPid(7001);
 writeFileSync(join(TEST_HOME,'accounts','pid_mismatch','daemon.json'),JSON.stringify({pid:7002,port:1234,token:'fixture'}),{mode:0o600});
 const state=await autostart.status(selected,{...options(h),daemonActive:async()=>true});
 expect(state).toMatchObject({loaded:true,daemonActive:true,jobPid:7001,daemonPid:7002,ownership:'mismatch',ownershipMatch:false});
});

test('uninstall disables only the job and preserves account, profile and logs',async()=>{
 const h=harness(),selected={...account,id:'preserve'};const installed=await autostart.install(selected,options(h));
 writeFileSync(join(TEST_HOME,'accounts','preserve','sentinel'),'account data',{mode:0o600});
 writeFileSync(selected.profilePath!,'profile data',{mode:0o600});
 const result=await autostart.uninstall(selected,options(h));
 expect(result).toMatchObject({installed:false,loaded:false,removedPlist:true,preserved:{profilePath:selected.profilePath,logs:installed.logs.stdout.replace('/stdout.log','')}});
 expect(existsSync(installed.plist)).toBe(false);
 expect(readFileSync(join(TEST_HOME,'accounts','preserve','sentinel'),'utf8')).toBe('account data');
 expect(readFileSync(selected.profilePath!,'utf8')).toBe('profile data');
 expect(existsSync(installed.logs.stdout)).toBe(true);expect(existsSync(installed.logs.stderr)).toBe(true);
 expect(h.calls.slice(-3)).toEqual([
  ['/bin/launchctl','print',`gui/501/${jobLabel('preserve')}`],
  ['/bin/launchctl','bootout',`gui/501/${jobLabel('preserve')}`],
  ['/bin/launchctl','disable',`gui/501/${jobLabel('preserve')}`],
 ]);
});

test('standard home keeps the installed label while custom homes are stable and isolated',async()=>{
 expect(autostart.label(account,autostart.STANDARD_ROOT)).toBe('com.apiplan.chatgpt.managed_test');
 const script=join(import.meta.dir,'chatgpt-autostart-label.ts');
 const from=async(root:string)=>{const child=Bun.spawn([process.execPath,script],{stdin:'ignore',stdout:'pipe',stderr:'pipe',env:{...process.env,CHATGPT_HOME:root}});const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code!==0)throw new Error(stderr);return stdout.trim();};
 const first=await from(join(TEST_HOME,'root-a')),second=await from(join(TEST_HOME,'root-b')),repeat=await from(join(TEST_HOME,'root-a'));
 expect(first).toBe(repeat);expect(first).not.toBe(second);
 expect(first).toMatch(/^com\.apiplan\.chatgpt\.default\.[0-9a-f]{12}$/);
});

test('reports unsupported operating systems with platform and architecture without running commands',async()=>{
 const h=harness(),unsupported={...options(h),platform:'linux',architecture:'x64'};
 expect(await autostart.status(account,unsupported)).toMatchObject({supported:false,platform:'linux',architecture:'x64',installed:false,loaded:false,daemonActive:false});
 await expect(autostart.install(account,unsupported)).rejects.toThrow('macOS launchd only; this machine is linux/x64');
 await expect(autostart.uninstall(account,unsupported)).rejects.toThrow('macOS launchd only; this machine is linux/x64');
 expect(h.calls).toEqual([]);
});

test('EPERM process probes fail closed while ESRCH is the only dead result',async()=>{
 expect(autostart.processLiveness(42,()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});})).toBe('unknown');
 expect(autostart.processLiveness(42,()=>{throw Object.assign(new Error('gone'),{code:'ESRCH'});})).toBe('dead');
 expect(autostart.processLiveness(42,()=>{})).toBe('alive');
 expect(autostart.processLiveness(0,()=>{throw new Error('must not run');})).toBe('unknown');
 const selected={...account,id:'eperm_daemon'},dir=join(TEST_HOME,'accounts','eperm_daemon');mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'daemon.json'),JSON.stringify({pid:42,port:4321,token:'fixture'}),{mode:0o600});
 expect(await autostart.activeDaemon(selected,{processProbe:()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});},daemonHealth:async()=>{throw new Error('sandbox blocked');}})).toBe(true);
 expect(autostart.daemonProcessLiveness(selected,{processProbe:()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});} })).toBe('unknown');
 expect(await autostart.activeDaemon(selected,{processProbe:()=>{},daemonHealth:async()=>false})).toBe(true);
 let healthCalled=false;
 expect(await autostart.activeDaemon(selected,{processProbe:()=>{throw Object.assign(new Error('gone'),{code:'ESRCH'});},daemonHealth:async()=>{healthCalled=true;return true;}})).toBe(false);
 expect(healthCalled).toBe(false);
});
