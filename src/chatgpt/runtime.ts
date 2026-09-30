import {statSync} from 'node:fs';
import {join} from 'node:path';

export function runtimeRevision(){return ['fresh.ts','service.ts','actions.ts','browser.py','asset_stream.py','settings-map.ts'].map(file=>file+':'+statSync(join(import.meta.dir,file)).mtimeMs).join('|');}
/** Promote one revision at an operation boundary; retain working code on failure. */
export class RuntimeGate {
 private attempted:string;
 private pending?:Promise<void>;
 constructor(initial:string,private reload:()=>Promise<unknown>,private report:(event:any)=>void){this.attempted=initial;}
 async check(revision:string){
  if(this.pending)await this.pending;
  if(revision===this.attempted)return;
  this.attempted=revision;
  const task=(async()=>{try{await this.reload();this.report({type:'runtime.reloaded'});}catch(error:any){this.report({type:'runtime.rejected',reason:'Revision failed to load; previous working runtime retained.',detail:error});}})();
  this.pending=task;
  try{await task;}finally{if(this.pending===task)this.pending=undefined;}
 }
}
