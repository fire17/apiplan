import {join} from 'node:path';
import {ROOT,validId,root} from './accounts.ts';
import {ALLOW_WHILE_FROZEN,FREEZE_CODE,FROZEN_ALLOWED_OPS} from './freeze.ts';

/**
 * Gateway POLICY ENGINE — pure, offline, side-effect free.
 *
 * What this module is for: the traffic protocol (what may be sent, how fast, how many at once, what
 * needs an explicit acknowledgement) must be changeable by editing JSON, not TypeScript. This file
 * owns that JSON: its schema, its validation, its versioning, and the resolution of one call into a
 * DECISION. It never acts on a decision. It opens no browser, sends no request, starts no timer,
 * writes no file, and reads no file by itself — the config arrives through an injected reader, so a
 * test needs no filesystem and a caller can cache bytes however it likes.
 *
 * Born from 2026-09-15 19:51 ("STOP EVERYTHING IMMEDIATELY"): a bulk archive crawl drew five 429s on
 * /backend-api/conversation/{id} because pacing lived inline in service.ts with no single place to
 * change or stop it. Policy here is DATA; src/chatgpt/gateway.ts enforces it; transport.ts keeps its
 * own freeze gate underneath as the last line of defence.
 *
 * Fail-closed contract (docs: .deify/chatgpt-cli/gateway/design-policy.md §5):
 *  - config MISSING      -> BUILTIN_GATEWAY, which equals today's hardcoded numbers exactly, so
 *                           installing this changes no traffic until the owner writes the file.
 *  - config MALFORMED    -> refuse every site-bound op (GATEWAY_CONFIG_INVALID). Local reads,
 *                           freeze.set/freeze.status and the reduce-activity stop class still run.
 *  - config version NEWER-> refuse the same way (GATEWAY_CONFIG_VERSION_UNSUPPORTED). An old binary
 *                           cannot know that a new field TIGHTENS a limit; ignoring a tightening is
 *                           the dangerous direction.
 */

/** Bumped only when an OLD binary would MISREAD a NEW file. Adding an optional field does not bump it. */
export const GATEWAY_CONFIG_VERSION=1 as const;

export const GATEWAY_INVALID_CODE='GATEWAY_CONFIG_INVALID';
export const GATEWAY_VERSION_CODE='GATEWAY_CONFIG_VERSION_UNSUPPORTED';
export const GATEWAY_FORBIDDEN_CODE='GATEWAY_FORBIDDEN';
export const GATEWAY_ACK_CODE='GATEWAY_ACK_REQUIRED';

/** Traffic class. Policy is written per kind, so a NEW operation name inherits pacing with no edit. */
export type OperationKind='read'|'write'|'generation'|'bulk';
export const OPERATION_KINDS:readonly OperationKind[]=['read','write','generation','bulk'];
/** allow = runs subject to limits; acknowledge = runs only with the caller's explicit key; forbid = never. */
export type Permission='allow'|'acknowledge'|'forbid';
/** 'service' ops are the `op` strings of service.ts execute(); 'worker' ops are BrowserWorker call names. */
export type PolicyLayer='service'|'worker';

export interface RateLimit{minSpacingMs:number;maxRequests?:number;intervalMs?:number;burst?:number}
export interface ConcurrencyLimits{global:number;perScope?:Record<string,number>;generation:number}
export interface ScopeTemplate{template:string;scope?:string}
export interface BackoffPolicy{
 baseMs:number;factor:number;maxExponent:number;ceilingMs:number;
 retryAfter:'max'|'site';retryAfterCeilingMs:number;recoveryMs:number;
 /** write/generation MUST stay 0: docs/CHATGPT-ORACLE.md forbids blind write replay and an unknown
  *  outcome blocks it. Validation rejects anything else. */
 maxRetriesByKind:Record<OperationKind,number>;
}
export interface FreezePolicy{
 /** MUST be a subset of FROZEN_ALLOWED_OPS (src/chatgpt/freeze.ts). Config may only SUBTRACT: the
  *  allowlist is decided by what an operation PERMITS, and a JSON file is caller-supplied data.
  *  Letting data ADD an op is exactly what the unforgeable Symbol exists to prevent. */
 allowOps:string[];
 /** Whether the in-process ALLOW_WHILE_FROZEN Symbol still passes. No setting makes it forgeable. */
 honorCapability:boolean;
 /** Local, non-site ops that keep working while frozen. Subset of LOCAL_OPERATIONS only. */
 localOps?:string[];
}
export interface OperationPolicy{
 kind?:OperationKind;permission:Permission;
 acknowledgeKey?:string;acknowledgeFlag?:string;
 /** 'non-get' reproduces service.ts api.request exactly: only a non-GET method needs the key. */
 acknowledgeWhen?:'always'|'non-get';
 timeoutMs?:number;rate?:Partial<RateLimit>;
}
export interface Policy{
 concurrency:ConcurrencyLimits;
 /** Per normalised scope. Key '*' is the fallback for any scope not listed. */
 scopes:Record<string,RateLimit>;
 /** Per kind, applied IN ADDITION to the scope limit; the stricter of the two wins. */
 kinds:Record<OperationKind,RateLimit>;
 operations:Record<string,OperationPolicy>;
 /** 'allow' is rejected by validation: an unknown op must never be freely reachable. */
 unknownOperation:'forbid'|'acknowledge';
 backoff:BackoffPolicy;
 freeze:FreezePolicy;
 /** Evaluated before everything except the reduce-activity floor. '*' matches every site-bound op. */
 forbid?:string[];
}
export interface GatewayConfigFile{
 version:number;activeProfile:string;
 classify?:Record<string,OperationKind>;
 /** Prefix rules, longest prefix first, so a new op name inherits a kind automatically. */
 kindRules?:Record<string,OperationKind>;
 scopeTemplates?:ScopeTemplate[];
 defaults:Policy;profiles:Record<string,DeepPartial<Policy>>;note?:string;
}
export type DeepPartial<T>={[K in keyof T]?:T[K] extends object?DeepPartial<T[K]>:T[K]};

