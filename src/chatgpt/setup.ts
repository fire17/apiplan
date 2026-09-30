import {join,resolve} from 'node:path';
import {existsSync,readFileSync,statSync,lstatSync,realpathSync,unlinkSync} from 'node:fs';
import {ROOT,privateDir,account,installedBrowsers} from './accounts.ts';
import {writeShim,shadowsExisting,isOurShim,IS_WIN} from '../platform.ts';
import {load,binDirOf,runnerOf} from '../commands.ts';
const runtime=()=>join(ROOT,'runtime');
const pythonPath=()=>process.env.CHATGPT_PYTHON||join(runtime(),IS_WIN?'Scripts/python.exe':'bin/python');
const requirement=()=>readFileSync(join(import.meta.dir,'requirements.txt'),'utf8').trim();
async function command(argv:string[],timeout=120000){const child=Bun.spawn(argv,{stdin:'ignore',stdout:'pipe',stderr:'pipe'});const timer=setTimeout(()=>child.kill(),timeout);try{const [output,,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {ok:code===0,output};}finally{clearTimeout(timer);}}
export async function setup(options:{pythonVersion?:string}={}){
 const uv=Bun.which('uv');if(!uv)throw new Error('uv is required to install the isolated browser runtime. Install uv, then run chatgpt setup.');
 const pinned=requirement();if(!/^nodriver==[0-9]+\.[0-9]+\.[0-9]+$/.test(pinned))throw new Error('Browser runtime requirements must contain an exact nodriver pin.');
 privateDir(ROOT);const target=runtime();const python=join(target,IS_WIN?'Scripts/python.exe':'bin/python');
 if(!existsSync(python)){const result=await command([uv,'venv','--python',options.pythonVersion||'3.12',target]);if(!result.ok)throw new Error('uv could not create the isolated Python runtime. Check uv and Python availability.');}
 privateDir(target);const installed=await command([uv,'pip','install','--python',python,'-r',join(import.meta.dir,'requirements.txt')]);if(!installed.ok)throw new Error('uv could not install the pinned browser dependencies. Check package connectivity and run setup again.');
 const probe=await command([python,'-c','import nodriver; import importlib.metadata; print(importlib.metadata.version("nodriver"))'],10000);
 if(!probe.ok||probe.output.trim()!==pinned.split('==')[1])throw new Error('Installed nodriver version does not match the pinned runtime.');
 return {runtime:target,python,nodriver:probe.output.trim(),ready:true,...(process.env.CHATGPT_PYTHON?{note:'CHATGPT_PYTHON overrides the managed runtime; doctor checks that selected interpreter.'}:{})};
}
export async function doctor(options:{account?:string}={}){
 const checks:{name:string;ok:boolean;detail:string}[]=[];const python=pythonPath();
 checks.push({name:'bun',ok:!!Bun.version,detail:'Bun '+Bun.version});
 checks.push({name:'uv',ok:!!Bun.which('uv'),detail:Bun.which('uv')?'Available for setup.':'Not found; required for setup, not for an already installed runtime.'});
 let runtimeOK=false;
 if(existsSync(python)){const probe=await command([python,'-c','import nodriver; import importlib.metadata; print(importlib.metadata.version("nodriver"))'],10000);runtimeOK=probe.ok&&'nodriver=='+probe.output.trim()===requirement();checks.push({name:'runtime',ok:runtimeOK,detail:runtimeOK?'Pinned nodriver runtime is importable.':'Runtime is unavailable or has a different nodriver version; run setup.'});}
 else checks.push({name:'runtime',ok:false,detail:'Python runtime missing; run chatgpt setup.'});
 const a=account(options.account);const browsers=installedBrowsers();let browserOK=false;
 if(a.cdpURL){try{const u=new URL(a.cdpURL);const safe=['localhost','127.0.0.1','::1','[::1]'].includes(u.hostname)&&['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;browserOK=safe;if(safe){try{browserOK=(await fetch(new URL('/json/version',u.origin),{signal:AbortSignal.timeout(1500)})).ok;}catch{browserOK=false;}}}catch{}checks.push({name:'browser',ok:browserOK,detail:browserOK?'Configured loopback browser debugging endpoint responds.':'Configured browser debugging endpoint is unavailable or invalid.'});}
 else{browserOK=a.browserPath?existsSync(a.browserPath):browsers.length>0;checks.push({name:'browser',ok:browserOK,detail:browserOK?'Managed Chromium executable found.':'No supported Chromium browser found; configure --browser or attach a loopback CDP endpoint.'});}
 checks.push({name:'account',ok:true,detail:'Isolated account configuration selected. Website authentication is checked only by chatgpt status/login.'});
 return {ok:runtimeOK&&browserOK,checks,account:{id:a.id,source:a.source?.provider||'managed',transport:a.cdpURL?'attached-cdp':'managed',identityBound:!!a.userId}};
}
export function install(options:{binDir?:string}={}){
 const config=load(),binDir=resolve(options.binDir||binDirOf(config)),runner=runnerOf(config),entry=resolve(import.meta.dir,'../../bin/chatgpt.ts');
 const clash=shadowsExisting('chatgpt',binDir);if(clash)throw new Error('An unrelated chatgpt command already exists on PATH; select a different installation directory.');
 for(const name of IS_WIN?['chatgpt','chatgpt.cmd','chatgpt.ps1']:['chatgpt']){const target=join(binDir,name);let link=false;try{link=lstatSync(target).isSymbolicLink();}catch{}if(link){if(!existsSync(target)||realpathSync(target)!==realpathSync(entry))throw new Error('Refusing to replace an unrelated chatgpt command symlink.');unlinkSync(target);}else if(existsSync(target)&&!isOurShim(target)&&(statSync(target).size>4096||!readFileSync(target,'utf8').includes(entry)))throw new Error('Refusing to replace an unrelated chatgpt command in the installation directory.');}
 const written=writeShim(binDir,'chatgpt',runner,entry,[]);return {binDir,written,onPath:(process.env.PATH||'').split(IS_WIN?';':':').includes(binDir)};
}
