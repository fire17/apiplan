import {afterAll,expect,test} from 'bun:test';
import {existsSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Isolated account home: nothing in this file touches ~/.apiplan, a browser, or the network.
// The policy engine is pure, so the directory must still be empty when the suite ends.
const TEST_HOME=join(tmpdir(),`apiplan-chatgpt-gateway-policy-${process.pid}`);
process.env.CHATGPT_HOME=TEST_HOME;
afterAll(()=>rmSync(TEST_HOME,{recursive:true,force:true}));

const [policy,{ALLOW_WHILE_FROZEN,FREEZE_CODE,FROZEN_ALLOWED_OPS,allowedWhileFrozen}]=await Promise.all([
 import('../src/chatgpt/gateway-policy.ts'),
 import('../src/chatgpt/freeze.ts'),
]);
const {BUILTIN_GATEWAY,GATEWAY_ACK_CODE,GATEWAY_CONFIG_VERSION,GATEWAY_FORBIDDEN_CODE,GATEWAY_INVALID_CODE,GATEWAY_VERSION_CODE,LOCAL_OPERATIONS,OPERATION_KINDS,classifyOperation,decide,decisionError,gatewayConfigPath,loadGatewayPolicy,resolvePolicy,resolveScope,strictestRate,validateGatewayConfig}=policy;

const ACCOUNT='gateway-policy-test';
const missing=()=>loadGatewayPolicy(ACCOUNT,()=>null);
const withConfig=(config:any)=>loadGatewayPolicy(ACCOUNT,()=>typeof config==='string'?config:JSON.stringify(config));
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
/** A valid file built from the built-in default, so each test edits exactly one field. */
const baseFile=()=>{const file=clone(BUILTIN_GATEWAY as any);file.profiles={normal:{}};file.activeProfile='normal';return file;};

const serviceSource=readFileSync(join(import.meta.dir,'../src/chatgpt/service.ts'),'utf8');
/** Same enumeration shape test/chatgpt-slash.test.ts uses: the dispatch table is the source of truth. */
function dispatchedOperations(){
 const execute=serviceSource.slice(serviceSource.indexOf('async execute('));
 const ops=new Set<string>([...execute.matchAll(/case '([^']+)'/g)].map(match=>match[1]!));
 for(const op of ['harness.run','harness.test','harness.status','harness.list','browser.start','browser.stop'])ops.add(op);
 for(const action of ['list','status','add','edit','remove','reorder','pause','resume','retry','reconcile','run'])ops.add('queue.'+action);
 return [...ops].sort();
}

test('a missing config falls back to the built-in default and reproduces today\'s pacing exactly',()=>{
 let reads=0;
 const loaded=loadGatewayPolicy(ACCOUNT,path=>{reads++;expect(path).toBe(gatewayConfigPath(ACCOUNT));return null;});
 expect(reads).toBe(1);
 expect(loaded.status).toBe('builtin');
 expect(loaded.reason).toContain('No gateway.json at');
 expect(loaded.event).toMatchObject({type:'gateway.config.default'});
 // service.ts: 5000ms on /backend-api/conversation/, 1000ms on everything else, serial, one generation.
 const conversation=decide(loaded,{op:'conversations.get',path:'/backend-api/conversation/abc-123?foo=1'});
 expect(conversation.scope).toBe('/backend-api/conversation/{id}');
 expect(conversation.rate.minSpacingMs).toBe(5000);
 const other=decide(loaded,{op:'conversations.list',path:'/backend-api/conversations'});
 expect(other.rate.minSpacingMs).toBe(1000);
 expect(other.concurrency).toEqual({global:1,scope:1,generation:1});
 expect(decide(loaded,{op:'chat.send'}).timeoutMs).toBe(600000);
 expect(decide(loaded,{op:'media.download'}).timeoutMs).toBe(600000);
 expect(decide(loaded,{op:'api.request',method:'GET',path:'/backend-api/models'}).timeoutMs).toBe(45000);
 expect(decide(loaded,{op:'conversations.list'}).timeoutMs).toBe(45000);
 // No kind adds spacing today, so no operation is paced slower than its path already was.
 for(const kind of OPERATION_KINDS)expect(resolvePolicy(BUILTIN_GATEWAY).kinds[kind].minSpacingMs).toBe(0);
 // Backoff mirrors service.ts: 60s base, 2**min(n-1,4), 15 minute ceiling, Retry-After may only extend.
 expect(conversation.backoff).toMatchObject({baseMs:60000,factor:2,maxExponent:4,ceilingMs:900000,retryAfter:'max',recoveryMs:900000});
 expect(conversation.maxRetries).toBe(0);
});

test('every operation service.ts dispatches resolves to exactly one kind',()=>{
 const loaded=missing(),resolved=resolvePolicy(BUILTIN_GATEWAY);
 const ops=dispatchedOperations();
 expect(ops.length).toBeGreaterThan(100);
 const byKind:Record<string,string[]>={read:[],write:[],generation:[],bulk:[]};
 for(const op of ops){
  const classification=classifyOperation(BUILTIN_GATEWAY,op,resolved);
  expect(OPERATION_KINDS).toContain(classification.kind);
  expect(classification.source).not.toBe('unknown');
  expect(classification.configPath).not.toBe('unknownOperation');
  byKind[classification.kind]!.push(op);
  // A classified operation is never refused for being unclassified.
  expect(decide(loaded,{op}).error?.code).not.toBe(GATEWAY_FORBIDDEN_CODE);
 }
 for(const kind of OPERATION_KINDS)expect(byKind[kind]!.length).toBeGreaterThan(0);
 // The receipt journal already means "this operation changes the account", so no op in it may be
 // classified as a read: a read is the only kind a future profile could safely make retryable.
 const receipts=readFileSync(join(import.meta.dir,'../src/chatgpt/receipts.ts'),'utf8');
 const declaration=receipts.slice(receipts.indexOf('const operations=new Set(['));
 const journalled=[...declaration.slice(0,declaration.indexOf(']')).matchAll(/'([^']+)'/g)].map(match=>match[1]!);
 expect(journalled).toContain('chat.send');
 expect(journalled.length).toBeGreaterThan(10);
 for(const op of journalled){
  expect(ops).toContain(op);
  expect(['write','generation','bulk']).toContain(classifyOperation(BUILTIN_GATEWAY,op,resolved).kind);
 }
 // Bulk is the class the 19:51 incident belonged to; the crawl verbs must carry it.
 for(const op of ['takeout.run','conversations.export','media.export','invoices.sync','gpts.bootstrap'])expect(classifyOperation(BUILTIN_GATEWAY,op,resolved).kind).toBe('bulk');
 // An operation name nobody has classified is refused, not quietly allowed.
 const unknown=classifyOperation(BUILTIN_GATEWAY,'zzz-unregistered',resolved);
 expect(unknown.source).toBe('unknown');
});

test('the built-in freeze allowlist and local set stay identical to their sources in code',()=>{
 // Divergence guard 1: freeze.allowOps is imported from freeze.ts, so it can only ever match.
 expect([...BUILTIN_GATEWAY.defaults.freeze.allowOps].sort()).toEqual([...FROZEN_ALLOWED_OPS].sort());
 // Divergence guard 2: LOCAL_OPERATIONS is restated (importing service.ts would cycle), so pin it
 // against the no-start allowlist actually written in service.ts execute().
 const execute=serviceSource.slice(serviceSource.indexOf('async execute('));
 const start=execute.indexOf('if(!new Set([');
 const noStart=execute.slice(start,execute.indexOf(']).has(op)',start));
 const parsed=[...noStart.matchAll(/'([^']+)'/g)].map(match=>match[1]!).sort();
 expect(parsed.length).toBeGreaterThan(20);
 expect([...LOCAL_OPERATIONS].sort()).toEqual(parsed);
 const direct=[...serviceSource.slice(serviceSource.indexOf('export const DIRECT_READ_OPERATIONS')).matchAll(/'([^']+)'/g)].map(match=>match[1]!);
 for(const op of direct.slice(0,19))expect(LOCAL_OPERATIONS.has(op)).toBe(true);
});

test('the frozen gate keeps freeze.ts semantics op for op, and the Symbol stays the only bypass',()=>{
 const loaded=missing();
 const workerOps=[...FROZEN_ALLOWED_OPS,'request','session','snapshot.evaluate','click','send','type'];
 for(const op of workerOps){
  for(const args of [{},{[ALLOW_WHILE_FROZEN]:true},{allowWhileFrozen:true},{[ALLOW_WHILE_FROZEN]:'true'}]){
   const decision=decide(loaded,{op,args,layer:'worker',frozen:true});
   expect(decision.outcome==='allow').toBe(allowedWhileFrozen(op,args));
   if(decision.outcome!=='allow')expect(decision.error!.code).toBe(FREEZE_CODE);
  }
 }
 // A JSON-shaped claim can never forge the capability: the string key is not the Symbol.
 expect(decide(loaded,{op:'request',args:{allowWhileFrozen:true},layer:'worker',frozen:true}).outcome).toBe('refuse');
 expect(decide(loaded,{op:'request',args:JSON.parse(JSON.stringify({[ALLOW_WHILE_FROZEN]:true})),layer:'worker',frozen:true}).outcome).toBe('refuse');
 // Service layer while frozen: local reads and status keep working, site-bound work does not.
 expect(decide(loaded,{op:'receipts.list',frozen:true}).outcome).toBe('allow');
 expect(decide(loaded,{op:'freeze.set',frozen:true}).outcome).toBe('allow');
 expect(decide(loaded,{op:'status',frozen:true}).outcome).toBe('allow');
 const refused=decide(loaded,{op:'chat.send',frozen:true});
 expect(refused.outcome).toBe('refuse');
 expect(refused.error).toMatchObject({code:FREEZE_CODE,retryable:false});
 expect(refused.error!.action).toContain('never thaw automatically');
 expect(decisionError(refused)).toMatchObject({code:FREEZE_CODE,retryable:false});
 // A config may SUBTRACT from the frozen allowlist and the local set, never add to either.
 const file=baseFile();
 file.defaults.freeze.allowOps=['close','status'];
 file.defaults.freeze.localOps=['freeze.set','freeze.status'];
 const strict=withConfig(file);
 expect(strict.status).toBe('loaded');
 expect(decide(strict,{op:'snapshot',layer:'worker',frozen:true}).outcome).toBe('refuse');
 expect(decide(strict,{op:'close',layer:'worker',frozen:true}).outcome).toBe('allow');
 expect(decide(strict,{op:'receipts.list',frozen:true}).outcome).toBe('refuse');
 // honorCapability:false is a stricter posture, not a looser one.
 file.defaults.freeze.honorCapability=false;
 expect(decide(withConfig(file),{op:'close',args:{[ALLOW_WHILE_FROZEN]:true},layer:'worker',frozen:true}).outcome).toBe('allow');
 expect(decide(withConfig(file),{op:'request',args:{[ALLOW_WHILE_FROZEN]:true},layer:'worker',frozen:true}).outcome).toBe('refuse');
});

test('a config that adds to the frozen allowlist or the local set is rejected, never silently trimmed',()=>{
 const adds=baseFile();adds.defaults.freeze.allowOps=[...adds.defaults.freeze.allowOps,'request'];
 const loaded=withConfig(adds);
 expect(loaded.status).toBe('invalid');
 expect(loaded.fault).toMatchObject({code:GATEWAY_INVALID_CODE});
 expect(loaded.fault!.field).toBe('defaults.freeze.allowOps');
 expect(loaded.fault!.message).toContain('"request"');
 const locals=baseFile();locals.defaults.freeze.localOps=['chat.send'];
 expect(withConfig(locals).fault!.field).toBe('defaults.freeze.localOps');
});

test('an unusable config fails closed for site traffic and stays open for stopping and looking',()=>{
 for(const [label,loaded,code] of [
  ['unparseable',withConfig('{"version":1,'),GATEWAY_INVALID_CODE],
  ['newer version',withConfig({...baseFile(),version:GATEWAY_CONFIG_VERSION+1}),GATEWAY_VERSION_CODE],
 ] as const){
  expect(loaded.status===(code===GATEWAY_VERSION_CODE?'unsupported-version':'invalid')).toBe(true);
  const refused=decide(loaded,{op:'conversations.list'});
  expect(refused.outcome).toBe('refuse');
  expect(refused.error).toMatchObject({code,retryable:false});
  expect(refused.reason).toContain(gatewayConfigPath(ACCOUNT));
  expect(refused.reason.toLowerCase()).toContain(label==='newer version'?'version':'json');
  // Control never goes away: the owner can still look, stop, and freeze.
  expect(decide(loaded,{op:'freeze.set'}).outcome).toBe('allow');
  expect(decide(loaded,{op:'receipts.list'}).outcome).toBe('allow');
  expect(decide(loaded,{op:'close',layer:'worker'}).outcome).toBe('allow');
  expect(decide(loaded,{op:'request',layer:'worker'}).outcome).toBe('refuse');
 }
 expect(withConfig({...baseFile(),version:GATEWAY_CONFIG_VERSION+1}).fault!.action).toContain('Upgrade apiplan');
 // A version older than this build with no registered migration is refused too, not guessed at.
 expect(withConfig({...baseFile(),version:0}).status).toBe('invalid');
});

test('validation rejects every unsafe field and names the exact config path',()=>{
 const cases:[string,(file:any)=>void][]=[
  ['version',file=>{file.version='1';}],
  ['activeProfile',file=>{file.activeProfile='missing';}],
  ['defaults.scopes.*.minSpacingMs',file=>{file.defaults.scopes['*'].minSpacingMs=-1;}],
  ['defaults.scopes.*.minSpacingMs',file=>{file.defaults.scopes['*'].minSpacingMs=86400001;}],
  ['defaults.scopes.*.maxRequests',file=>{file.defaults.scopes['*'].maxRequests=5;}],
  ['defaults.concurrency.global',file=>{file.defaults.concurrency.global=0;}],
  ['defaults.concurrency.perScope./backend-api/conversations',file=>{file.defaults.concurrency.perScope={'/backend-api/conversations':2};}],
  ['defaults.unknownOperation',file=>{file.defaults.unknownOperation='allow';}],
  ['defaults.backoff.maxRetriesByKind.write',file=>{file.defaults.backoff.maxRetriesByKind.write=1;}],
  ['defaults.backoff.maxRetriesByKind.generation',file=>{file.defaults.backoff.maxRetriesByKind.generation=3;}],
  ['defaults.backoff.ceilingMs',file=>{file.defaults.backoff.ceilingMs=1800000;}],
  ['defaults.backoff.retryAfter',file=>{file.defaults.backoff.retryAfter='shorten';}],
  ['scopeTemplates[0].template',file=>{file.scopeTemplates=[{template:'/backend-api/../etc/passwd'}];}],
  ['scopeTemplates[0].template',file=>{file.scopeTemplates=[{template:'https://chatgpt.com/backend-api/x'}];}],
  ['scopeTemplates[0].template',file=>{file.scopeTemplates=[{template:'/backend-api/a\nb'}];}],
  ['classify.chat.send',file=>{file.classify={...file.classify,'chat.send':'chat'};}],
  ['defaults.operations.api.request.permission',file=>{file.defaults.operations['api.request'].permission='maybe';}],
  ['profiles.loose.unknownOperation',file=>{file.profiles.loose={unknownOperation:'allow'};}],
  ['profiles.loose.backoff.maxRetriesByKind.write',file=>{file.profiles.loose={backoff:{maxRetriesByKind:{write:2}}};}],
 ];
 for(const [field,mutate] of cases){
  const file=baseFile();mutate(file);
  const result=validateGatewayConfig(file);
  expect(result.ok).toBe(false);
  expect((result as any).fault.field).toBe(field);
  expect((result as any).fault.message.length).toBeGreaterThan(20);
 }
 // A raised ceiling is allowed once the owner writes down why.
 const noted=baseFile();noted.defaults.backoff.ceilingMs=1800000;noted.defaults.note='Site asked for 30 minutes on 2026-09-16.';
 expect(validateGatewayConfig(noted).ok).toBe(true);
 expect(validateGatewayConfig(BUILTIN_GATEWAY).ok).toBe(true);
});

test('a forbid list refuses with the exact config path, and the stop class survives forbid ["*"]',()=>{
 const file=baseFile();
 file.profiles.conservative={forbid:['takeout.run','conversations.export'],kinds:{bulk:{minSpacingMs:20000,maxRequests:3,intervalMs:300000}}};
 file.activeProfile='conservative';
 const loaded=withConfig(file);
 expect(loaded.status).toBe('loaded');
 const refused=decide(loaded,{op:'takeout.run'});
 expect(refused.outcome).toBe('refuse');
 expect(refused.error).toMatchObject({code:GATEWAY_FORBIDDEN_CODE,retryable:false});
 expect(refused.configPath).toBe('profiles.conservative.forbid[0]');
 expect(refused.reason).toContain('profiles.conservative.forbid[0]');
 // The overlay's per-kind window is inherited by every bulk operation, and backoff fields it did not
 // set still come from defaults (deep merge, not replacement).
 const bulk=decide(loaded,{op:'media.export'});
 expect(bulk.rate).toMatchObject({minSpacingMs:20000,maxRequests:3,intervalMs:300000});
 expect(bulk.backoff.factor).toBe(2);
 // frozen-window: forbid everything, yet stopping and looking still work.
 const stopped=baseFile();stopped.profiles.locked={forbid:['*']};stopped.activeProfile='locked';
 const locked=withConfig(stopped);
 expect(decide(locked,{op:'chat.send'}).error).toMatchObject({code:GATEWAY_FORBIDDEN_CODE});
 expect(decide(locked,{op:'chat.send'}).reason).toContain('forbids every operation');
 expect(decide(locked,{op:'close',layer:'worker'}).outcome).toBe('allow');
 expect(decide(locked,{op:'freeze.set'}).outcome).toBe('allow');
 // defaults.forbid is named as defaults, not blamed on the profile.
 const shared=baseFile();shared.defaults.forbid=['gpts.bootstrap'];
 expect(decide(withConfig(shared),{op:'gpts.bootstrap'}).configPath).toBe('defaults.forbid[0]');
});

test('permission forbid and an unclassified operation are both refused, with different reasons',()=>{
 const file=baseFile();
 file.defaults.operations['api.request']={kind:'write',permission:'forbid'};
 const readonly=withConfig(file);
 const refused=decide(readonly,{op:'api.request',method:'GET',path:'/backend-api/models'});
 expect(refused.outcome).toBe('refuse');
 expect(refused.error!.code).toBe(GATEWAY_FORBIDDEN_CODE);
 expect(refused.configPath).toBe('operations.api.request.permission');
 const unknown=decide(missing(),{op:'zzz.unregistered'});
 expect(unknown.outcome).toBe('refuse');
 expect(unknown.configPath).toBe('unknownOperation');
 expect(unknown.error!.message).toContain('unknownOperation is "forbid"');
 // unknownOperation:'acknowledge' is the only other legal value, and it still demands the key.
 const ack=baseFile();ack.defaults.unknownOperation='acknowledge';
 const acknowledged=decide(withConfig(ack),{op:'zzz.unregistered'});
 expect(acknowledged.outcome).toBe('acknowledge');
 expect(acknowledged.error!.code).toBe(GATEWAY_ACK_CODE);
 expect(decide(withConfig(ack),{op:'zzz.unregistered',args:{allowWrite:true}}).outcome).toBe('allow');
});

test('acknowledgement reproduces the api.request write gate exactly, method for method',()=>{
 const loaded=missing();
 const read=decide(loaded,{op:'api.request',method:'GET',path:'/backend-api/models'});
 expect(read.outcome).toBe('allow');
 expect(read.acknowledge).toMatchObject({key:'allowWrite',flag:'--allow-write',satisfied:false});
 const write=decide(loaded,{op:'api.request',method:'POST',path:'/backend-api/conversation/abc?x=1'});
 expect(write.outcome).toBe('acknowledge');
 expect(write.error).toMatchObject({code:GATEWAY_ACK_CODE,retryable:false});
 expect(write.error!.message).toContain('--allow-write');
 expect(write.error!.message).toContain('/backend-api/conversation/abc');
 expect(write.error!.message).not.toContain('?x=1');
 expect(write.error!.action).toContain('confirm the exact method and path with the account owner');
 expect(write.configPath).toBe('operations.api.request.permission');
 expect(decide(loaded,{op:'api.request',method:'POST',args:{allowWrite:true}}).outcome).toBe('allow');
 expect(decide(loaded,{op:'api.request',method:'post',args:{allowWrite:'yes'}}).outcome).toBe('acknowledge');
 // A profile may demand acknowledgement for sending too, with its own key and flag.
 const file=baseFile();
 file.profiles.careful={operations:{'chat.send':{kind:'generation',permission:'acknowledge',acknowledgeKey:'allowSend',acknowledgeFlag:'--allow-send'}}};
 file.activeProfile='careful';
 const careful=withConfig(file);
 expect(decide(careful,{op:'chat.send'}).error!.message).toContain('--allow-send');
 expect(decide(careful,{op:'chat.send',args:{allowSend:true}}).outcome).toBe('allow');
 expect(decide(careful,{op:'chat.send',args:{allowWrite:true}}).outcome).toBe('acknowledge');
});

test('scopes match by segment, never by a config-supplied regex',()=>{
 const config=BUILTIN_GATEWAY;
 expect(resolveScope(config,'/backend-api/conversation/abc-123')).toBe('/backend-api/conversation/{id}');
 expect(resolveScope(config,'/backend-api/conversation/abc-123?tree=true')).toBe('/backend-api/conversation/{id}');
 expect(resolveScope(config,'/backend-api/conversation/abc/extra')).toBe('*');
 expect(resolveScope(config,'/backend-api/conversation/')).toBe('*');
 expect(resolveScope(config,'/backend-api/conversations')).toBe('/backend-api/conversations');
 expect(resolveScope(config,'/backend-api/gizmos/g-1/conversations')).toBe('/backend-api/gizmos/{id}/conversations');
 expect(resolveScope(config,undefined)).toBe('*');
 expect(resolveScope(config,'/backend-api/unknown/thing')).toBe('*');
 // A friendly alias keeps the same match.
 const aliased={...config,scopeTemplates:[{template:'/backend-api/conversation/{id}',scope:'conversation'}]} as any;
 expect(resolveScope(aliased,'/backend-api/conversation/x')).toBe('conversation');
 // The strictest of scope, kind and operation wins, and a window is compared by rate, not by count.
 expect(strictestRate({minSpacingMs:1000,burst:3},{minSpacingMs:5000,burst:1})).toMatchObject({minSpacingMs:5000,burst:1});
 expect(strictestRate({minSpacingMs:0,maxRequests:10,intervalMs:60000},{minSpacingMs:0,maxRequests:3,intervalMs:300000})).toMatchObject({maxRequests:3,intervalMs:300000});
 expect(strictestRate(undefined,{minSpacingMs:250})).toMatchObject({minSpacingMs:250});
});

test('an active rate-limit deadline travels with the decision instead of being obeyed here',()=>{
 const loaded=missing();
 const until=Date.parse('2026-09-16T04:00:00.000Z');
 const held=decide(loaded,{op:'conversations.get',path:'/backend-api/conversation/abc',state:{rateLimitedUntil:until,limitedScope:'/backend-api/conversation/{id}'}});
 expect(held.outcome).toBe('allow');
 expect(held.notBeforeMs).toBe(until);
 expect(held.reason).toContain('2026-09-16T04:00:00.000Z');
 expect(decide(loaded,{op:'conversations.get',path:'/backend-api/conversation/abc'}).notBeforeMs).toBe(0);
});

test('the engine is pure: no file is created, and the same input gives the same decision',()=>{
 const loaded=withConfig(baseFile());
 const first=decide(loaded,{op:'conversations.get',path:'/backend-api/conversation/abc',now:1},);
 const second=decide(loaded,{op:'conversations.get',path:'/backend-api/conversation/abc',now:999999});
 expect(JSON.stringify(first)).toBe(JSON.stringify(second));
 // Decisions are data: nothing here can act, so a refusal carries its own typed error instead.
 expect(typeof first.reason).toBe('string');
 expect(first.reason).toContain('decided by');
 expect(decisionError(first)).toBeNull();
 // Loading never creates the account directory or the config file.
 expect(existsSync(gatewayConfigPath(ACCOUNT))).toBe(false);
 expect(existsSync(TEST_HOME)?readdirSync(TEST_HOME):[]).toEqual([]);
 // A reader that throws is a refusal, not a crash and not a fallback to "no limits".
 const broken=loadGatewayPolicy(ACCOUNT,()=>{throw new Error('EACCES');});
 expect(broken.status).toBe('invalid');
 expect(decide(broken,{op:'conversations.list'}).error).toMatchObject({code:GATEWAY_INVALID_CODE});
 expect(decide(broken,{op:'freeze.status'}).outcome).toBe('allow');
});