/**
 * Local ops that need no browser and make no site traffic: service.ts execute()'s no-start set
 * (which is DIRECT_READ_OPERATIONS plus the local controls). Restated here rather than imported
 * because importing service.ts would create a cycle once the gateway is wired into it — the
 * divergence is pinned by a test that parses service.ts and fails the moment the two differ.
 */
export const LOCAL_OPERATIONS:ReadonlySet<string>=new Set(['online.list','online.status','receipts.list','receipts.get','runtime.reload','conversations.cached','conversations.search','takeout.status','takeout.pause','takeout.resume','takeout.audit','takeout.watch','takeout.watch-status','takeout.unwatch','flow.validate','flow.status','capabilities.list','map.capabilities','adapter.get','adapter.validate','adapter.promote','adapter.rollback','monitor.events','monitor.watch','invoices.watcher','invoices.watch','invoices.unwatch','freeze.set','freeze.status']);
/** service.ts allows `status` while frozen without starting the browser; keep that carve-out. */
export const FROZEN_SERVICE_OPS:ReadonlySet<string>=new Set(['status']);
export const isLocalOperation=(op:string)=>LOCAL_OPERATIONS.has(op);

const MAX_DURATION_MS=86400000;
const CEILING_WITHOUT_NOTE_MS=900000;

/** Prefix rules. Longest match wins, so 'audio.output.' beats 'audio.'. */
const BUILTIN_KIND_RULES:Record<string,OperationKind>={
 'account.':'read','adapter.':'read','audio.':'read','audio.output.':'read','browser.':'write',
 'capabilities.':'read','chat.':'generation','connectors.':'read','conversations.':'read',
 'dictation.':'write','features.':'read','flow.':'read','freeze.':'read','gpts.':'read',
 'harness.':'read','invoices.':'read','map.':'read','media.':'read','models.':'read',
 'monitor.':'read','online.':'read','pins.':'read','plugins.':'read','projects.':'read',
 'queue.':'write','receipts.':'read','runtime.':'read','settings.':'read','surface.':'write',
 'takeout.':'bulk','tasks.':'read','thinking.':'write','ui.':'write','voice.':'write','voices.':'read',
};
/** Exact overrides. Sources: receipts.ts journal set = account-changing (write); ops that loop
 *  request() many times = bulk; ops that wait on a model answer = generation; the rest observe. */
const BUILTIN_CLASSIFY:Record<string,OperationKind>={
 'api.request':'write','status':'read',
 'adapter.promote':'write','adapter.rollback':'write',
 'audio.input':'write','audio.play':'write','audio.clear':'write',
 'chat.stop':'read','chat.mode':'write','chat.model':'write','chat.effort':'write','chat.reconcile':'read',
 'conversations.open':'write','conversations.rename':'write','conversations.pin':'write','conversations.unpin':'write',
 'conversations.archive':'write','conversations.unarchive':'write','conversations.share':'write','conversations.unshare':'write',
 'conversations.export':'bulk','dictation.controls':'read','flow.run':'bulk','gpts.bootstrap':'bulk',
 'harness.run':'bulk','harness.test':'bulk',
 'invoices.download':'write','invoices.sync':'bulk','invoices.watch':'write','invoices.unwatch':'write',
 'media.export':'bulk','monitor.watch':'read',
 'queue.list':'read','queue.status':'read','queue.run':'generation','queue.retry':'generation',
 'settings.set':'write','settings.open':'write',
 'takeout.pause':'write','takeout.resume':'write','takeout.watch':'write','takeout.unwatch':'write',
 'takeout.status':'read','takeout.audit':'read','takeout.watch-status':'read',
 'ui.inspect':'read','ui.snapshot':'read','ui.screenshot':'read','ui.text':'read',
 'voice.controls':'read',
};

/**
 * The compiled-in default. Every number here is today's hardcoded value, so a machine with no
 * gateway.json behaves byte-identically to the code shipped before this module existed.
 *
 * Note `kinds`: today pacing is decided by PATH only (service.ts: 5000 on /backend-api/conversation/,
 * 1000 otherwise). There is no per-kind spacing in the code, so every kind carries minSpacingMs 0
 * here — a kind limit of 0 adds no constraint. Per-kind pacing belongs to a profile the owner opts
 * into (see `conservative`), never to the default, because the default must reproduce, not improve.
 */
