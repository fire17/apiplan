import {afterAll,beforeEach,describe,expect,test} from 'bun:test';
import {existsSync,mkdirSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';

// Isolated account home: nothing in this file touches ~/.apiplan, a browser, or the network.
const TEST_HOME=join(tmpdir(),`apiplan-chatgpt-account-switch-${process.pid}`);
process.env.CHATGPT_HOME=TEST_HOME;
delete process.env.CHATGPT_ACCOUNT;
afterAll(()=>rmSync(TEST_HOME,{recursive:true,force:true}));

const [accounts,{setFreeze},sw]=await Promise.all([
 import('../src/chatgpt/accounts.ts'),
 import('../src/chatgpt/freeze.ts'),
 import('../src/chatgpt/account-switch.ts'),
]);

const FIRE={userId:'user-bFE3SMbbAoBgpqCnEOyRtkPi',email:'fire17@gmail.com'};
const WORK={userId:'user-WORK0000000000000000',email:'tami.bar@rayzoneg.com'};
const base=(id:string,extra:Record<string,unknown>={})=>({id,label:id,baseURL:'https://chatgpt.com',created:'2026-09-15T00:00:00.000Z',...extra});
const configPath=()=>join(TEST_HOME,'accounts.json');
function seed(config:any){rmSync(TEST_HOME,{recursive:true,force:true});mkdirSync(TEST_HOME,{recursive:true,mode:0o700});writeFileSync(configPath(),JSON.stringify(config,null,2),{mode:0o600});}
const states=()=>accounts.config().accounts.map(a=>sw.accountState(a,{selected:accounts.config().selected,readIndex:true}));

beforeEach(()=>seed({version:1,selected:'default',accounts:[base('default',{userId:FIRE.userId,email:FIRE.email,cdpURL:'http://127.0.0.1:9223',source:{provider:'browser',reference:'arc:Default'}})]}));

describe('resolving a signed-in website user to a saved account',()=>{
 test('a saved account that matches the signed-in user is FOUND, not rejected',()=>{
  seed({version:2,selected:'default',accounts:[
   base('default',{userId:FIRE.userId,email:FIRE.email,cdpURL:'http://127.0.0.1:9223'}),
   base('work',{userId:WORK.userId,email:WORK.email,cdpURL:'http://127.0.0.1:9223'}),
  ]});
  expect(accounts.accountsForUser(WORK.userId).map(a=>a.id)).toEqual(['work']);
  const decision=sw.resolveSwitch(WORK);
  expect(decision).toMatchObject({action:'select',code:'ACCOUNT_SWITCH_AVAILABLE',accountId:'work',currentAccountId:'default',candidates:['work'],writes:false});
  expect(decision.commands[0]).toBe('chatgpt accounts use work');
  expect(decision.message).toContain('tami.bar@rayzoneg.com');
  // Deciding is data: the selection on disk is untouched until applySwitch runs.
  expect(accounts.config().selected).toBe('default');
  expect(sw.applySwitch(decision)).toEqual({selected:'work'});
  expect(accounts.config().selected).toBe('work');
  expect(typeof accounts.config().selectedAt).toBe('string');
 });

 test('the account already in use is a match — stay put',()=>{
  expect(sw.resolveSwitch(FIRE)).toMatchObject({action:'stay',code:'ACCOUNT_MATCH',accountId:'default',commands:[]});
 });

 test('an unknown user yields a create-or-select decision and writes NOTHING',()=>{
  const before=readFileSync(configPath(),'utf8'),beforeMtime=statSync(configPath()).mtimeMs;
  const decision=sw.resolveSwitch(WORK);
  expect(decision).toMatchObject({action:'create',code:'ACCOUNT_MISMATCH',accountId:'tami-bar',candidates:[],writes:false});
  expect(decision.commands).toEqual(['chatgpt accounts adopt tami-bar --use']);
  // Keeps the substring monitor.ts classifies on, and now also says who, and what to run.
  expect(decision.message).toContain('signed in to a different user');
  expect(decision.message).toContain(FIRE.userId);
  expect(decision.message).toContain('Nothing was written.');
  expect(sw.mismatchMessage(decision)).toContain('→ chatgpt accounts adopt tami-bar --use');
  expect(readFileSync(configPath(),'utf8')).toBe(before);
  expect(statSync(configPath()).mtimeMs).toBe(beforeMtime);
  expect(existsSync(join(TEST_HOME,'accounts','tami-bar'))).toBe(false);
 });

 test('two accounts claiming one user refuse to guess',()=>{
  seed({version:2,selected:'default',accounts:[base('default'),base('a',{userId:WORK.userId}),base('b',{userId:WORK.userId})]});
  expect(sw.resolveSwitch(WORK,{currentAccountId:'a'})).toMatchObject({action:'stay'});
  const decision=sw.resolveSwitch(WORK);
  expect(decision).toMatchObject({action:'ambiguous',code:'ACCOUNT_AMBIGUOUS',candidates:['a','b']});
  expect(decision.commands).toEqual(['chatgpt accounts use a','chatgpt accounts use b']);
 });

 test('an archived account never wins a switch, but is reported',()=>{
  seed({version:2,selected:'default',accounts:[base('default',{userId:FIRE.userId}),base('old',{userId:WORK.userId,archived:true})]});
  const decision=sw.resolveSwitch(WORK);
  expect(decision.action).toBe('create');
  expect(decision.archivedCandidates).toEqual(['old']);
 });

 test('no signed-in user at all is its own decision, never a switch',()=>{
  expect(sw.decideSwitch({identity:{userId:''},currentAccountId:'default',states:[]})).toMatchObject({action:'unknown-identity',code:'IDENTITY_UNKNOWN',writes:false});
 });
});

describe('adoption: only an account with no bound identity may take one',()=>{
 test('canAdopt is pure and refuses every bound case',()=>{
  const bound=sw.accountState(accounts.account('default'));
  expect(bound.bound).toBe(false); // recorded, not yet bound: no identity file, no index
  const withIdentity={...bound,boundUserId:FIRE.userId,boundFrom:'identity-file' as const,bound:true};
  expect(sw.canAdopt(withIdentity,WORK)).toMatchObject({allowed:false,code:'BOUND_TO_OTHER_USER'});
  expect(sw.canAdopt(withIdentity,FIRE)).toMatchObject({allowed:false,code:'ALREADY_BOUND'});
  expect(sw.canAdopt({...bound,recordedUserId:FIRE.userId},WORK)).toMatchObject({allowed:false,code:'RECORDED_AS_OTHER_USER'});
  expect(sw.canAdopt({...bound,archived:true,recordedUserId:undefined},WORK)).toMatchObject({allowed:false,code:'ARCHIVED'});
  expect(sw.canAdopt({...bound,recordedUserId:undefined},{userId:''})).toMatchObject({allowed:false,code:'NO_IDENTITY'});
  expect(sw.canAdopt({...bound,recordedUserId:undefined},WORK)).toMatchObject({allowed:true,code:'ADOPTABLE'});
 });

 test('an account bound to one user refuses to adopt another, and its identity file survives',()=>{
  accounts.writeAccountIdentity(accounts.account('default'),FIRE);
  const state=sw.accountState(accounts.account('default'));
  expect(state).toMatchObject({bound:true,boundUserId:FIRE.userId,boundFrom:'identity-file',state:'bound'});
  const before=readFileSync(accounts.accountIdentityFile('default'),'utf8');
  const failure=(()=>{try{sw.adoptIdentity('default',WORK);return null;}catch(e:any){return e;}})();
  expect(failure).toBeInstanceOf(Error);
  expect(failure.code).toBe('ACCOUNT_ADOPT_REFUSED');
  expect(failure.verdict).toMatchObject({allowed:false,code:'BOUND_TO_OTHER_USER'});
  expect(readFileSync(accounts.accountIdentityFile('default'),'utf8')).toBe(before);
  expect(accounts.account('default').userId).toBe(FIRE.userId);
 });

 test('an index bound to another user blocks adoption even with no identity file',()=>{
  seed({version:2,selected:'fresh',accounts:[base('fresh')]});
  const dir=accounts.accountDir(accounts.account('fresh'));
  const db=new Database(join(dir,'index.sqlite'));
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  db.query('INSERT INTO meta VALUES (?,?)').run('userId',FIRE.userId);
  db.close();
  expect(sw.indexBoundIdentity('fresh')).toBe(FIRE.userId);
  const state=sw.accountState(accounts.account('fresh'),{readIndex:true});
  expect(state).toMatchObject({bound:true,boundUserId:FIRE.userId,boundFrom:'index'});
  expect(()=>sw.adoptIdentity('fresh',WORK)).toThrow(/Refusing to adopt/);
  expect(sw.indexBoundIdentity('fresh')).toBe(FIRE.userId);
 });

 test('an unbound account adopts in place; a new user gets a NEW id and a NEW directory',()=>{
  seed({version:2,selected:'blank',accounts:[base('blank')]});
  const decision=sw.resolveSwitch(FIRE);
  expect(decision).toMatchObject({action:'bind-here',code:'ACCOUNT_ADOPTABLE',accountId:'blank'});
  const adopted=sw.adoptIdentity('blank',FIRE,{select:true,label:'Tami Bar'});
  expect(adopted).toMatchObject({created:false,selected:true});
  expect(adopted.account).toMatchObject({userId:FIRE.userId,email:FIRE.email,label:'Tami Bar'});
  expect(adopted.account.lastVerified).toMatchObject({userId:FIRE.userId,source:'adopt'});
  expect(accounts.readAccountIdentity('blank')?.userId).toBe(FIRE.userId);
  // Now the second user: a separate account, a separate directory, the old index untouched.
  const next=sw.resolveSwitch(WORK);
  expect(next).toMatchObject({action:'create',accountId:'tami-bar'});
  const created=sw.adoptIdentity('tami-bar',WORK,{template:accounts.account('blank')});
  expect(created.created).toBe(true);
  expect(existsSync(join(TEST_HOME,'accounts','tami-bar','account-identity.json'))).toBe(true);
  expect(accounts.readAccountIdentity('blank')?.userId).toBe(FIRE.userId);
  expect(accounts.account('blank').userId).toBe(FIRE.userId);
  expect(sw.resolveSwitch(WORK,{currentAccountId:'blank'})).toMatchObject({action:'select',accountId:'tami-bar'});
 });

 test('a user already saved elsewhere is a switch, never a second copy',()=>{
  seed({version:2,selected:'default',accounts:[base('default',{userId:FIRE.userId}),base('work',{userId:WORK.userId})]});
  const failure=(()=>{try{sw.adoptIdentity('another',WORK);return null;}catch(e:any){return e;}})();
  expect(failure.code).toBe('ACCOUNT_ALREADY_SAVED');
  expect(failure.message).toContain('chatgpt accounts use work');
  expect(accounts.config().accounts.map(a=>a.id)).toEqual(['default','work']);
 });

 test('recordVerification refreshes a match and refuses a mismatch',()=>{
  const verified=sw.recordVerification(accounts.account('default'),FIRE);
  expect(verified.lastVerified).toMatchObject({userId:FIRE.userId,source:'website session'});
  expect(sw.accountState(accounts.account('default')).lastSeenAgeMs).toBeLessThan(5_000);
  expect(()=>sw.recordVerification(accounts.account('default'),WORK)).toThrow(/refusing to record/);
  expect(accounts.account('default').userId).toBe(FIRE.userId);
 });
});

describe('listing accounts and the state each one is in',()=>{
 test('status reports selection, binding, transport, freeze, last seen and orphans — from disk alone',()=>{
  seed({version:2,selected:'default',accounts:[
   base('default',{userId:FIRE.userId,email:FIRE.email,cdpURL:'http://127.0.0.1:9223',source:{provider:'browser',reference:'arc:Default'}}),
   base('managed',{source:{provider:'managed'}}),
   base('old',{userId:WORK.userId,archived:true}),
  ]});
  accounts.writeAccountIdentity(accounts.account('default'),FIRE,'migrated');
  setFreeze(accounts.account('default'),true,{by:'test',reason:'probe window closed 11:41'});
  mkdirSync(join(TEST_HOME,'accounts','gateway-test'),{recursive:true});
  const status=sw.accountsStatus();
  expect(status.selected).toBe('default');
  expect(status.accounts.map(a=>a.id)).toEqual(['default','managed']);
  expect(status.accounts[0]).toMatchObject({id:'default',selected:true,transport:'attached-cdp',bound:true,boundUserId:FIRE.userId,boundFrom:'identity-file',frozen:true,frozenReason:'probe window closed 11:41',state:'frozen',lastSeenSource:'migrated'});
  expect(typeof status.accounts[0].lastSeenAt).toBe('string');
  expect(status.accounts[0].lastSeenAgeMs).toBeLessThan(5_000);
  expect(status.accounts[1]).toMatchObject({id:'managed',selected:false,transport:'managed',bound:false,boundFrom:'none',frozen:false,state:'unbound',hasIndex:false});
  expect(status.accounts[1].lastSeenAt).toBeUndefined();
  expect(status.orphans).toEqual(['gateway-test']);
  expect(sw.listAccountStates({includeArchived:true}).find(a=>a.id==='old')).toMatchObject({archived:true,state:'archived'});
  // Reading state never creates state.
  expect(existsSync(join(TEST_HOME,'accounts','managed'))).toBe(false);
 });

 test('a v1 config migrates in memory; a newer one fails closed',()=>{
  expect(accounts.config()).toMatchObject({version:2,selected:'default'});
  expect(accounts.config().accounts[0].archived).toBe(false);
  expect(readFileSync(configPath(),'utf8')).toContain('"version": 1');
  seed({version:3,selected:'default',accounts:[base('default')]});
  const failure=(()=>{try{accounts.config();return null;}catch(e:any){return e;}})();
  expect(failure.code).toBe('ACCOUNTS_CONFIG_VERSION');
  expect(failure.message).toContain('newer build (version 3)');
 });

 test('suggested ids are valid, readable and unique',()=>{
  expect(sw.suggestAccountId(WORK)).toBe('tami-bar');
  expect(sw.suggestAccountId(WORK,['tami-bar'])).toBe('tami-bar-2');
  expect(sw.suggestAccountId({userId:'user-x'})).toBe('user-x');
  expect(()=>accounts.validId(sw.suggestAccountId({userId:'user-x',email:'--@x.com'}))).not.toThrow();
 });

 test('applying anything but a select decision is refused',()=>{
  const decision=sw.resolveSwitch(WORK);
  expect(()=>sw.applySwitch(decision)).toThrow(/Only a 'select' decision/);
  expect(accounts.config().selected).toBe('default');
 });
});
