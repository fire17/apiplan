import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,chmodSync,unlinkSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ROOT,accountDir,privateDir,readJSON,validId,type Account} from './accounts.ts';

export const AUTOSTART_LABEL_PREFIX='com.apiplan.chatgpt';
export const STANDARD_ROOT=resolve(join(homedir(),'.apiplan','chatgpt'));
export type CommandResult={ok:boolean;code?:number;stdout?:string;stderr?:string};
export type AutostartOptions={
 platform?:string;architecture?:string;uid?:number;launchAgentsDir?:string;
 bunPath?:string;cliPath?:string;workingDirectory?:string;
 run?:(argv:string[])=>Promise<CommandResult>;
 daemonActive?:(account:Account)=>Promise<boolean>;
 processProbe?:(pid:number)=>void;
 daemonHealth?:(url:string,token:string)=>Promise<boolean>;
 waitForDaemonMs?:number;pollIntervalMs?:number;sleep?:(milliseconds:number)=>Promise<void>;
};

const xml=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const string=(value:string)=>`  <string>${xml(value)}</string>`;
export function label(account:Account,root=ROOT){const resolved=resolve(root),suffix=resolved===STANDARD_ROOT?'':'.'+createHash('sha256').update(resolved).digest('hex').slice(0,12);return `${AUTOSTART_LABEL_PREFIX}.${validId(account.id)}${suffix}`;}

function paths(account:Account,options:AutostartOptions={}){
 const repository=resolve(options.workingDirectory||join(import.meta.dir,'../..'));
 const launchAgents=resolve(options.launchAgentsDir||join(homedir(),'Library','LaunchAgents'));
 const jobLabel=label(account),logs=join(accountDir(account),'autostart');
 return {repository,launchAgents,jobLabel,plist:join(launchAgents,jobLabel+'.plist'),logs,stdout:join(logs,'stdout.log'),stderr:join(logs,'stderr.log'),bun:resolve(options.bunPath||process.execPath),cli:resolve(options.cliPath||join(repository,'bin','chatgpt.ts'))};
}

function support(options:AutostartOptions={}){
 const platform=options.platform||process.platform,architecture=options.architecture||process.arch;
 return {supported:platform==='darwin',platform,architecture,reason:platform==='darwin'?undefined:`ChatGPT daemon autostart supports macOS launchd only; this machine is ${platform}/${architecture}.`};
}
function requireSupport(options:AutostartOptions={}){const result=support(options);if(!result.supported)throw new Error(result.reason);return result;}
function domain(options:AutostartOptions={}){const uid=options.uid??process.getuid?.();if(!Number.isInteger(uid)||Number(uid)<0)throw new Error('Cannot determine the current macOS user for launchd.');return `gui/${uid}`;}