export const BUILTIN_GATEWAY:GatewayConfigFile=Object.freeze({
 version:GATEWAY_CONFIG_VERSION,
 activeProfile:'normal',
 kindRules:BUILTIN_KIND_RULES,
 classify:BUILTIN_CLASSIFY,
 scopeTemplates:[{template:'/backend-api/conversation/{id}'},{template:'/backend-api/conversations'},{template:'/backend-api/gizmos/{id}'},{template:'/backend-api/gizmos/{id}/conversations'}],
 defaults:{
  concurrency:{global:1,generation:1},
  scopes:{'/backend-api/conversation/{id}':{minSpacingMs:5000,burst:0},'*':{minSpacingMs:1000,burst:0}},
  kinds:{read:{minSpacingMs:0},write:{minSpacingMs:0},generation:{minSpacingMs:0},bulk:{minSpacingMs:0}},
  operations:{
   'api.request':{kind:'write',permission:'acknowledge',acknowledgeKey:'allowWrite',acknowledgeFlag:'--allow-write',acknowledgeWhen:'non-get',timeoutMs:45000},
   'chat.send':{kind:'generation',permission:'allow',timeoutMs:600000},
   'chat.new':{kind:'generation',permission:'allow',timeoutMs:600000},
   'chat.edit':{kind:'generation',permission:'allow',timeoutMs:600000},
   'chat.branch':{kind:'generation',permission:'allow',timeoutMs:600000},
   'chat.regenerate':{kind:'generation',permission:'allow',timeoutMs:600000},
   'media.download':{kind:'read',permission:'allow',timeoutMs:600000},
   'media.export':{kind:'bulk',permission:'allow',timeoutMs:600000},
  },
  unknownOperation:'forbid',
  backoff:{baseMs:60000,factor:2,maxExponent:4,ceilingMs:900000,retryAfter:'max',retryAfterCeilingMs:900000,recoveryMs:900000,maxRetriesByKind:{read:0,write:0,generation:0,bulk:0}},
  freeze:{allowOps:[...FROZEN_ALLOWED_OPS],honorCapability:true,localOps:[...LOCAL_OPERATIONS]},
 },
 profiles:{normal:{}},
 note:'Built-in default: mirrors src/chatgpt/service.ts as of 2026-09-16. No file is written for this.',
} as GatewayConfigFile);

/** Default worker call timeout (src/chatgpt/transport.ts). */
export const DEFAULT_TIMEOUT_MS=45000;

/* ------------------------------------------------------------------ validation */

const isRecord=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const isDuration=(v:any)=>typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=MAX_DURATION_MS;
const isStringArray=(v:any)=>Array.isArray(v)&&v.every(x=>typeof x==='string'&&x.length>0);

export type ConfigFault={code:typeof GATEWAY_INVALID_CODE|typeof GATEWAY_VERSION_CODE;field:string;message:string;action:string};
export type ValidationResult={ok:true;config:GatewayConfigFile}|{ok:false;fault:ConfigFault};

const fault=(field:string,message:string,code:ConfigFault['code']=GATEWAY_INVALID_CODE,action='Fix the field named above, then re-check with chatgpt gateway validate. No site traffic runs until the file is valid.'):ValidationResult=>({ok:false,fault:{code,field,message,action}});

/** Same path shape rule as the adapter route table: no regex, no traversal, no scheme, no CR/LF. */
export function isSafeTemplate(template:string){
 return typeof template==='string'&&template.startsWith('/backend-api/')&&!template.startsWith('//')&&!template.includes('..')&&!template.includes('://')&&!/[\r\n]/.test(template);
}

function validateRate(rate:any,field:string):ValidationResult|null{
 if(!isRecord(rate))return fault(field,`${field} must be an object.`);
 if(!isDuration(rate.minSpacingMs))return fault(`${field}.minSpacingMs`,`${field}.minSpacingMs must be an integer between 0 and ${MAX_DURATION_MS}.`);
 if(rate.intervalMs!==undefined&&!isDuration(rate.intervalMs))return fault(`${field}.intervalMs`,`${field}.intervalMs must be an integer between 0 and ${MAX_DURATION_MS}.`);
 if(rate.maxRequests!==undefined&&(!Number.isInteger(rate.maxRequests)||rate.maxRequests<0))return fault(`${field}.maxRequests`,`${field}.maxRequests must be an integer of 0 or more.`);
 if((rate.maxRequests===undefined)!==(rate.intervalMs===undefined))return fault(`${field}.maxRequests`,`${field} needs maxRequests and intervalMs together, or neither.`);
 if(rate.burst!==undefined&&(!Number.isInteger(rate.burst)||rate.burst<0||rate.burst>10))return fault(`${field}.burst`,`${field}.burst must be an integer between 0 and 10.`);
 return null;
}

