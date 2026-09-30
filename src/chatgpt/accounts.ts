import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

/** State root. `root()` re-reads the environment on every call so a test can isolate itself; `ROOT` stays for callers that captured it at import. */
export function root() { return process.env.CHATGPT_HOME || join(process.env.APIPLAN_HOME || join(homedir(), '.apiplan'), 'chatgpt'); }
export const ROOT = root();
/** A browser profile is the stable identity of an attached account; a CDP port is a volatile hint (the same 9223 is a different browser tomorrow). */
export type BrowserProfile = { browser?: string; profile?: string; userDataDir?: string };
/** The website identity last OBSERVED for an account, with when and from where. Never a credential. */
export type VerifiedIdentity = { userId: string; email?: string; name?: string; at: string; source: 'website session' | 'migrated' | 'adopt' | string };
export type Account = { id: string; label: string; baseURL: string; browserPath?: string; profilePath?: string; cdpURL?: string; transportMode?:'attached'|'managed'; headless?:boolean; workspace?: string; userId?: string; email?: string; created: string; source?: {provider:'managed'|'browser'|'accounttracker'|'apiplan'; reference?:string}; browserProfile?: BrowserProfile; lastVerified?: VerifiedIdentity; archived?: boolean };
export const CONFIG_VERSION = 2;
export type Config = { version: number; selected: string; selectedAt?: string; accounts: Account[] };
export function privateDir(path: string) { const existed=existsSync(path);mkdirSync(path,{recursive:true,mode:0o700});if(!existed)chmodSync(path,0o700);return path; }
export function atomicJSON(path: string, value: unknown) { privateDir(resolve(path,'..'));const tmp=path+'.'+process.pid+'.'+randomUUID()+'.tmp';try{writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});chmodSync(tmp,0o600);renameSync(tmp,path);chmodSync(path,0o600);}finally{try{unlinkSync(tmp);}catch{}} }
export function readJSON<T>(path: string, fallback: T): T { try{return JSON.parse(readFileSync(path,'utf8'));}catch{return fallback;} }
export function validId(id: string) { if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new Error('Account id must use 1–64 letters, numbers, underscores or hyphens.'); return id; }
export function configFile() { return join(root(),'accounts.json'); }
function defaultConfig(): Config { return {version:CONFIG_VERSION,selected:'default',accounts:[{id:'default',label:'Current ChatGPT',baseURL:'https://chatgpt.com',created:new Date().toISOString(),source:{provider:'managed'},archived:false}]}; }
/**
 * v1 → v2 in memory only; the file is rewritten as v2 on the next `saveAccount`.
 * A file from a NEWER build fails closed with a named code, the way gateway.json already does:
 * guessing at fields we do not understand is how one account's wiring silently becomes another's.
 */
export function migrateConfig(raw: any): Config {
 if(!raw||typeof raw!=='object'||!Array.isArray(raw.accounts)) return defaultConfig();
 const version=typeof raw.version==='number'?raw.version:1;
 if(version>CONFIG_VERSION){const e:any=new Error(`accounts.json was written by a newer build (version ${version}); this build understands version ${CONFIG_VERSION}. Refusing to read it; nothing was written.`);e.code='ACCOUNTS_CONFIG_VERSION';throw e;}
 return {version:CONFIG_VERSION,selected:String(raw.selected||'default'),...(raw.selectedAt?{selectedAt:String(raw.selectedAt)}:{}),accounts:raw.accounts.map((a:any)=>({...a,archived:a.archived===true}))};
}
export function config(): Config { const path=configFile(); if(!existsSync(path)) return defaultConfig(); let raw:any; try{raw=JSON.parse(readFileSync(path,'utf8'));}catch{return defaultConfig();} return migrateConfig(raw); }
export function account(id?: string): Account { const c=config(); const a=c.accounts.find(a=>a.id===(id||process.env.CHATGPT_ACCOUNT||c.selected)); if(!a) throw new Error('Unknown account. Run chatgpt accounts list.'); return a; }
export function accountDir(a: Account) { return privateDir(join(root(),'accounts',validId(a.id))); }
/** Path of an account directory without creating it — for read-only inspection of accounts that may not exist. */
export function accountDirPath(id: string) { return join(root(),'accounts',validId(id)); }
export function saveAccount(a: Account, select=false) { validId(a.id); const u=new URL(a.baseURL); if(u.origin!=='https://chatgpt.com' && !['localhost','127.0.0.1'].includes(u.hostname)) throw new Error('Account base URL must be ChatGPT or a local test server.'); const c=config(); c.accounts=c.accounts.filter(x=>x.id!==a.id);c.accounts.push(a);if(select){c.selected=a.id;c.selectedAt=new Date().toISOString();}atomicJSON(configFile(),c); }
export function selectAccount(id: string) { const a=account(id);const c=config();c.selected=a.id;c.selectedAt=new Date().toISOString();atomicJSON(configFile(),c);return a; }