async function command(argv:string[]):Promise<CommandResult>{
 const child=Bun.spawn(argv,{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 return {ok:code===0,code,stdout,stderr};
}
export type ProcessLiveness='alive'|'dead'|'unknown';
export function processLiveness(pid:number,probe:(pid:number)=>void=(value=>process.kill(value,0))):ProcessLiveness{
 if(!Number.isSafeInteger(pid)||pid<=0)return 'unknown';
 try{probe(pid);return 'alive';}catch(error:any){return error?.code==='ESRCH'?'dead':'unknown';}
}
export async function activeDaemon(account:Account,options:AutostartOptions={}){
 const state=readJSON<any>(join(accountDir(account),'daemon.json'),{});
 if(!Number.isSafeInteger(state.pid)||state.pid<=0||!Number.isInteger(state.port)||state.port<=0||state.port>65535||typeof state.token!=='string'||!state.token)return false;
 const liveness=processLiveness(state.pid,options.processProbe);
 if(liveness==='dead')return false;
 try{const healthy=options.daemonHealth?await options.daemonHealth(`http://127.0.0.1:${state.port}/health`,state.token):(await fetch(`http://127.0.0.1:${state.port}/health`,{headers:{'x-chatgpt-token':state.token},signal:AbortSignal.timeout(750)})).ok;return healthy||liveness!=='dead';
 }catch{return true; /* A live or inaccessible PID is not safe to replace. */}
}
function launchctl(options:AutostartOptions={}){return options.run||command;}
function launchctlPath(){return '/bin/launchctl';}
async function loaded(account:Account,options:AutostartOptions={}){
 const result=await launchctl(options)([launchctlPath(),'print',`${domain(options)}/${label(account)}`]);
 const match=result.ok?result.stdout?.match(/(?:^|\s)pid\s*=\s*(\d+)\b/m):undefined;
 return {loaded:result.ok,jobPid:match?Number(match[1]):undefined,result};
}
function ensurePrivateDirectory(path:string){const existed=existsSync(path);mkdirSync(path,{recursive:true,mode:0o700});if(!existed)chmodSync(path,0o700);return path;}
function touchPrivate(path:string){ensurePrivateDirectory(dirname(path));const fd=openSync(path,'a',0o600);closeSync(fd);chmodSync(path,0o600);}
function atomicText(path:string,value:string){
 ensurePrivateDirectory(dirname(path));
 if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('Autostart plist cannot be a symbolic link.');
 const temporary=path+'.'+process.pid+'.'+randomUUID()+'.tmp';
 try{writeFileSync(temporary,value,{mode:0o600});chmodSync(temporary,0o600);renameSync(temporary,path);chmodSync(path,0o600);}finally{try{unlinkSync(temporary);}catch{}}
}
async function waitForDaemon(account:Account,check:(account:Account)=>Promise<boolean>,options:AutostartOptions={}){
 const timeout=options.waitForDaemonMs??0,interval=options.pollIntervalMs??100;
 if(!Number.isFinite(timeout)||timeout<0||timeout>60000)throw new Error('Autostart daemon wait must be from 0 to 60000 milliseconds.');
 if(!Number.isFinite(interval)||interval<10||interval>5000)throw new Error('Autostart poll interval must be from 10 to 5000 milliseconds.');
 let active=await check(account),waited=0;const sleep=options.sleep||Bun.sleep;
 while(!active&&waited<timeout){const delay=Math.min(interval,timeout-waited);await sleep(delay);waited+=delay;active=await check(account);}
 return {daemonActive:active,startupPending:!active,waitedMs:waited};
}
function daemonPid(account:Account){const pid=readJSON<any>(join(accountDir(account),'daemon.json'),{}).pid;return Number.isInteger(pid)&&pid>0?pid:undefined;}
export function daemonProcessLiveness(account:Account,options:AutostartOptions={}):ProcessLiveness{return processLiveness(daemonPid(account)??0,options.processProbe);}

export function plist(account:Account,options:AutostartOptions={}){
 const p=paths(account,options);
 const argumentsXML=[p.bun,p.cli,'--account',account.id,'_daemon'].map(string).join('\n');
 return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
${string(p.jobLabel)}
  <key>ProgramArguments</key>
  <array>
${argumentsXML}
  </array>
  <key>WorkingDirectory</key>
${string(p.repository)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>CHATGPT_HOME</key>
${string(ROOT)}
  </dict>
  <key>StandardOutPath</key>
${string(p.stdout)}
  <key>StandardErrorPath</key>
${string(p.stderr)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
}

/** Install one current-user launchd job. Callers must stop manually started daemons first. */
export async function install(account:Account,options:AutostartOptions={}){
 const architecture=requireSupport(options),p=paths(account,options),check=options.daemonActive||(account=>activeDaemon(account,options)),isActive=await check(account);
 if(isActive)throw new Error(`A ChatGPT daemon is already active for account ${account.id}. Stop it and reconcile existing jobs before installing autostart.`);
 const state=await loaded(account,options);
 if(state.loaded)throw new Error(`The ChatGPT autostart job for account ${account.id} is already loaded. Stop it and reconcile existing jobs before installing autostart.`);
 ensurePrivateDirectory(p.launchAgents);
 privateDir(p.logs);touchPrivate(p.stdout);touchPrivate(p.stderr);atomicText(p.plist,plist(account,options));
 const target=`${domain(options)}/${p.jobLabel}`,run=launchctl(options);
 const enabled=await run([launchctlPath(),'enable',target]);
 if(!enabled.ok)throw new Error('launchctl could not enable the ChatGPT autostart job.');
 const bootstrapped=await run([launchctlPath(),'bootstrap',domain(options),p.plist]);
 if(!bootstrapped.ok)throw new Error('launchctl could not bootstrap the ChatGPT autostart job. The private plist was kept for inspection.');
 const readiness=await waitForDaemon(account,check,options);
 return {...architecture,account:account.id,label:p.jobLabel,installed:true,loaded:true,...readiness,plist:p.plist,logs:{stdout:p.stdout,stderr:p.stderr},program:[p.bun,p.cli,'--account',account.id,'_daemon']};
}

export async function status(account:Account,options:AutostartOptions={}){
 const architecture=support(options);
 if(!architecture.supported)return {...architecture,account:account.id,label:label(account),installed:false,loaded:false,daemonActive:false};
 const p=paths(account,options);
 const [state,isActive]=await Promise.all([loaded(account,options),(options.daemonActive||(account=>activeDaemon(account,options)))(account)]);
 const installed=existsSync(p.plist)&&!lstatSync(p.plist).isSymbolicLink();
 const localPid=daemonPid(account),ownershipMatch=state.jobPid&&localPid?state.jobPid===localPid:null;
 const ownership=!state.loaded?'unloaded':ownershipMatch===true?'matched':ownershipMatch===false?'mismatch':isActive?'unverified':'starting-or-unhealthy';
 return {...architecture,account:account.id,label:p.jobLabel,installed,loaded:state.loaded,jobPid:state.jobPid,daemonPid:localPid,daemonProcessLiveness:daemonProcessLiveness(account,options),daemonActive:isActive,ownership,ownershipMatch,plist:p.plist,logs:{stdout:p.stdout,stderr:p.stderr}};
}

/** Remove only the launchd registration and plist; account, profile and logs remain intact. */
export async function uninstall(account:Account,options:AutostartOptions={}){
 const architecture=requireSupport(options),p=paths(account,options),state=await loaded(account,options),run=launchctl(options),target=`${domain(options)}/${p.jobLabel}`;
 if(state.loaded){const removed=await run([launchctlPath(),'bootout',target]);if(!removed.ok)throw new Error('launchctl could not stop the ChatGPT autostart job.');}
 const disabled=await run([launchctlPath(),'disable',target]);
 if(!disabled.ok)throw new Error('launchctl could not disable the ChatGPT autostart job.');
 let removedPlist=false;if(existsSync(p.plist)){if(lstatSync(p.plist).isSymbolicLink())throw new Error('Autostart plist cannot be a symbolic link.');unlinkSync(p.plist);removedPlist=true;}
 return {...architecture,account:account.id,label:p.jobLabel,installed:false,loaded:false,removedPlist,preserved:{accountData:accountDir(account),profilePath:account.profilePath,logs:p.logs}};
}