/** Pure. Never throws for a bad config: a fault is returned as data so the caller can log it. */
export function validateGatewayConfig(raw:any):ValidationResult{
 if(!isRecord(raw))return fault('(root)','gateway.json must contain a JSON object.');
 if(!Number.isInteger(raw.version))return fault('version',`version must be an integer; ${GATEWAY_CONFIG_VERSION} is current.`);
 if(raw.version>GATEWAY_CONFIG_VERSION)return fault('version',`gateway.json declares version ${raw.version}; this build understands ${GATEWAY_CONFIG_VERSION}.`,GATEWAY_VERSION_CODE,`Upgrade apiplan, or set version back to ${GATEWAY_CONFIG_VERSION} and re-validate with chatgpt gateway validate.`);
 if(raw.version<GATEWAY_CONFIG_VERSION)return fault('version',`gateway.json declares version ${raw.version} and no migration to ${GATEWAY_CONFIG_VERSION} is registered.`);
 if(!isRecord(raw.profiles))return fault('profiles','profiles must be an object of profile overlays.');
 if(typeof raw.activeProfile!=='string'||!Object.hasOwn(raw.profiles,raw.activeProfile))return fault('activeProfile',`activeProfile must name a key of profiles; profiles has ${Object.keys(raw.profiles).join(', ')||'no entries'}.`);
 if(!isRecord(raw.defaults))return fault('defaults','defaults must be an object holding the base policy.');
 for(const [key,value] of Object.entries({...(raw.classify||{}),...(raw.kindRules||{})}))if(!OPERATION_KINDS.includes(value as OperationKind))return fault(Object.hasOwn(raw.classify||{},key)?`classify.${key}`:`kindRules.${key}`,`kind must be one of ${OPERATION_KINDS.join(', ')}; got ${JSON.stringify(value)}.`);
 if(raw.scopeTemplates!==undefined){
  if(!Array.isArray(raw.scopeTemplates))return fault('scopeTemplates','scopeTemplates must be an array.');
  for(const [index,entry] of raw.scopeTemplates.entries()){
   if(!isRecord(entry)||!isSafeTemplate(entry.template))return fault(`scopeTemplates[${index}].template`,'A scope template must start with /backend-api/ and contain no "..", no "://" and no line break.');
   if(entry.scope!==undefined&&typeof entry.scope!=='string')return fault(`scopeTemplates[${index}].scope`,'scope must be a string.');
  }
 }
 const base=validatePolicy(raw.defaults,'defaults');
 if(base)return base;
 // Each profile is validated as the MERGED policy it produces, because a profile is an overlay and
 // only the merged result is what actually governs traffic.
 for(const [name,overlay] of Object.entries(raw.profiles)){
  if(!isRecord(overlay))return fault(`profiles.${name}`,`profiles.${name} must be an object overlay.`);
  const problem=validatePolicy(mergeDeep(raw.defaults,overlay),`profiles.${name}`);
  if(problem)return problem;
 }
 return {ok:true,config:raw as GatewayConfigFile};
}

