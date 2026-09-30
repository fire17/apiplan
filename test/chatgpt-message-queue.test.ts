import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,statSync,readdirSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MessageQueue} from '../src/chatgpt/message-queue.ts';
const account={id:'queue-test',userId:'user-one',workspace:'workspace-one',label:'Queue fixture',baseURL:'https://chatgpt.com',created:''};
const fixture=()=>{const directory=mkdtempSync(join(tmpdir(),'message-queue-'));return {directory,queue:new MessageQueue(account,{directory}),close:()=>rmSync(directory,{recursive:true,force:true})};};

test('private atomic checkpoints preserve explicit context, attachment paths and ordering',()=>{
 const f=fixture();try{const file=join(f.directory,'image.png');writeFileSync(file,'fixture');
 const first=f.queue.add({text:'first',conversation:'chat-1',files:[file]}),second=f.queue.add({text:'second',new:true,project:'project-1'});
 f.queue.reorder(second.id,0);f.queue.edit(first.id,{text:'edited'});
 const next=new MessageQueue(account,{directory:f.directory});expect(next.status().items.map(item=>item.draft.text)).toEqual(['second','edited']);expect(next.status().items[1].draft.files).toEqual([file]);
 expect(statSync(join(f.directory,'queue.json')).mode&0o777).toBe(0o600);expect(statSync(f.directory).mode&0o777).toBe(0o700);expect(readdirSync(f.directory).filter(name=>name.endsWith('.tmp')||name.endsWith('.lock'))).toEqual([]);
 f.queue.remove(second.id);expect(f.queue.status().items).toHaveLength(1);
 }finally{f.close();}
});
test('ambient context and account identity changes are rejected without changing the checkpoint',()=>{
 const f=fixture();try{const before=readFileSync(join(f.directory,'queue.json'),'utf8');
 expect(()=>f.queue.add({text:'no target'})).toThrow('Specify conversation');expect(()=>f.queue.add({text:'two targets',conversation:'x',new:true})).toThrow('one explicit');
 expect(()=>new MessageQueue({...account,userId:'different'},{directory:f.directory})).toThrow('another account');
 expect(readFileSync(join(f.directory,'queue.json'),'utf8')).toBe(before);
 }finally{f.close();}
});
test('runner persists phases before events and passes the stable journal request ID',async()=>{
 const f=fixture();try{const item=f.queue.add({text:'hello',conversation:'chat-1'});f.queue.resume();const phases:string[]=[];
 const result=await f.queue.run(async(args,emit)=>{expect(args.requestId).toBe(item.requestId);expect(f.queue.status().items[0].phase).toBe('submitting');emit({type:'operation.receipt',requestId:args.requestId});emit({type:'submitted',url:'https://chatgpt.com/c/chat-1'});phases.push(f.queue.status().items[0].phase);emit({type:'text',text:'answer'});phases.push(f.queue.status().items[0].phase);return {conversation:'chat-1',text:'answer'};});
 expect(phases).toEqual(['submitted','responding']);expect(result.running).toBe(false);expect(result.items[0]).toMatchObject({phase:'complete',response:'answer',websiteConversation:'chat-1'});expect(result.completedThisRun).toBe(1);
 }finally{f.close();}
});
test('one runner owns execution while other instances can add and pause upcoming drafts',async()=>{
 const f=fixture();try{f.queue.add({text:'first',new:true});f.queue.resume();let release!:(value:any)=>void;let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
 const run=f.queue.run(async()=>{started();return new Promise(resolve=>release=resolve);});await ready;
 const other=new MessageQueue(account,{directory:f.directory});other.add({text:'next',new:true});expect(other.status().running).toBe(true);
 await expect(other.run(async()=>({}))).rejects.toThrow('owns this lock');other.pause();release({text:'done'});await run;
 expect(f.queue.status().items.map(item=>item.phase)).toEqual(['complete','queued']);expect(f.queue.status().paused).toBe(true);
 }finally{f.close();}
});
test('proven non-submission retains a paused draft and explicit retry assigns a new request ID',async()=>{
 const f=fixture();try{const item=f.queue.add({text:'preserve',conversation:'chat'});f.queue.resume();await f.queue.run(async()=>{throw Object.assign(new Error('auth failed'),{code:'NOT_SUBMITTED'});});
 expect(f.queue.status().items[0]).toMatchObject({phase:'not-submitted',draft:{text:'preserve'}});expect(f.queue.status().paused).toBe(true);expect(()=>f.queue.resume()).toThrow('Explicitly retry');
 const retry=f.queue.retry(item.id);expect(retry.requestId).not.toBe(item.requestId);f.queue.resume();await f.queue.run(async()=>({text:'success'}));expect(f.queue.status().items[0].attempts.map(attempt=>attempt.phase)).toEqual(['not-submitted','complete']);
 }finally{f.close();}
});
test('an uncertain submission cannot be edited, retried, removed or blindly resumed',async()=>{
 const f=fixture();try{const item=f.queue.add({text:'one attempt',new:true});f.queue.resume();let calls=0;await f.queue.run(async(_args,emit)=>{calls++;emit({type:'submitted'});throw Object.assign(new Error('timeout'),{code:'NOT_SUBMITTED'});});
 expect(f.queue.status().items[0].phase).toBe('unknown');expect(()=>f.queue.resume()).toThrow('uncertain');expect(()=>f.queue.retry(item.id)).toThrow('proven');expect(()=>f.queue.edit(item.id,{text:'edited',new:true})).toThrow('unsent');expect(()=>f.queue.remove(item.id)).toThrow('reconciled');await f.queue.run(async()=>{calls++;return {};});expect(calls).toBe(1);
 }finally{f.close();}
});
test('a new process identity pauses recovered queued work and marks interrupted sends unknown',()=>{
 const f=fixture();try{const item=f.queue.add({text:'interrupted',new:true});f.queue.add({text:'later',new:true});const path=join(f.directory,'queue.json'),state=JSON.parse(readFileSync(path,'utf8'));state.ownerPid=process.pid+1000000;state.paused=false;state.items[0].phase='responding';state.items[0].attempts=[{requestId:item.requestId,phase:'responding',started:new Date().toISOString()}];writeFileSync(path,JSON.stringify(state));
 const recovered=new MessageQueue(account,{directory:f.directory});expect(recovered.status().paused).toBe(true);expect(recovered.status().items.map(item=>item.phase)).toEqual(['unknown','queued']);expect(()=>recovered.resume()).toThrow('uncertain');
 }finally{f.close();}
});
test('matching positive journal evidence reconciles uncertainty and mismatched evidence cannot',async()=>{
 const f=fixture();try{const item=f.queue.add({text:'uncertain',new:true});f.queue.resume();await f.queue.run(async()=>{throw new Error('disconnected');});
 const receipt={id:item.requestId,operation:'chat.send',account:{id:account.id,userId:account.userId,workspace:account.workspace},status:'complete'};
 expect(()=>f.queue.reconcile(item.id,{receipt:{...receipt,id:'other'}})).toThrow('does not match');expect(()=>f.queue.reconcile(item.id,{receipt:{...receipt,status:'unknown'}})).toThrow('no replay');
 expect(f.queue.reconcile(item.id,{receipt,result:{text:'known answer'}}).phase).toBe('complete');expect(f.queue.status().paused).toBe(true);
 }finally{f.close();}
});
test('checkpoint serialization failures retain the previous complete document',()=>{
 const f=fixture();try{f.queue.add({text:'kept',new:true});const path=join(f.directory,'queue.json'),before=readFileSync(path,'utf8');expect(()=>f.queue.reconcile('missing',{receipt:{}})).toThrow('does not exist');expect(readFileSync(path,'utf8')).toBe(before);JSON.parse(readFileSync(path,'utf8'));}finally{f.close();}
});
test('symlink checkpoints and corrupt locks fail closed without replacing their targets',()=>{
 const f=fixture();try{const path=join(f.directory,'queue.json'),target=join(f.directory,'target');writeFileSync(target,'untouched');rmSync(path);symlinkSync(target,path);expect(()=>f.queue.status()).toThrow('symlinks');expect(readFileSync(target,'utf8')).toBe('untouched');rmSync(path);writeFileSync(join(f.directory,'mutation.lock'),'not-json');expect(()=>f.queue.add({text:'blocked',new:true})).toThrow('ownership');}finally{f.close();}
});