/**
 * Per-account identity record, kept OUTSIDE index.sqlite so listing state is cheap and never opens
 * the index (which creates -wal/-shm and may be mid-write in the daemon). Named account-identity.json,
 * not identity.json: harness-web.ts already owns an identity.json inside its own directory.
 */
export type AccountIdentityFile = { schema: 1; userId: string; email?: string; name?: string; at: string; source: string };
export function accountIdentityFile(a: Account|string) { return join(typeof a==='string'?accountDirPath(a):accountDirPath(a.id),'account-identity.json'); }
export function readAccountIdentity(a: Account|string): AccountIdentityFile|undefined { const v=readJSON<any>(accountIdentityFile(a),null); return v&&typeof v.userId==='string'&&v.userId?{schema:1,userId:v.userId,...(v.email?{email:v.email}:{}),...(v.name?{name:v.name}:{}),at:String(v.at||''),source:String(v.source||'unknown')}:undefined; }
/** Write the identity record. Callers must decide adoption is allowed FIRST (see account-switch.canAdopt); this is storage, not policy. */
export function writeAccountIdentity(a: Account, identity: {userId:string;email?:string;name?:string}, source='website session'): AccountIdentityFile { const value:AccountIdentityFile={schema:1,userId:identity.userId,...(identity.email?{email:identity.email}:{}),...(identity.name?{name:identity.name}:{}),at:new Date().toISOString(),source}; atomicJSON(accountIdentityFile(a),value); return value; }
/** Every account whose RECORDED identity is this website user. Archived accounts are excluded unless asked for: a forgotten account must not silently win a switch. */
export function accountsForUser(userId: string, opts: {includeArchived?: boolean; accounts?: Account[]} = {}): Account[] { if(!userId) return []; const list=opts.accounts??config().accounts; return list.filter(a=>(opts.includeArchived||a.archived!==true)&&(a.userId===userId||a.lastVerified?.userId===userId||readAccountIdentity(a)?.userId===userId)); }
/** Directories under $ROOT/accounts with no entry in accounts.json — reported, never deleted. */
export function orphanAccountDirs(): string[] { const base=join(root(),'accounts'); if(!existsSync(base)) return []; const known=new Set(config().accounts.map(a=>a.id)); return readdirSync(base).filter(name=>{try{return statSync(join(base,name)).isDirectory()&&!known.has(name);}catch{return false;}}).sort(); }

/** Browser adapters supply a profile or a CDP endpoint, never a Codex/API token. */
export function installedBrowsers() {
 const paths=process.platform==='darwin' ? [
  ['chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['arc','/Applications/Arc.app/Contents/MacOS/Arc'],
  ['edge','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['brave','/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  ['chromium','/Applications/Chromium.app/Contents/MacOS/Chromium'],
 ] : process.platform==='win32' ? [
  ['chrome',join(process.env.PROGRAMFILES||'C:\\Program Files','Google/Chrome/Application/chrome.exe')],
  ['edge',join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Microsoft/Edge/Application/msedge.exe')],
 ] : [['chrome','/usr/bin/google-chrome'],['chromium','/usr/bin/chromium'],['chromium-browser','/usr/bin/chromium-browser'],['brave','/usr/bin/brave-browser']];
 return paths.filter(([,path])=>existsSync(path)).map(([id,path])=>({id,path,transport:'cdp',managed:true,attach:'requires existing loopback debugging endpoint'}));
}