function validatePolicy(policy:any,field:string):ValidationResult|null{
 if(!isRecord(policy.concurrency))return fault(`${field}.concurrency`,'concurrency must be an object.');
 const {global,generation,perScope}=policy.concurrency;
 if(!Number.isInteger(global)||global<1)return fault(`${field}.concurrency.global`,'concurrency.global must be an integer of 1 or more.');
 if(!Number.isInteger(generation)||generation<0)return fault(`${field}.concurrency.generation`,'concurrency.generation must be an integer of 0 or more.');
 if(perScope!==undefined){
  if(!isRecord(perScope))return fault(`${field}.concurrency.perScope`,'concurrency.perScope must be an object.');
  for(const [scope,value] of Object.entries(perScope)){
   if(!Number.isInteger(value)||(value as number)<0)return fault(`${field}.concurrency.perScope.${scope}`,'A perScope concurrency must be an integer of 0 or more.');
   if((value as number)>global)return fault(`${field}.concurrency.perScope.${scope}`,`perScope.${scope} is ${value}, which exceeds concurrency.global ${global}.`);
  }
 }
 if(!isRecord(policy.scopes))return fault(`${field}.scopes`,'scopes must be an object of scope limits.');
 for(const [scope,rate] of Object.entries(policy.scopes)){const problem=validateRate(rate,`${field}.scopes.${scope}`);if(problem)return problem;}
 if(!isRecord(policy.kinds))return fault(`${field}.kinds`,'kinds must be an object of per-kind limits.');
 for(const kind of OPERATION_KINDS){const problem=validateRate(policy.kinds[kind],`${field}.kinds.${kind}`);if(problem)return problem;}
 if(!isRecord(policy.operations))return fault(`${field}.operations`,'operations must be an object.');
 for(const [op,entry] of Object.entries<any>(policy.operations)){
  if(!isRecord(entry))return fault(`${field}.operations.${op}`,'An operation policy must be an object.');
  if(!['allow','acknowledge','forbid'].includes(entry.permission))return fault(`${field}.operations.${op}.permission`,'permission must be allow, acknowledge or forbid.');
  if(entry.kind!==undefined&&!OPERATION_KINDS.includes(entry.kind))return fault(`${field}.operations.${op}.kind`,`kind must be one of ${OPERATION_KINDS.join(', ')}.`);
  if(entry.permission==='acknowledge'&&entry.acknowledgeKey!==undefined&&typeof entry.acknowledgeKey!=='string')return fault(`${field}.operations.${op}.acknowledgeKey`,'acknowledgeKey must be a string.');
  if(entry.acknowledgeWhen!==undefined&&!['always','non-get'].includes(entry.acknowledgeWhen))return fault(`${field}.operations.${op}.acknowledgeWhen`,'acknowledgeWhen must be always or non-get.');
  if(entry.timeoutMs!==undefined&&(!isDuration(entry.timeoutMs)||entry.timeoutMs===0))return fault(`${field}.operations.${op}.timeoutMs`,`timeoutMs must be an integer between 1 and ${MAX_DURATION_MS}.`);
  if(entry.rate!==undefined){
   if(!isRecord(entry.rate))return fault(`${field}.operations.${op}.rate`,'rate must be an object.');
   const problem=validateRate({minSpacingMs:0,...entry.rate},`${field}.operations.${op}.rate`);if(problem)return problem;
  }
 }
 if(policy.unknownOperation==='allow')return fault(`${field}.unknownOperation`,'unknownOperation cannot be allow: an operation nobody classified must never be freely reachable.');
 if(!['forbid','acknowledge'].includes(policy.unknownOperation))return fault(`${field}.unknownOperation`,'unknownOperation must be forbid or acknowledge.');
 if(policy.forbid!==undefined&&!isStringArray(policy.forbid))return fault(`${field}.forbid`,'forbid must be an array of operation names.');
 const backoff=policy.backoff;
 if(!isRecord(backoff))return fault(`${field}.backoff`,'backoff must be an object.');
 for(const key of ['baseMs','ceilingMs','retryAfterCeilingMs','recoveryMs'])if(!isDuration(backoff[key]))return fault(`${field}.backoff.${key}`,`backoff.${key} must be an integer between 0 and ${MAX_DURATION_MS}.`);
 if(typeof backoff.factor!=='number'||!Number.isFinite(backoff.factor)||backoff.factor<1)return fault(`${field}.backoff.factor`,'backoff.factor must be a number of 1 or more.');
 if(!Number.isInteger(backoff.maxExponent)||backoff.maxExponent<0||backoff.maxExponent>16)return fault(`${field}.backoff.maxExponent`,'backoff.maxExponent must be an integer between 0 and 16.');
 if(!['max','site'].includes(backoff.retryAfter))return fault(`${field}.backoff.retryAfter`,'backoff.retryAfter must be max or site.');
 if(!isRecord(backoff.maxRetriesByKind))return fault(`${field}.backoff.maxRetriesByKind`,'backoff.maxRetriesByKind must be an object with one entry per kind.');
 for(const kind of OPERATION_KINDS){
  const retries=backoff.maxRetriesByKind[kind];
  if(!Number.isInteger(retries)||retries<0)return fault(`${field}.backoff.maxRetriesByKind.${kind}`,'A retry ceiling must be an integer of 0 or more.');
  if(retries>0&&(kind==='write'||kind==='generation'))return fault(`${field}.backoff.maxRetriesByKind.${kind}`,`maxRetriesByKind.${kind} must stay 0: a website write whose outcome is unknown must never be replayed blindly (docs/CHATGPT-ORACLE.md).`);
 }
 if(backoff.ceilingMs>CEILING_WITHOUT_NOTE_MS&&typeof policy.note!=='string')return fault(`${field}.backoff.ceilingMs`,`backoff.ceilingMs above ${CEILING_WITHOUT_NOTE_MS} needs an explicit "note" saying why; 15 minutes is the documented maximum penalty today.`);
 if(!isRecord(policy.freeze))return fault(`${field}.freeze`,'freeze must be an object.');
 if(!isStringArray(policy.freeze.allowOps))return fault(`${field}.freeze.allowOps`,'freeze.allowOps must be an array of worker operation names.');
 if(typeof policy.freeze.honorCapability!=='boolean')return fault(`${field}.freeze.honorCapability`,'freeze.honorCapability must be true or false.');
 for(const op of policy.freeze.allowOps)if(!FROZEN_ALLOWED_OPS.has(op))return fault(`${field}.freeze.allowOps`,`freeze.allowOps may only SUBTRACT from the built-in frozen allowlist; ${JSON.stringify(op)} is not in it. A config file is caller-supplied data and must never grant a capability.`);
 if(policy.freeze.localOps!==undefined){
  if(!isStringArray(policy.freeze.localOps))return fault(`${field}.freeze.localOps`,'freeze.localOps must be an array of operation names.');
  for(const op of policy.freeze.localOps)if(!LOCAL_OPERATIONS.has(op))return fault(`${field}.freeze.localOps`,`freeze.localOps may only SUBTRACT from the built-in local operation set; ${JSON.stringify(op)} is not in it.`);
 }
 return null;
}

/* ------------------------------------------------------------------ loading */

/** Injected reader: returns the file's text, or null when it does not exist. Never writes. */
export type ConfigReader=(path:string)=>string|null;
export type ConfigStatus='builtin'|'loaded'|'invalid'|'unsupported-version';
export interface LoadedGatewayPolicy{
 status:ConfigStatus;path:string;config:GatewayConfigFile;policy:Policy;profile:string;
 /** Human-readable, always names the exact config path that decided it. */
 reason:string;
 fault?:ConfigFault;
 /** Ready for recordEvent by the caller; this module records nothing itself. */
 event:{type:string;[key:string]:any};
}

/** Pure path computation: no mkdir, unlike accountDir(). */
/** Resolved live, like accountDir: a frozen ROOT would read one account root while writing to another. */
export function gatewayConfigPath(accountId:string){return join(root(),'accounts',validId(accountId),'gateway.json');}

export function mergeDeep<T>(base:T,overlay:any):T{
 if(!isRecord(base)||!isRecord(overlay))return (overlay===undefined?base:overlay) as T;
 const out:any={...base};
 for(const [key,value] of Object.entries(overlay))out[key]=value===undefined?out[key]:isRecord(value)&&isRecord(out[key])?mergeDeep(out[key],value):value;
 return out as T;
}

/** Resolve defaults + the active profile into the one Policy that governs traffic. */
export function resolvePolicy(config:GatewayConfigFile):Policy{return mergeDeep(config.defaults,config.profiles[config.activeProfile]||{});}

