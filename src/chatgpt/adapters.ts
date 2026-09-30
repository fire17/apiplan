import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {ROOT,atomicJSON} from './accounts.ts';

export type Adapter={version:string;routes:Record<string,string>;selectors:Record<string,string[]>;labels:Record<string,string[]>};
export const BUILTIN:Adapter={version:'2026-09-15.2',routes:{
 conversations:'/backend-api/conversations',conversation:'/backend-api/conversation/{id}',
 projects:'/backend-api/gizmos/snorlax/sidebar?owned_only=false&conversations_per_gizmo=5&limit=20',
 project:'/backend-api/gizmos/{id}',projectChats:'/backend-api/gizmos/{id}/conversations',
 gpts:'/backend-api/gizmos/bootstrap?limit=20',models:'/backend-api/models',voices:'/backend-api/settings/voices',
 account:'/backend-api/accounts/check/v4-2023-04-27',features:'/backend-api/accounts/optimized/check',
 settings:'/backend-api/settings/user',instructions:'/backend-api/user_system_messages',
 tasks:'/backend-api/tasks',plugins:'/backend-api/hazelnuts?include_permissions=true&scope=installed',
 connectors:'/backend-api/aip/connectors/links/list_accessible',pins:'/backend-api/pins',
 invoices:'/backend-api/payments/transaction-history',
 },selectors:{composer:['#prompt-textarea','#mobile-composer-prompt','[contenteditable=true][role=textbox]'],send:['[data-testid=send-button]'],stop:['[data-testid=stop-button]'],profile:['[data-testid=accounts-profile-button]'],upload:['input[type=file]'],message:['[data-message-id]']},labels:{settings:['Settings'],voice:['Start Voice','Start voice mode'],dictation:['Start dictation'],branch:['Branch in new chat'],regenerate:['Try again','Regenerate response'],export:['Export data'],exportConfirm:['Confirm export']}};
type AdapterSection='routes'|'selectors'|'labels';
type SectionDiff={added:string[];removed:string[];changed:string[]};
type LoadDiagnostic={ok:boolean;source:'builtin'|'current'|'last-good';active:string;signature:string;rejectedSignature?:string;error?:string};
const REQUIRED:Record<AdapterSection,string[]>={routes:Object.keys(BUILTIN.routes),selectors:Object.keys(BUILTIN.selectors),labels:Object.keys(BUILTIN.labels)};
const currentPath=()=>join(ROOT,'adapters/current.json');
const historyDir=()=>join(ROOT,'adapters/history');
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const serialized=(value:Adapter)=>JSON.stringify(value,null,2)+'\n';
const safeVersion=(version:string)=>version.replace(/[^\w.-]/g,'_');
const isRecord=(value:any)=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function validateAdapter(a:any):asserts a is Adapter{
 if(!isRecord(a)||typeof a.version!=='string'||!a.version.trim()||a.version.length>200||!isRecord(a.routes)||!isRecord(a.selectors)||!isRecord(a.labels))throw new Error('Adapter needs a non-empty version plus route, selector and label tables.');
 for(const key of REQUIRED.routes)if(!Object.hasOwn(a.routes,key))throw new Error('Adapter missing required route: '+key);
 for(const [key,value]of Object.entries(a.routes))if(typeof value!=='string'||!value.startsWith('/backend-api/')||value.startsWith('//')||value.includes('..')||value.includes('://')||/[\r\n]/.test(value))throw new Error('Unsafe adapter route: '+key);
 for(const field of ['selectors','labels']as const){
  for(const key of REQUIRED[field])if(!Object.hasOwn(a[field],key))throw new Error(`Adapter missing required ${field.slice(0,-1)}: ${key}`);
  for(const [key,value]of Object.entries(a[field]))if(!Array.isArray(value)||!value.length||value.some(item=>typeof item!=='string'||!item.trim()||item.length>2000))throw new Error(`Invalid adapter ${field}.${key}`);
 }
}