test('a positively dead runner lock recovers without replaying its interrupted job',async()=>{
 const f=fixture();try{const child=Bun.spawn([process.execPath,'-e',''],{stdout:'ignore',stderr:'ignore'});await child.exited;const item=f.queue.add({text:'interrupted',new:true});const path=join(f.directory,'queue.json'),state=JSON.parse(readFileSync(path,'utf8'));state.ownerPid=child.pid;state.paused=false;state.items[0].phase='submitting';state.items[0].attempts=[{requestId:item.requestId,phase:'submitting',started:new Date().toISOString()}];writeFileSync(path,JSON.stringify(state));writeFileSync(join(f.directory,'runner.lock'),JSON.stringify({pid:child.pid,token:'dead-fixture',created:new Date().toISOString()}));
 const recovered=new MessageQueue(account,{directory:f.directory});let calls=0;await recovered.run(async()=>{calls++;return {};});expect(calls).toBe(0);expect(recovered.status().items[0].phase).toBe('unknown');expect(readdirSync(f.directory)).not.toContain('runner.lock');
 }finally{f.close();}
});
test('missing attachment is proven not-submitted before invoking the injected sender',async()=>{
 const f=fixture();try{f.queue.add({text:'file',new:true,files:[join(f.directory,'missing.wav')]});f.queue.resume();let calls=0;await f.queue.run(async()=>{calls++;return {};});expect(calls).toBe(0);expect(f.queue.status().items[0].phase).toBe('not-submitted');}finally{f.close();}
});
test('unserializable sender completion leaves a valid uncertain checkpoint',async()=>{
 const f=fixture();try{f.queue.add({text:'keep receipt boundary',new:true});f.queue.resume();await f.queue.run(async()=>({unsupported:1n}));const saved=JSON.parse(readFileSync(join(f.directory,'queue.json'),'utf8'));expect(saved.items[0].phase).toBe('unknown');expect(saved.paused).toBe(true);expect(readdirSync(f.directory).some(name=>name.endsWith('.tmp'))).toBe(false);}finally{f.close();}
});