/**
 * Read (through the injected reader), validate, version-check and resolve. Never writes, never
 * creates the file, and never throws for bad input on disk.
 */
export function loadGatewayPolicy(accountId:string,read:ConfigReader):LoadedGatewayPolicy{
 const path=gatewayConfigPath(accountId);
 let text:string|null=null;
 try{text=read(path);}catch(error:any){
  const fault:ConfigFault={code:GATEWAY_INVALID_CODE,field:'(file)',message:`gateway.json could not be read: ${error?.message||error}.`,action:'Fix the file or its permissions; local reads and chatgpt freeze keep working meanwhile.'};
  return failed(path,fault);
 }
 if(text===null||text.trim()==='')return {status:'builtin',path,config:BUILTIN_GATEWAY,policy:resolvePolicy(BUILTIN_GATEWAY),profile:BUILTIN_GATEWAY.activeProfile,reason:`No gateway.json at ${path}; the built-in default applies (defaults.*), which equals the behaviour shipped in src/chatgpt/service.ts.`,event:{type:'gateway.config.default',path}};
 let parsed:any;
 try{parsed=JSON.parse(text);}catch(error:any){return failed(path,{code:GATEWAY_INVALID_CODE,field:'(json)',message:`gateway.json is not valid JSON: ${error?.message||error}.`,action:'Fix the JSON syntax. Site traffic stays refused until it parses; local reads, chatgpt freeze and the reduce-activity stop class keep working.'});}
 const result=validateGatewayConfig(parsed);
 if(!result.ok)return failed(path,result.fault);
 const config=result.config;
 return {status:'loaded',path,config,policy:resolvePolicy(config),profile:config.activeProfile,reason:`gateway.json profile ${config.activeProfile} is in force (profiles.${config.activeProfile}, over defaults.*).`,event:{type:'gateway.config.loaded',path,profile:config.activeProfile,version:config.version}};
}

function failed(path:string,fault:ConfigFault):LoadedGatewayPolicy{
 const status:ConfigStatus=fault.code===GATEWAY_VERSION_CODE?'unsupported-version':'invalid';
 return {status,path,config:BUILTIN_GATEWAY,policy:resolvePolicy(BUILTIN_GATEWAY),profile:BUILTIN_GATEWAY.activeProfile,fault,
  reason:`${path} is not usable (${fault.field}): ${fault.message} Site-bound operations are refused until it is fixed; local reads and the reduce-activity stop class still run.`,
  event:{type:fault.code===GATEWAY_VERSION_CODE?'gateway.config.unsupported':'gateway.config.invalid',path,field:fault.field,code:fault.code}};
}

/* ------------------------------------------------------------------ classification + scopes */

export interface Classification{kind:OperationKind;source:'operations'|'classify'|'kindRules'|'unknown';configPath:string}

/** Exact classify entry, else longest matching prefix rule, else unknown. */
export function classifyOperation(config:GatewayConfigFile,op:string,policy?:Policy):Classification{
 const operationKind=policy?.operations?.[op]?.kind;
 if(operationKind)return {kind:operationKind,source:'operations',configPath:`operations.${op}.kind`};
 const exact=config.classify?.[op];
 if(exact)return {kind:exact,source:'classify',configPath:`classify.${op}`};
 let best='';
 for(const prefix of Object.keys(config.kindRules||{}))if(op.startsWith(prefix)&&prefix.length>best.length)best=prefix;
 if(best)return {kind:config.kindRules![best]!,source:'kindRules',configPath:`kindRules.${best}`};
 return {kind:'write',source:'unknown',configPath:'unknownOperation'};
}

/**
 * Normalise a site path to a scope name by SEGMENT matching, never by a config-supplied regex
 * (a regex from data is a ReDoS and mis-scope hazard). '{id}' matches exactly one non-empty segment.
 */
export function resolveScope(config:GatewayConfigFile,path?:string):string{
 if(!path)return '*';
 const clean=path.split('?')[0]!.split('#')[0]!;
 const parts=clean.split('/');
 for(const entry of config.scopeTemplates||[]){
  const template=entry.template.split('?')[0]!.split('/');
  if(template.length!==parts.length)continue;
  let ok=true;
  for(let index=0;index<template.length;index++){
   const want=template[index]!,got=parts[index]!;
   if(want==='{id}'){if(!got){ok=false;break;}continue;}
   if(want!==got){ok=false;break;}
  }
  if(ok)return entry.scope||entry.template;
 }
 return '*';
}

/** Strictest wins: the longest spacing, the tightest window, the smallest burst. */
export function strictestRate(...rates:(Partial<RateLimit>|undefined)[]):RateLimit{
 let out:RateLimit={minSpacingMs:0,burst:0};
 let bestWindow=Infinity,first=true;
 for(const rate of rates){
  if(!rate)continue;
  out.minSpacingMs=Math.max(out.minSpacingMs,rate.minSpacingMs??0);
  out.burst=first?(rate.burst??0):Math.min(out.burst??0,rate.burst??0);
  if(rate.maxRequests!==undefined&&rate.intervalMs!==undefined){
   const perMs=rate.intervalMs===0?Infinity:rate.maxRequests/rate.intervalMs;
   if(perMs<bestWindow){bestWindow=perMs;out.maxRequests=rate.maxRequests;out.intervalMs=rate.intervalMs;}
  }
  first=false;
 }
 return out;
}