export function adapterSignature(value:Adapter){validateAdapter(value);return digest(serialized(value));}
export function adapterDiff(before:Adapter,after:Adapter){
 const section=(name:AdapterSection):SectionDiff=>{
  const left=before[name],right=after[name],leftKeys=Object.keys(left),rightKeys=Object.keys(right);
  return {added:rightKeys.filter(key=>!(key in left)).sort(),removed:leftKeys.filter(key=>!(key in right)).sort(),changed:rightKeys.filter(key=>key in left&&JSON.stringify(left[key])!==JSON.stringify(right[key])).sort()};
 };
 return {version:{from:before.version,to:after.version},routes:section('routes'),selectors:section('selectors'),labels:section('labels')};
}

let lastGood=BUILTIN;
let acceptedSignature=adapterSignature(BUILTIN);
let observedFileSignature:string|undefined;
let diagnostic:LoadDiagnostic={ok:true,source:'builtin',active:BUILTIN.version,signature:acceptedSignature};

/** Read at each operation boundary; cache identical bytes and retain the last valid revision. */
export function adapter():Adapter{
 const path=currentPath();
 if(!existsSync(path))return lastGood;
 let text:string,fileSignature:string;
 try{text=readFileSync(path,'utf8');fileSignature=digest(text);}catch(error:any){diagnostic={ok:false,source:'last-good',active:lastGood.version,signature:acceptedSignature,error:String(error?.message||error)};return lastGood;}
 if(fileSignature===observedFileSignature)return lastGood;
 observedFileSignature=fileSignature;
 try{
  const candidate=JSON.parse(text);validateAdapter(candidate);
  lastGood=candidate;acceptedSignature=adapterSignature(candidate);
  diagnostic={ok:true,source:'current',active:candidate.version,signature:acceptedSignature};
 }catch(error:any){diagnostic={ok:false,source:'last-good',active:lastGood.version,signature:acceptedSignature,rejectedSignature:fileSignature,error:String(error?.message||error)};}
 return lastGood;
}

export function adapterDiagnostic(){adapter();return {...diagnostic};}

export function promoteAdapter(a:any,options:{reason?:'promotion'|'rollback'}={}){
 validateAdapter(a);
 const old=adapter(),previousSignature=adapterSignature(old),signature=adapterSignature(a),diff=adapterDiff(old,a);
 const historyPath=join(historyDir(),`${safeVersion(old.version)}--${previousSignature.slice(0,12)}.json`);
 atomicJSON(historyPath,old);
 atomicJSON(currentPath(),a);
 observedFileSignature=undefined;
 const active=adapter();
 if(active.version!==a.version||adapterSignature(active)!==signature)throw new Error('Adapter promotion could not be read back exactly.');
 return {active:a.version,previous:old.version,hotloaded:true,signature,previousSignature,historyPath,diff,validation:{structural:true,behaviorallyTested:false},reason:options.reason||'promotion'};
}

export function rollbackAdapter(version:string){
 const candidates=existsSync(historyDir())?readdirSync(historyDir()).filter(name=>name.endsWith('.json')).map(name=>join(historyDir(),name)):[];
 const matches=candidates.map(path=>{try{const value=JSON.parse(readFileSync(path,'utf8'));validateAdapter(value);return value.version===version?{path,value,mtime:statSync(path).mtimeMs}:null;}catch{return null;}}).filter((entry):entry is {path:string;value:Adapter;mtime:number}=>entry!==null).sort((a,b)=>b.mtime-a.mtime);
 if(!matches.length)throw new Error('Adapter history does not contain version '+version);
 return promoteAdapter(matches[0].value,{reason:'rollback'});
}

export function route(name:string,id?:string){const path=adapter().routes[name];if(!path)throw new Error('Adapter missing route '+name);return path.replace('{id}',encodeURIComponent(id||''));}
