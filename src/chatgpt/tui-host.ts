import {watch} from 'node:fs';
import {mkdtemp,rm,readFile,realpath,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {join,resolve,basename,dirname} from 'node:path';
import {runTui as initialView,type TuiControl,type TuiOptions} from './tui.ts';
import {mockClient} from './tui-mock.ts';
import {loadTuiSession,saveTuiSession} from './tui-session.ts';

/** Validate a fresh bundled module before relinquishing the working view. */
export async function buildTuiRevision(entry:string,directory:string,revision:number){
 directory=await realpath(directory);
 const output=join(directory,'view-'+revision+'.mjs');
 const result=await Bun.build({entrypoints:[entry],target:'bun',format:'esm',outdir:directory,naming:'view-'+revision+'.mjs',packages:'external',plugins:[{name:'preserve-runtime-paths',setup(build){
  build.onLoad({filter:/\/tui[^/]*\.ts$/},async args=>({loader:'ts',contents:(await readFile(args.path,'utf8')).replace(/(\bfrom\s*)(['"])(\.[^'"]+)\2/g,(match,prefix,quote,specifier)=>(basename(specifier).startsWith('tui')||basename(specifier)==='slash.ts')?match:prefix+quote+resolve(dirname(args.path),specifier)+quote)}));
  build.onResolve({filter:/^\//},args=>(basename(args.path).startsWith('tui')||basename(args.path)==='slash.ts')?undefined:{path:args.path,external:true});
 }}]});
 if(!result.success)throw new Error(result.logs.map(log=>log.message).join('\n'));
 if(!await Bun.file(output).exists())throw new Error('Build produced no revision file: '+result.outputs.map(item=>item.path).join(', '));
 const module=await import(output);
 if(typeof module.runTui!=='function')throw new Error('Updated TUI has no runTui export.');
 return module.runTui as typeof initialView;
}

/** Stable terminal host. In-flight callbacks finish in their originating view. */
export async function runTui(accountId?:string,options:TuiOptions={}){
 const directory=await mkdtemp(join(tmpdir(),'chatgpt-tui-'));
 const entry=join(import.meta.dir,'tui.ts');
 let view=initialView,candidate:typeof initialView|undefined,control:TuiControl|undefined,closed=false,revision=0;
 let timer:ReturnType<typeof setTimeout>|undefined;
 let rebuilding=false,dirty=false;
 const fingerprint=async()=>{const names=(await readdir(import.meta.dir)).filter(name=>(name.startsWith('tui')||name==='slash.ts'||name==='freeze.ts')&&name.endsWith('.ts')&&!name.endsWith('.test.ts')).sort();const hash=createHash('sha256');for(const name of names){hash.update(name);hash.update(await readFile(join(import.meta.dir,name)));}return hash.digest('hex');};
 let observed=await fingerprint(),attempted=observed;
 const mockRpc=options.mock?(options.mockRpc||mockClient()):undefined;
 async function rebuild(){
  if(closed)return;if(rebuilding){dirty=true;return;}rebuilding=true;
  try{const current=await fingerprint();if(current===attempted)return;attempted=current;observed=current;const next=await buildTuiRevision(entry,directory,++revision);if(closed)return;candidate=next;control?.requestReload();}
  catch(error){control?.notice('Update rejected; current view retained · '+String((error as Error).message).split('\n')[0]);}
  finally{rebuilding=false;if(dirty){dirty=false;void rebuild();}}
 }
 const watcher=watch(import.meta.dir,{recursive:true},(_event,file)=>{
  if(!file||!String(file).endsWith('.ts')||String(file).includes('.test.'))return;
  clearTimeout(timer);timer=setTimeout(()=>void rebuild(),200);
 });
 const poll=setInterval(()=>{if(closed)return;void fingerprint().then(current=>{if(current!==observed){observed=current;void rebuild();}}).catch(()=>{});},750);
 let restore=options.restore||(!options.mock?loadTuiSession(accountId):undefined),restoreFromDisk=options.restoreFromDisk??(!!restore&&!options.restore);
 const checkpoint=(state:Record<string,any>)=>{try{if(!options.mock)saveTuiSession(state.a?.id||accountId,state);options.onCheckpoint?.(state);}catch(error){control?.notice('Session checkpoint failed · '+String((error as Error).message));}};
 try{
  while(!closed){
   const state=await view(accountId,{...options,restore,restoreFromDisk,mockRpc,onCheckpoint:checkpoint,onReady:next=>{control=next;options.onReady?.(next);if(candidate)next.requestReload();}});
   control=undefined;
   if(!state||!candidate)break;
   restore=state;restoreFromDisk=false;view=candidate;candidate=undefined;
  }
 }finally{closed=true;watcher.close();clearTimeout(timer);clearInterval(poll);await rm(directory,{recursive:true,force:true});}
}
