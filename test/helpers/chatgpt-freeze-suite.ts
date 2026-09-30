import {afterAll,describe,expect,test} from 'bun:test';
import {existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Isolated account home: nothing here touches ~/.apiplan or any browser.
const TEST_HOME=join(tmpdir(),`apiplan-chatgpt-freeze-${process.pid}`);
process.env.CHATGPT_HOME=TEST_HOME;
afterAll(()=>rmSync(TEST_HOME,{recursive:true,force:true}));

const [{readFreeze,setFreeze,freezeFile,allowedWhileFrozen,FREEZE_CODE,ALLOW_WHILE_FROZEN},{BrowserWorker},{ChatGPTService},{parseSlash,localCommands,serviceOperations}]=await Promise.all([
 import('../../src/chatgpt/freeze.ts'),
 import('../../src/chatgpt/transport.ts'),
 import('../../src/chatgpt/service.ts'),
 import('../../src/chatgpt/slash.ts'),
]);

const account={id:'freeze-test',label:'Freeze test',baseURL:'https://chatgpt.com',created:'2026-09-15T00:00:00.000Z',source:{provider:'managed' as const}};

describe('freeze state',()=>{
 test('freeze writes a durable flag with reason, thaw records the thaw time',()=>{
  expect(readFreeze(account).frozen).toBe(false);
  const frozen=setFreeze(account,true,{by:'test',reason:'rate limits'});
  expect(frozen).toMatchObject({frozen:true,by:'test',reason:'rate limits'});
  expect(existsSync(freezeFile(account))).toBe(true);
  expect(JSON.parse(readFileSync(freezeFile(account),'utf8')).frozen).toBe(true);
  // Freezing again keeps the original freeze time and reason.
  const again=setFreeze(account,true,{by:'test2'});
  expect(again.at).toBe(frozen.at);
  expect(again.reason).toBe('rate limits');
  const thawed=setFreeze(account,false,{by:'test'});
  expect(thawed.frozen).toBe(false);
  expect(typeof thawed.thawedAt).toBe('string');
  expect(readFreeze(account).frozen).toBe(false);
  const events=readFileSync(join(TEST_HOME,'accounts','freeze-test','events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(events.map(e=>e.type)).toEqual(['freeze.set','freeze.set','freeze.cleared']);
 });
 test('only activity-reducing worker ops pass while frozen',()=>{
  for(const op of ['status','close','surface.close','snapshot'])expect(allowedWhileFrozen(op)).toBe(true);
  for(const op of ['request','action','goto','upload','surface.open','evaluate','session','snapshot.evaluate'])expect(allowedWhileFrozen(op)).toBe(false);
  expect(allowedWhileFrozen('action',{[ALLOW_WHILE_FROZEN]:true})).toBe(true);
  // The bypass is a Symbol: nothing that arrives as JSON (daemon RPC, slash command, website text) can forge it.
  expect(allowedWhileFrozen('action',{_allowFrozen:true})).toBe(false);
  expect(allowedWhileFrozen('action',JSON.parse('{"'+String(ALLOW_WHILE_FROZEN.description)+'":true}'))).toBe(false);
  expect(allowedWhileFrozen('request',JSON.parse(JSON.stringify({[ALLOW_WHILE_FROZEN]:true})))).toBe(false);
 });
});

describe('BrowserWorker freeze gate (the single choke point)',()=>{
 test('frozen: site-bound calls reject with FROZEN, stop/status pass, launch is refused; thawed: calls flow again',async()=>{
  const worker=new BrowserWorker(account) as any;
  const sent:string[]=[];
  worker.proc={};// pretend a worker process is up
  worker.send=async(_proc:any,op:string)=>{sent.push(op);return {op};};
  setFreeze(account,true,{by:'test'});
  const blocked=await worker.call('request',{path:'/backend-api/conversations'}).catch((e:any)=>e);
  expect(blocked).toBeInstanceOf(Error);
  expect(blocked.code).toBe(FREEZE_CODE);
  expect(blocked.retryable).toBe(false);
  expect(blocked.message).toContain('no request was sent');
  await expect(worker.call('surface.open',{surface:'x',url:'https://chatgpt.com'})).rejects.toMatchObject({code:FREEZE_CODE});
  expect((await worker.call('status')).op).toBe('status');
  expect((await worker.call('action',{kind:'click',[ALLOW_WHILE_FROZEN]:true})).op).toBe('action');
  expect(sent).toEqual(['status','action']);
  // A frozen account never launches a browser (launch opens chatgpt.com tabs).
  worker.proc=undefined;
  await expect(worker.start(true)).rejects.toMatchObject({code:FREEZE_CODE});
  setFreeze(account,false,{by:'test'});
  worker.proc={};
  expect((await worker.call('request',{path:'/backend-api/models'})).op).toBe('request');
 });
});

describe('ChatGPTService freeze operations',()=>{
 test('freeze.set/freeze.status/status never start the browser while frozen; other ops are refused at the start gate',async()=>{
  const svc=new ChatGPTService(account) as any;
  let starts=0;svc.start=async()=>{starts++;throw new Error('start called');};
  const set=await svc.execute('freeze.set',{frozen:true,reason:'test freeze',by:'test'});
  expect(set).toMatchObject({frozen:true,reason:'test freeze'});
  const state=await svc.execute('freeze.status');
  expect(state).toMatchObject({frozen:true,browserRunning:false});
  const status=await svc.execute('status');
  expect(status.frozen).toMatchObject({frozen:true});
  expect(status.browser).toEqual({running:false});
  expect(status.session).toEqual({skipped:'frozen'});
  expect(status.account).toBe('freeze-test');
  expect(starts).toBe(0);
  // A site-bound op hits the start gate, which refuses while frozen before any browser launch.
  // (real BrowserWorker.start: the gate throws before any launch, so no python worker is spawned here)
  svc.start=async()=>{starts++;return svc.browser.start(true);};
  const refused=await svc.execute('conversations.list').catch((e:any)=>e);
  expect(refused).toBeInstanceOf(Error);
  expect(refused.code).toBe(FREEZE_CODE);
  expect(starts).toBe(1);
  expect(svc.browser.running()).toBe(false);
  starts=0;svc.start=async()=>{starts++;throw new Error('start called');};
  // String 'false' from the CLI thaws too.
  expect((await svc.execute('freeze.set',{frozen:'false',by:'test'})).frozen).toBe(false);
  // Once thawed the start gate is live again (our stub proves start() is reached).
  const thawedStatus=await svc.execute('status').catch((e:any)=>e);
  expect(String(thawedStatus?.message)).toContain('start called');
  expect(starts).toBe(1);
  svc.store.close();
 });
});

describe('slash surface',()=>{
 test('/freeze and /thaw are local commands; freeze.set/status are dotted operations',()=>{
  expect(localCommands).toContain('freeze');
  expect(localCommands).toContain('thaw');
  expect(serviceOperations).toContain('freeze.set');
  expect(serviceOperations).toContain('freeze.status');
  expect(parseSlash('/freeze rate limits')).toMatchObject({kind:'local',command:'freeze',positionals:['rate','limits']});
  expect(parseSlash('/thaw')).toMatchObject({kind:'local',command:'thaw'});
  expect(parseSlash('/freeze.status')).toMatchObject({kind:'operation',operation:'freeze.status'});
 });
});

describe('stopping and background work while frozen',()=>{
 test('chat.stop still reaches the website Stop control while frozen (a running worker is not relaunched)',async()=>{
  const svc=new ChatGPTService(account,{autoResume:false}) as any;
  const calls:string[]=[];
  svc.browser.proc={};// the worker is already up, as it would be mid-generation
  svc.browser.send=async(_p:any,op:string,args:any)=>{calls.push(op);return op==='snapshot'?{epoch:1,controls:[{ref:7,name:'Stop answering',testId:'stop-button'}]}:{clicked:true,args};};
  setFreeze(account,true,{by:'test',reason:'panic'});
  const stopped=await svc.execute('chat.stop');
  expect(stopped).toMatchObject({stopped:true});
  expect(calls).toEqual(['snapshot','action']);
  expect(svc.cancelled).toBe(true);
  setFreeze(account,false,{by:'test'});
  svc.store.close();
 });
 test('autoResume:false keeps a local read from waking the background archive writer',async()=>{
  const {atomicJSON,accountDir}=await import('../../src/chatgpt/accounts.ts');
  atomicJSON(join(accountDir(account),'takeout-supervisor.json'),{enabled:true,output:join(TEST_HOME,'archive')});
  const supervised:string[]=[];
  const direct=new ChatGPTService(account,{autoResume:false}) as any;
  direct.superviseTakeout=async()=>{supervised.push('direct');return {};};
  const daemonLike=new ChatGPTService(account) as any;
  daemonLike.superviseTakeout=async()=>{supervised.push('daemon');return {};};
  await new Promise(resolve=>queueMicrotask(()=>queueMicrotask(()=>resolve(null))));
  expect(supervised).not.toContain('direct');
  direct.store.close();daemonLike.store.close();
  atomicJSON(join(accountDir(account),'takeout-supervisor.json'),{enabled:false,output:join(TEST_HOME,'archive')});
 });
});

describe('raw website API passthrough',()=>{
 test('api.request allows reads, refuses an unflagged write, and performs a flagged one',async()=>{
  const svc=new ChatGPTService(account,{autoResume:false}) as any;
  const sent:any[]=[];
  svc.start=async()=>{};
  svc.request=async(path:string,method:string,body:any,binary:boolean)=>{sent.push({path,method,body,binary});return {ok:true};};
  expect(await svc.execute('api.request',{path:'/backend-api/models'})).toEqual({ok:true});
  expect(sent).toEqual([{path:'/backend-api/models',method:'GET',body:undefined,binary:undefined}]);
  const refused=await svc.execute('api.request',{path:'/backend-api/conversation/abc',method:'delete'}).catch((e:any)=>e);
  expect(refused).toBeInstanceOf(Error);
  expect(refused.code).toBe('WRITE_NOT_ALLOWED');
  expect(refused.message).toContain('DELETE /backend-api/conversation/abc');
  expect(sent.length).toBe(1);// nothing reached the website
  await svc.execute('api.request',{path:'/backend-api/conversation/abc',method:'patch',body:{is_visible:false},allowWrite:true});
  expect(sent[1]).toMatchObject({method:'PATCH',path:'/backend-api/conversation/abc'});
  svc.store.close();
 });
});
