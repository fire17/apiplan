import {afterAll,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const home=mkdtempSync(join(tmpdir(),'queue-service-'));process.env.CHATGPT_HOME=home;
afterAll(()=>rmSync(home,{recursive:true,force:true}));
const {ChatGPTService}=await import('../../src/chatgpt/service.ts');
const {OperationJournal}=await import('../../src/chatgpt/receipts.ts');
function fixture(){const calls:any[]=[];const service=Object.create(ChatGPTService.prototype);service.account={id:crypto.randomUUID(),userId:'fixture-user',label:'test',baseURL:'https://chatgpt.com',created:''};service.start=()=>{throw new Error('Unexpected browser startup');};service.dispatch=async(op:string,args:any,emit:any)=>{calls.push({op,args});emit({type:'operation.receipt',requestId:args.requestId});emit({type:'submitted'});emit({type:'text',text:'Fixture answer'});return {conversation:'fixture-chat',text:'Fixture answer'};};return {service,calls,run:(op:string,args:any={})=>service.execute('queue.'+op,args)};}
test('local commands preserve context and never start browser; only explicit run sends',async()=>{const f=fixture();const a=await f.run('add',{text:'one',conversation:'chat'}),id=a.item.id;await f.run('add',{text:'two',new:true,project:'project'});await f.run('edit',{id,text:'edited'});await f.run('reorder',{id,index:1});expect((await f.run('list')).items[1].draft).toMatchObject({text:'edited',conversation:'chat'});expect((await f.run('run')).completedThisRun).toBe(0);await f.run('resume');expect(f.calls).toHaveLength(0);const result=await f.run('run',{maxItems:1});expect(result.completedThisRun).toBe(1);expect(f.calls[0]).toMatchObject({op:'chat.send',args:{new:true,project:'project',text:'two'}});expect(f.calls[0].args.requestId).toBe(result.items[0].requestId);await f.run('pause');await f.run('remove',{id});expect((await f.run('status')).items).toHaveLength(1);});
test('unknown outcomes never replay and caller receipt bodies cannot forge reconciliation',async()=>{const f=fixture();f.service.dispatch=async()=>{f.calls.push('attempt');throw new Error('lost reply');};const added=await f.run('add',{text:'uncertain',new:true});await f.run('resume');const result=await f.run('run');expect(result.items[0].phase).toBe('unknown');await expect(f.run('resume')).rejects.toMatchObject({code:'NEEDS_RECONCILIATION'});await f.run('run');expect(f.calls).toHaveLength(1);await expect(f.run('reconcile',{id:added.item.id,body:{receipt:{status:'complete'}}})).rejects.toThrow();expect((await f.run('status')).items[0].phase).toBe('unknown');});
test('reconciliation reads the matching operation journal; retry requires a new ID',async()=>{const f=fixture();const added=await f.run('add',{text:'prepare',new:true});f.service.dispatch=async(op:string,args:any)=>{const journal=new OperationJournal(f.service.account);journal.start(op,args);journal.fail(args.requestId,{code:'NOT_SUBMITTED'});throw Object.assign(new Error('preparation failed'),{code:'NOT_SUBMITTED'});};await f.run('resume');await f.run('run');const reconciled=await f.run('reconcile',{id:added.item.id});expect(reconciled.item.phase).toBe('not-submitted');const retry=await f.run('retry',{id:added.item.id});expect(retry.item.requestId).not.toBe(added.item.requestId);expect(retry.paused).toBe(true);});
test('unbound account and invalid operations fail without browser access',async()=>{const f=fixture();delete f.service.account.userId;await expect(f.run('add',{text:'x',new:true})).rejects.toMatchObject({code:'ACCOUNT_IDENTITY_REQUIRED'});await expect(f.run('typo')).rejects.toMatchObject({code:'QUEUE_OPERATION_UNKNOWN'});});

test('full dispatch journals busy and empty drafts as not-submitted without clearing another operation',async()=>{
 const f=fixture();f.service.runtimeGate={check:async()=>{}};f.service.start=async()=>{};f.service.dispatch=ChatGPTService.prototype.dispatch;
 f.service.busy=true;const busyId=crypto.randomUUID();await expect(f.service.dispatch('chat.send',{text:'blocked',requestId:busyId})).rejects.toMatchObject({code:'NOT_SUBMITTED'});expect(f.service.busy).toBe(true);expect(new OperationJournal(f.service.account).get(busyId).receipt.status).toBe('not-submitted');
 f.service.busy=false;const emptyId=crypto.randomUUID();await expect(f.service.dispatch('chat.send',{requestId:emptyId})).rejects.toMatchObject({code:'NOT_SUBMITTED'});expect(new OperationJournal(f.service.account).get(emptyId).receipt.status).toBe('not-submitted');
});

test('service passes stable clientId and rejects changed payload without another add or send',async()=>{
 const f=fixture(),args={text:'migrated draft',conversation:'chat',clientId:'tui:migration-1'};
 const a=await f.run('add',args),b=await f.run('add',args);expect(b.item.id).toBe(a.item.id);expect(b.items).toHaveLength(1);expect(b.paused).toBe(true);
 await expect(f.run('add',{...args,text:'changed'})).rejects.toMatchObject({code:'QUEUE_CLIENT_ID_MISMATCH'});expect(f.calls).toHaveLength(0);
});

test('task service stores complete coverage and preserves actual task_id fields',async()=>{
 const f=fixture(),paths:string[]=[],receipts:any[]=[];f.service.start=async()=>{};
 f.service.request=async(path:string)=>{paths.push(path);return paths.length===1?{tasks:[{task_id:'a',status:'interrupted'}],cursor:'next/+='}:{tasks:[{task_id:'b',extra:{preserved:true}}],cursor:null};};
 f.service.store={receipt:(r:any)=>receipts.push(r)};
 const result=await f.service.execute('tasks.list',{maxPages:2});expect(result.complete).toBe(true);expect(result.items.map((t:any)=>t.task_id)).toEqual(['a','b']);expect(result.items[1].extra).toEqual({preserved:true});expect(paths[1]).toContain('cursor=next%2F%2B%3D');expect(receipts).toEqual([result.coverage]);
});