test('lost add response retries preserve one item through reopen, edit and completion',async()=>{
 const f=fixture();try{
  const draft={text:'one intention',new:true};const first=f.queue.add(draft,'tui:stable-1');
  const reopened=new MessageQueue(account,{directory:f.directory});expect(reopened.add(draft,'tui:stable-1').id).toBe(first.id);
  reopened.edit(first.id,{text:'edited intentionally'});expect(reopened.add(draft,'tui:stable-1').draft.text).toBe('edited intentionally');
  expect(()=>reopened.add({...draft,text:'different'},'tui:stable-1')).toThrow('different draft');
  reopened.resume();let sends=0;await reopened.run(async()=>{sends++;return {text:'done'};});
  expect(reopened.add(draft,'tui:stable-1').phase).toBe('complete');await reopened.run(async()=>{sends++;return {};});expect(sends).toBe(1);expect(reopened.status().items).toHaveLength(1);
  reopened.remove(first.id);expect(()=>reopened.add(draft,'tui:stable-1')).toThrow('will not be recreated');expect(reopened.status().items).toHaveLength(0);
 }finally{f.close();}
});
test('client keys are explicit, bounded and safe for object property names',()=>{
 const f=fixture();try{for(const id of ['', 'bad key', 'x'.repeat(201)])expect(()=>f.queue.add({text:'x',new:true},id)).toThrow('clientId');
 const a=f.queue.add({text:'x',new:true},'constructor');expect(f.queue.add({new:true,text:'x'},'constructor').id).toBe(a.id);
 expect(f.queue.add({text:'x',new:true}).id).not.toBe(a.id);
 }finally{f.close();}
});

test('external runner checkpoints live thinking and media for another TUI reader',async()=>{
 const f=fixture();try{f.queue.add({text:'multimodal',conversation:'chat'});f.queue.resume();await f.queue.run(async(_args,emit)=>{
  emit({type:'submitted'});emit({type:'thinking',active:true,items:[{id:'thinking',title:'Inspecting image',text:'Expanded observation',expanded:true}]});emit({type:'media',items:[{id:'asset',kind:'image',reference:'file-service://asset'}]});emit({type:'text',text:'live answer'});
  const other=new MessageQueue(account,{directory:f.directory});const item=other.status().items[0];expect(item.response).toBe('live answer');expect(item.thinking?.[0]).toMatchObject({id:'thinking',title:'Inspecting image',text:'Expanded observation',expanded:true});expect(item.media).toEqual([{id:'asset',kind:'image',reference:'file-service://asset'}]);return {text:'done'};
 });expect(new MessageQueue(account,{directory:f.directory}).status().items[0].media?.[0].id).toBe('asset');
 }finally{f.close();}
});

test('persisted destination corruption fails before any sender and preserves the original checkpoint',async()=>{
 const f=fixture();try{f.queue.add({text:'never ambient',new:true});const path=join(f.directory,'queue.json'),saved=JSON.parse(readFileSync(path,'utf8'));delete saved.items[0].draft.new;saved.paused=false;const damaged=JSON.stringify(saved);writeFileSync(path,damaged);let sends=0;
  expect(()=>new MessageQueue(account,{directory:f.directory})).toThrow('invalid destination');
  await expect(f.queue.run(async()=>{sends++;return {};})).rejects.toThrow('invalid destination');expect(sends).toBe(0);expect(readFileSync(path,'utf8')).toBe(damaged);
 }finally{f.close();}
});