/* ------------------------------------------------------------------ decision */

export type DecisionOutcome='allow'|'refuse'|'acknowledge';
export interface DecisionError{code:string;message:string;action:string;retryable:false}
export interface DecisionRequest{
 op:string;args?:any;layer?:PolicyLayer;path?:string;method?:string;
 /** Read by the caller from freeze.json; this module performs no I/O. */
 frozen?:boolean;
 /** Live counters from request-state.json, passed in so the engine stays pure. */
 state?:{rateLimitedUntil?:number;limitedScope?:string};
 now?:number;
}
export interface Decision{
 outcome:DecisionOutcome;
 op:string;layer:PolicyLayer;kind:OperationKind;kindSource:Classification['source'];
 scope:string;local:boolean;permission:Permission;
 rate:RateLimit;concurrency:{global:number;scope:number;generation:number};
 timeoutMs:number;backoff:BackoffPolicy;maxRetries:number;
 acknowledge?:{key:string;flag:string;satisfied:boolean};
 /** Wall-clock the caller must not send before (an active 429 penalty). Data, not a sleep. */
 notBeforeMs:number;
 configStatus:ConfigStatus;profile:string;
 /** Names the exact config path that produced this decision, so a refusal is debuggable without code. */
 configPath:string;reason:string;error?:DecisionError;
}

/** Turn a refusing decision into the typed Error shape the rest of the client already throws. */
export function decisionError(decision:Decision){
 if(!decision.error)return null;
 return Object.assign(new Error(decision.error.message),{code:decision.error.code,retryable:false as const,action:decision.error.action,op:decision.op,scope:decision.scope,configPath:decision.configPath});
}

/**
 * Resolve one call into a decision. Order (design-policy.md §2), first match wins:
 *  0. config unusable                -> refuse every site-bound op, fail closed
 *  1. forbid list                    -> GATEWAY_FORBIDDEN
 *  2. freeze gate                    -> FROZEN
 *  3. operations[op].permission      -> GATEWAY_ACK_REQUIRED
 *  4/5. concurrency + rate           -> attached as data
 *  6. active 429 deadline            -> notBeforeMs
 *
 * The reduce-activity FLOOR sits above steps 0 and 1: an operation the freeze policy itself still
 * permits (stop, close, observe) is never refused by a config list, because losing the ability to
 * stop traffic is the failure this whole gateway exists to prevent. Config can shrink that floor
 * via freeze.allowOps / freeze.localOps; it can never grow it.
 */
