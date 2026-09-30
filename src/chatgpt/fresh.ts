import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
const harnessModules=['harness-run','harness-web','conversation-harness','harness-protocol','harness-verify'] as const;
const harnessSet=new Set<string>(harnessModules);
const onlineModules=['online-runtime','online-wire'] as const;
const onlineSet=new Set<string>(onlineModules);
const allowed=new Set(['media','takeout','voice','actions','service','settings','settings-map','flows','gpts','conversation-actions','receipts','online-receipts','model-controls','thinking','work-usage','audio-capture','takeout-supervisor','store','message-queue','capabilities','observed-history','account-tasks',...harnessModules,...onlineModules]);
/** Every harness module shares one content revision, so dependency edits load as one consistent graph. */
export function freshRevision(name:string,directory:string=import.meta.dir){
 if(!allowed.has(name))throw new Error('Unsupported runtime module.');
 if(onlineSet.has(name)){const hash=createHash('sha256');for(const module of [...onlineModules,...harnessModules]){hash.update(module+'\0');hash.update(readFileSync(join(directory,module+'.ts')));hash.update('\0');}return 'online-'+hash.digest('hex');}
 if(!harnessSet.has(name))return String(statSync(join(directory,name+'.ts')).mtimeMs);
 const hash=createHash('sha256');for(const module of harnessModules){hash.update(module+'\0');hash.update(readFileSync(join(directory,module+'.ts')));hash.update('\0');}return 'harness-'+hash.digest('hex');
}
/** Stable revision URLs reload changed flow code without recompiling unchanged modules. */
export async function fresh(name:string,revision?:string):Promise<any>{if(!allowed.has(name))throw new Error('Unsupported runtime module.');const path=join(import.meta.dir,name+'.ts');return import(path+'?revision='+encodeURIComponent(revision??freshRevision(name)));}
