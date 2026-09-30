import {existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {account,accountDirPath,accountsForUser,config,orphanAccountDirs,readAccountIdentity,saveAccount,selectAccount,validId,writeAccountIdentity,type Account} from './accounts.ts';
import {readFreeze} from './freeze.ts';

/**
 * Account switching for the ChatGPT website client.
 *
 * The 2026-09-16 incident: a read-only probe died on ACCOUNT_MISMATCH because the attached browser
 * was signed in as a different user than account `default` is bound to. The guard in store.ts is
 * RIGHT — one index must never hold two users' records — but refusing is the beginning of a switch,
 * not the end of it. This module turns the refusal into a decision: who is signed in, which saved
 * account is theirs, and exactly what the caller should run next.
 *
 * Two hard properties, both tested:
 *  1. `decideSwitch` and `canAdopt` are PURE. They return data. They open nothing, send nothing,
 *     start no browser, and write no file — safe to call while an account is frozen.
 *  2. Adoption only ever binds an account that has NO identity yet. Another user's identity is
 *     never written into a bound account's directory; a fresh id and a fresh directory are used.
 */

/** Who the website says is signed in. Never a credential — ids and labels only. */
export type WebsiteIdentity={userId:string;email?:string;name?:string};

export type AccountTransport='attached-cdp'|'managed';
/** Everything `accounts status` needs, read from disk alone. No browser, no traffic, no index write. */
export type AccountState={
 id:string;label:string;selected:boolean;archived:boolean;transport:AccountTransport;
 cdpURL?:string;profilePath?:string;
 recordedUserId?:string;recordedEmail?:string;
 /** Identity this account's data is actually bound to (account-identity.json, or index.sqlite when asked). */
 boundUserId?:string;boundFrom:'identity-file'|'index'|'none';bound:boolean;
 lastSeenAt?:string;lastSeenAgeMs?:number;lastSeenSource?:string;
 frozen:boolean;frozenReason?:string;hasIndex:boolean;
 state:'archived'|'frozen'|'bound'|'unbound';
};

export type SwitchAction='stay'|'select'|'bind-here'|'create'|'ambiguous'|'unknown-identity';
/** A decision is DATA: what matched, and the exact commands the caller should run. Nothing acts on it here. */
export type SwitchDecision={
 action:SwitchAction;code:string;userId:string;email?:string;
 currentAccountId:string;accountId?:string;
 candidates:string[];archivedCandidates:string[];
 commands:string[];message:string;writes:false;
};

export type AdoptVerdict={allowed:boolean;code:'ADOPTABLE'|'ALREADY_BOUND'|'BOUND_TO_OTHER_USER'|'RECORDED_AS_OTHER_USER'|'ARCHIVED'|'NO_IDENTITY';reason:string};

const now=()=>Date.now();
export function transportOf(a:Account):AccountTransport{return a.cdpURL||a.transportMode==='attached'||a.source?.provider==='browser'?'attached-cdp':'managed';}

/** Identity recorded inside index.sqlite `meta`. Opt-in: opening the index costs -wal/-shm and may race the daemon. */
export function indexBoundIdentity(id:string):string|undefined{
 const path=join(accountDirPath(id),'index.sqlite');
 if(!existsSync(path))return undefined;
 try{
  const {Database}=require('bun:sqlite');
  const db=new Database(path,{readonly:true});
  try{const row=db.query('SELECT value FROM meta WHERE key=?').get('userId') as any;return row?.value||undefined;}finally{db.close();}
 }catch{return undefined;}
}

/** One account's state, from disk. `readIndex` also consults index.sqlite; off by default so status stays cheap and daemon-safe. */
export function accountState(a:Account,opts:{selected?:string;readIndex?:boolean}={}):AccountState{
 const identity=readAccountIdentity(a);
 const indexBound=opts.readIndex?indexBoundIdentity(a.id):undefined;
 const boundUserId=identity?.userId||indexBound;
 const boundFrom:AccountState['boundFrom']=identity?.userId?'identity-file':indexBound?'index':'none';
 const lastSeenAt=a.lastVerified?.at||identity?.at||undefined;
 const seen=lastSeenAt?Date.parse(lastSeenAt):NaN;
 const dir=accountDirPath(a.id);
 // readFreeze() would create the account directory; a read of state must not make state.
 const freeze=existsSync(dir)?readFreeze(a):{frozen:false,reason:undefined as string|undefined};
 const archived=a.archived===true;
 let hasIndex=false;try{hasIndex=statSync(join(dir,'index.sqlite')).size>0;}catch{}
 return {
  id:a.id,label:a.label,selected:(opts.selected??config().selected)===a.id,archived,transport:transportOf(a),
  ...(a.cdpURL?{cdpURL:a.cdpURL}:{}),...(a.profilePath?{profilePath:a.profilePath}:{}),
  ...(a.userId?{recordedUserId:a.userId}:{}),...(a.email?{recordedEmail:a.email}:{}),
  ...(boundUserId?{boundUserId}:{}),boundFrom,bound:Boolean(boundUserId),
  ...(lastSeenAt?{lastSeenAt}:{}),...(Number.isFinite(seen)?{lastSeenAgeMs:Math.max(0,now()-seen)}:{}),
  ...(a.lastVerified?.source||identity?.source?{lastSeenSource:a.lastVerified?.source||identity?.source}:{}),
  frozen:freeze.frozen,...(freeze.reason?{frozenReason:freeze.reason}:{}),hasIndex,
  state:archived?'archived':freeze.frozen?'frozen':boundUserId?'bound':'unbound',
 };
}

/** Every saved account with the state it is in. Disk only — safe while frozen, safe while a daemon runs. */
export function listAccountStates(opts:{includeArchived?:boolean;readIndex?:boolean}={}):AccountState[]{
 const c=config();
 return c.accounts.filter(a=>opts.includeArchived||a.archived!==true).map(a=>accountState(a,{selected:c.selected,readIndex:opts.readIndex}));
}
/** The full `accounts status` payload: selection, every account's state, and orphan directories (reported, never deleted). */
export function accountsStatus(opts:{includeArchived?:boolean;readIndex?:boolean;orphans?:boolean}={}){
 const c=config();
 return {selected:c.selected,...(c.selectedAt?{selectedAt:c.selectedAt}:{}),accounts:listAccountStates(opts),...(opts.orphans===false?{}:{orphans:orphanAccountDirs()})};
}

/** PURE: accounts whose recorded or bound identity is this user. */
export function matchStates(userId:string,states:AccountState[]):AccountState[]{
 if(!userId)return [];
 return states.filter(s=>s.boundUserId===userId||s.recordedUserId===userId);
}

/**
 * PURE: may this account take on this website identity?
 * Allowed ONLY for an account with no identity yet. Anything already bound — to this user or another —
 * is not an adoption: re-binding a bound directory is the one move that could merge two users' data.
 */
export function canAdopt(state:AccountState,identity:WebsiteIdentity):AdoptVerdict{
 if(!identity?.userId)return {allowed:false,code:'NO_IDENTITY',reason:'No website user id was supplied; nothing can be adopted.'};
 if(state.archived)return {allowed:false,code:'ARCHIVED',reason:`Account '${state.id}' is archived. Restore it before using it.`};
 if(state.boundUserId===identity.userId)return {allowed:false,code:'ALREADY_BOUND',reason:`Account '${state.id}' is already bound to ${identity.userId}; there is nothing to adopt. Select it instead.`};
 if(state.boundUserId)return {allowed:false,code:'BOUND_TO_OTHER_USER',reason:`Account '${state.id}' holds data for ${state.boundUserId}. Adopting ${identity.userId} here would mix two users in one index.`};
 if(state.recordedUserId&&state.recordedUserId!==identity.userId)return {allowed:false,code:'RECORDED_AS_OTHER_USER',reason:`Account '${state.id}' is recorded as ${state.recordedUserId}. Save ${identity.userId} as a new account.`};
 return {allowed:true,code:'ADOPTABLE',reason:`Account '${state.id}' has no bound identity; it may adopt ${identity.userId}.`};
}

/** A readable, valid account id suggestion for a new user — from the email local part, uniquified against taken ids. */
export function suggestAccountId(identity:WebsiteIdentity,taken:string[]=[]):string{
 const raw=(identity.email?.split('@')[0]||identity.name||identity.userId||'account').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
 const base=/^[a-z0-9]/.test(raw)?raw:'account';
 const used=new Set(taken);
 if(!used.has(base))return base;
 for(let n=2;n<1000;n++){const candidate=`${base}-${n}`;if(!used.has(candidate))return candidate;}
 return `${base}-${Date.now()}`;
}

/**
 * PURE: the whole mismatch answer in one value — which saved account is this signed-in user,
 * or none, plus exactly what to run. Never writes; deciding and acting are separate on purpose,
 * because selection is a durable side effect on a file every session shares.
 */
export function decideSwitch(input:{identity:WebsiteIdentity;currentAccountId:string;states:AccountState[];suggestedId?:string}):SwitchDecision{
 const {identity,currentAccountId,states}=input;
 const base={userId:identity?.userId||'',...(identity?.email?{email:identity.email}:{}),currentAccountId,candidates:[] as string[],archivedCandidates:[] as string[],writes:false as const};
 if(!identity?.userId)return {...base,action:'unknown-identity',code:'IDENTITY_UNKNOWN',commands:['chatgpt accounts whoami'],message:'The website did not report a signed-in user. Sign in, then ask again; no account was changed.'};
 const live=states.filter(s=>!s.archived),archived=states.filter(s=>s.archived);
 const matches=matchStates(identity.userId,live),archivedMatches=matchStates(identity.userId,archived).map(s=>s.id);
 const current=states.find(s=>s.id===currentAccountId);
 const who=identity.email?`${identity.email} (${identity.userId})`:identity.userId;
 if(current&&matches.some(s=>s.id===current.id))
  return {...base,action:'stay',code:'ACCOUNT_MATCH',accountId:current.id,candidates:[current.id],archivedCandidates:archivedMatches,commands:[],message:`Account '${current.id}' is ${who}. Nothing to switch.`};
 if(matches.length===1)
  return {...base,action:'select',code:'ACCOUNT_SWITCH_AVAILABLE',accountId:matches[0].id,candidates:[matches[0].id],archivedCandidates:archivedMatches,commands:[`chatgpt accounts use ${matches[0].id}`,`chatgpt --account ${matches[0].id} <command>`],message:`The browser is signed in as ${who}, which is saved account '${matches[0].id}' — not '${currentAccountId}'. Nothing was written.`};
 if(matches.length>1)
  return {...base,action:'ambiguous',code:'ACCOUNT_AMBIGUOUS',candidates:matches.map(s=>s.id),archivedCandidates:archivedMatches,commands:matches.map(s=>`chatgpt accounts use ${s.id}`),message:`${matches.length} saved accounts claim ${who}: ${matches.map(s=>s.id).join(', ')}. Refusing to guess; choose one.`};
 const adoptable=current?canAdopt(current,identity):{allowed:false,code:'NO_IDENTITY' as const,reason:''};
 if(current&&adoptable.allowed)
  return {...base,action:'bind-here',code:'ACCOUNT_ADOPTABLE',accountId:current.id,archivedCandidates:archivedMatches,commands:[`chatgpt accounts adopt ${current.id}`],message:`Account '${current.id}' has no identity yet, so it can take ${who} as its own. ${archivedMatches.length?`Archived accounts also claiming this user: ${archivedMatches.join(', ')}.`:''}`.trim()};
 const suggested=input.suggestedId||suggestAccountId(identity,states.map(s=>s.id));
 return {...base,action:'create',code:'ACCOUNT_MISMATCH',accountId:suggested,archivedCandidates:archivedMatches,
  commands:[`chatgpt accounts adopt ${suggested} --use`],
  message:`This browser signed in to a different user. Account '${currentAccountId}'${describeBinding(current)}; the browser is signed in as ${who}. Nothing was written. No saved account matches — save this user as a new account: chatgpt accounts adopt ${suggested} --use`};
}

/** "is bound to fire17@gmail.com (user-…)" — from whichever identity the account actually has on record. */
function describeBinding(current?:AccountState):string{
 const id=current?.boundUserId||current?.recordedUserId;
 if(!id)return ' has no identity on record';
 const email=current?.recordedEmail;
 return ` is bound to ${email?`${email} (${id})`:id}`;
}

/** Disk-backed convenience: build the states, then decide. Still writes nothing and sends nothing. */
export function resolveSwitch(identity:WebsiteIdentity,opts:{currentAccountId?:string;readIndex?:boolean}={}):SwitchDecision{
 const c=config();
 const currentAccountId=opts.currentAccountId||process.env.CHATGPT_ACCOUNT||c.selected;
 return decideSwitch({identity,currentAccountId,states:c.accounts.map(a=>accountState(a,{selected:c.selected,readIndex:opts.readIndex}))});
}

/** A directory that already holds another user's data must never be reused for a new account. */
export function directoryIsFree(id:string,identity:WebsiteIdentity):{free:boolean;reason?:string}{
 const existing=readAccountIdentity(id);
 if(existing&&existing.userId!==identity.userId)return {free:false,reason:`Directory for '${id}' already records ${existing.userId}.`};
 const indexed=indexBoundIdentity(id);
 if(indexed&&indexed!==identity.userId)return {free:false,reason:`The index in '${id}' is bound to ${indexed}.`};
 return {free:true};
}

export type AdoptResult={account:Account;identity:WebsiteIdentity;created:boolean;selected:boolean;state:AccountState};
/**
 * ACTION: save a signed-in user as an account — either a brand-new id (fresh directory, fresh index)
 * or an existing account that has no identity yet. Refuses anything else with a typed error, so the
 * only way another user's identity reaches a bound directory is a path that does not exist.
 */
export function adoptIdentity(id:string,identity:WebsiteIdentity,opts:{label?:string;select?:boolean;template?:Account;source?:string}={}):AdoptResult{
 validId(id);
 if(!identity?.userId)throw Object.assign(new Error('Cannot adopt: the website reported no signed-in user.'),{code:'IDENTITY_UNKNOWN'});
 const c=config();
 const existing=c.accounts.find(a=>a.id===id);
 const claimed=accountsForUser(identity.userId,{accounts:c.accounts}).filter(a=>a.id!==id);
 if(claimed.length)throw Object.assign(new Error(`User ${identity.userId} is already saved as account '${claimed[0].id}'. Run: chatgpt accounts use ${claimed[0].id}`),{code:'ACCOUNT_ALREADY_SAVED',accountId:claimed[0].id});
 if(existing){
  const verdict=canAdopt(accountState(existing,{selected:c.selected,readIndex:true}),identity);
  if(!verdict.allowed)throw Object.assign(new Error(`Refusing to adopt into '${id}': ${verdict.reason}`),{code:'ACCOUNT_ADOPT_REFUSED',verdict});
 }
 const free=directoryIsFree(id,identity);
 if(!free.free)throw Object.assign(new Error(`Refusing to adopt into '${id}': ${free.reason} Choose a new account id.`),{code:'ACCOUNT_DIR_OCCUPIED'});
 const template=opts.template||existing;
 const at=new Date().toISOString();
 const next:Account={
  id,label:opts.label||existing?.label||identity.email||identity.name||id,
  baseURL:template?.baseURL||'https://chatgpt.com',created:existing?.created||at,
  ...(template?.browserPath?{browserPath:template.browserPath}:{}),
  ...(template?.cdpURL?{cdpURL:template.cdpURL}:{}),
  ...(template?.transportMode?{transportMode:template.transportMode}:{}),
  ...(template?.headless!==undefined?{headless:template.headless}:{}),
  ...(template?.browserProfile?{browserProfile:template.browserProfile}:{}),
  ...(template?.source?{source:template.source}:{}),
  userId:identity.userId,...(identity.email?{email:identity.email}:{}),
  lastVerified:{userId:identity.userId,...(identity.email?{email:identity.email}:{}),...(identity.name?{name:identity.name}:{}),at,source:opts.source||'adopt'},
  archived:false,
 };
 // Profile path is per-account state, never inherited: two accounts must not share one browser profile.
 if(existing?.profilePath)next.profilePath=existing.profilePath;
 saveAccount(next,opts.select===true);
 writeAccountIdentity(next,identity,opts.source||'adopt');
 return {account:next,identity,created:!existing,selected:opts.select===true,state:accountState(next,{selected:opts.select===true?next.id:c.selected})};
}

/** ACTION: refresh `lastVerified` after a matching identity read. Refuses to overwrite a different user's record. */
export function recordVerification(a:Account,identity:WebsiteIdentity,source='website session'):Account{
 const state=accountState(a);
 if(state.boundUserId&&state.boundUserId!==identity.userId)throw Object.assign(new Error(`Account '${a.id}' is bound to ${state.boundUserId}; refusing to record ${identity.userId}. Nothing was written.`),{code:'ACCOUNT_MISMATCH'});
 const at=new Date().toISOString();
 const next:Account={...a,userId:identity.userId,...(identity.email?{email:identity.email}:{}),lastVerified:{userId:identity.userId,...(identity.email?{email:identity.email}:{}),...(identity.name?{name:identity.name}:{}),at,source}};
 saveAccount(next);
 writeAccountIdentity(next,identity,source);
 return next;
}

/** ACTION: act on a `select` decision. Selection is durable and shared, so it is never implied by deciding. */
export function applySwitch(decision:SwitchDecision):{selected:string}{
 if(decision.action!=='select'||!decision.accountId)throw Object.assign(new Error(`Only a 'select' decision can be applied; this one is '${decision.action}'. Run: ${decision.commands[0]||'chatgpt accounts status'}`),{code:'SWITCH_NOT_APPLICABLE'});
 selectAccount(decision.accountId);
 return {selected:decision.accountId};
}

/** The upgraded ACCOUNT_MISMATCH text. Keeps the substring monitor.ts classifies, and adds the way out. */
export function mismatchMessage(decision:SwitchDecision):string{
 const lines=[decision.message];
 for(const command of decision.commands)lines.push(`  → ${command}`);
 return lines.join('\n');
}

export {account as currentAccount};