export function decide(loaded:LoadedGatewayPolicy,request:DecisionRequest):Decision{
 const layer:PolicyLayer=request.layer||'service';
 const {op,args}=request;
 const policy=loaded.policy,config=loaded.config;
 const classification=op==='request'&&layer==='worker'
  ? {kind:(String(request.method||'GET').toUpperCase()==='GET'?'read':'write') as OperationKind,source:'classify' as const,configPath:'(worker request method)'}
  : classifyOperation(config,op,policy);
 const entry=policy.operations[op];
 // A worker op with no HTTP path (snapshot, action, key, scroll) is NOT web traffic, and must never
 // inherit the HTTP catch-all's spacing: the DOM poll loops run at 150-250 ms, so pacing them at the
 // catch-all's 1000 ms would blow the 45-second readiness budget and turn every send into a
 // NOT_SUBMITTED. Such ops get their own bucket, `op:*`, which a config may still tighten.
 const scope=request.path?resolveScope(config,request.path):`op:${op}`;
 const scopeRate=request.path
  ?(policy.scopes[scope]||policy.scopes['*'])
  :(policy.scopes[scope]||policy.scopes['op:*']);
 const local=layer==='service'&&(policy.freeze.localOps?policy.freeze.localOps.includes(op):LOCAL_OPERATIONS.has(op));
 const frozenOps=new Set(policy.freeze.allowOps.filter(name=>FROZEN_ALLOWED_OPS.has(name)));
 const capability=policy.freeze.honorCapability&&args?.[ALLOW_WHILE_FROZEN]===true;
 const reducesActivity=layer==='worker'?frozenOps.has(op)||capability:local||FROZEN_SERVICE_OPS.has(op);
 // The unknown-operation rule belongs to the SERVICE namespace, whose op names are enumerated in
 // service.ts execute(). Worker op names are transport.ts's own vocabulary; they reach the worker
 // only because a service operation already passed this engine, and transport.ts still holds the
 // freeze gate underneath, so refusing them by default would brick the client without adding safety.
 const unknownHere=classification.source==='unknown'&&layer==='service';
 const base={
  op,layer,kind:classification.kind,kindSource:classification.source,scope,local,
  permission:(entry?.permission||(unknownHere?policy.unknownOperation:'allow')) as Permission,
  rate:strictestRate(scopeRate,policy.kinds[classification.kind],entry?.rate),
  concurrency:{global:policy.concurrency.global,scope:policy.concurrency.perScope?.[scope]??policy.concurrency.global,generation:policy.concurrency.generation},
  timeoutMs:entry?.timeoutMs??DEFAULT_TIMEOUT_MS,
  backoff:policy.backoff,maxRetries:policy.backoff.maxRetriesByKind[classification.kind]??0,
  notBeforeMs:0,configStatus:loaded.status,profile:loaded.profile,
 };
 const refuse=(code:string,configPath:string,message:string,action:string):Decision=>({...base,outcome:'refuse',configPath,reason:`${message} (decided by ${configPath})`,error:{code,message,action,retryable:false}});

 // The reduce-activity FLOOR. An operation that only observes or only reduces activity — a local
 // read, the account's own freeze switch, the worker's stop/close/observe class — is never refused
 // by a config list, a broken file, or a version this build cannot read. Losing the ability to look
 // at or stop traffic is the exact failure this gateway exists to prevent (2026-09-15 19:51, where
 // the only remaining stop was kill -STOP on six processes). Config can SHRINK this floor through
 // freeze.allowOps / freeze.localOps; nothing can grow it.
 if(reducesActivity)return {...base,outcome:'allow',permission:'allow',configPath:layer==='worker'?'freeze.allowOps':'freeze.localOps',
  reason:`${op} only observes or reduces activity, so it stays available${request.frozen?' while frozen':''}${loaded.status==='builtin'||loaded.status==='loaded'?'':' and while gateway.json is unusable'} (decided by ${layer==='worker'?'freeze.allowOps':'freeze.localOps'})`};

 // 0. Fail closed on a config this build cannot trust.
 if(loaded.status==='invalid'||loaded.status==='unsupported-version')return refuse(loaded.fault!.code,loaded.fault!.field,`${op} is refused: ${loaded.reason}`,loaded.fault!.action);
 // 1. Explicit forbid, profile overlay first, then defaults (the overlay already merged over them).
 {
  const forbid=policy.forbid||[];
  const index=forbid.indexOf(op),wildcard=forbid.indexOf('*');
  if(index>=0||wildcard>=0){
   const at=index>=0?index:wildcard;
   const fromProfile=(config.profiles[loaded.profile] as any)?.forbid!==undefined;
   const configPath=`${fromProfile?`profiles.${loaded.profile}`:'defaults'}.forbid[${at}]`;
   return refuse(GATEWAY_FORBIDDEN_CODE,configPath,`${op} is forbidden by the ${loaded.profile} gateway profile${index<0?' (which forbids every operation via "*")':''}.`,'Switch profile with chatgpt gateway profile <name>, or remove the entry from gateway.json. Nothing was sent.');
  }
 }
 // 2. Freeze. Semantics are freeze.ts's, unchanged: the allowlist is what an operation PERMITS and
 //    the unforgeable Symbol is the only bypass. Config may subtract from the list, never add.
 if(request.frozen)
  return refuse(FREEZE_CODE,layer==='worker'?`freeze.allowOps (${op} is not in it)`:`freeze.localOps (${op} is not in it)`,`ChatGPT automation is frozen; no request was sent (${op}).`,'This stop was set deliberately. Local reads, the index and receipts keep working while frozen. Only the account owner lifts it (chatgpt thaw, or /thaw in the TUI): ask first and never thaw automatically.');
 // 3. Permission.
 if(base.permission==='forbid')
  return refuse(GATEWAY_FORBIDDEN_CODE,entry?`operations.${op}.permission`:'unknownOperation',entry?`${op} is set to permission "forbid" in the active gateway policy.`:`${op} has no classification and no operations entry, and unknownOperation is "forbid".`,entry?'Change operations.'+op+'.permission in gateway.json, or use a profile that allows it. Nothing was sent.':`Add ${op} to classify or kindRules in gateway.json, or give it an operations entry. Nothing was sent.`);
 if(base.permission==='acknowledge'){
  const key=entry?.acknowledgeKey||'allowWrite',flag=entry?.acknowledgeFlag||'--allow-write';
  const method=(request.method||'GET').toUpperCase();
  const needed=entry?.acknowledgeWhen==='non-get'?method!=='GET':true;
  const satisfied=args?.[key]===true;
  const configPath=entry?`operations.${op}.permission`:'unknownOperation';
  if(needed&&!satisfied)return {...base,outcome:'acknowledge',acknowledge:{key,flag,satisfied:false},configPath,
   reason:`${op} needs the explicit ${flag} acknowledgement (decided by ${configPath})`,
   error:{code:GATEWAY_ACK_CODE,message:`${op} refuses ${method}${request.path?' '+request.path.split('?')[0]:''} without ${flag}: a raw website write can change or destroy account data and is often invisible afterwards.`,action:`Reads need no flag. For a write, confirm the exact method and path with the account owner, then repeat the command with ${flag}.`,retryable:false}};
  return {...base,outcome:'allow',acknowledge:{key,flag,satisfied},configPath,reason:needed?`${op} carries the ${flag} acknowledgement (decided by ${configPath})`:`${op} needs no acknowledgement for ${method} (decided by ${configPath}.acknowledgeWhen)`};
 }
 // 4/5/6. Allowed: the numbers travel with the decision, the gateway applies them.
 const configPath=entry?`operations.${op}`:policy.scopes[scope]?`scopes.${scope}`:'scopes.*';
 const notBeforeMs=Math.max(0,request.state?.rateLimitedUntil||0);
 return {...base,outcome:'allow',notBeforeMs,configPath,
  reason:`${op} is allowed as kind ${classification.kind} on scope ${scope}: spacing ${base.rate.minSpacingMs}ms, concurrency ${base.concurrency.scope}${notBeforeMs?`, held until ${new Date(notBeforeMs).toISOString()} by an active rate limit on ${request.state?.limitedScope||scope}`:''} (decided by ${configPath}, kind by ${classification.configPath})`};
}
