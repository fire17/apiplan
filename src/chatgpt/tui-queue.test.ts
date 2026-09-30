import {expect,test} from 'bun:test';
import {LocalQueue} from './tui-queue.ts';
test('local drafts can be edited, reordered and removed before dequeueing',()=>{
 const queue=new LocalQueue(),first=queue.add('first'),second=queue.add('second');
 queue.edit(second.id,'edited');queue.move(second.id,-1);
 expect(queue.next()?.text).toBe('edited');queue.remove(first.id);expect(queue.next()).toBeUndefined();
});
test('paused local drafts remain unsent and survive state handoff without shared mutations',()=>{
 const queue=new LocalQueue();queue.add('retained');queue.paused=true;expect(queue.next()).toBeUndefined();
 const restored=new LocalQueue();restored.restore(queue.snapshot());
 expect(restored.next()).toBeUndefined();restored.paused=false;expect(restored.next()?.text).toBe('retained');expect(queue.items).toHaveLength(1);
});
test('empty drafts and an overfull local queue are rejected',()=>{
 const queue=new LocalQueue();expect(()=>queue.add(' ')).toThrow('empty');
 for(let i=0;i<50;i++)queue.add(String(i));expect(()=>queue.add('overflow')).toThrow('full');
});

test('first-chat follow-ups bind only after a positive conversation ID and drop creation context',async()=>{const {bindQueuedConversation}=await import('./tui-queue.ts');for(const context of [{new:true},{new:true,project:'project'},{new:true,gpt:'gpt'}]){const items=[{id:'id',text:'follow-up',context,awaitingConversation:true}];bindQueuedConversation(items,'observed-chat');expect(items[0].context).toEqual({conversation:'observed-chat'});expect(items[0].awaitingConversation).toBeUndefined();}});

test('detached first-chat follow-up binds only a complete matching account-bound parent receipt',async()=>{const {completedParentConversation}=await import('./tui-queue.ts');const account={id:'account',userId:'user',workspace:'space'},receipt={id:'parent',operation:'chat.send',account,status:'complete'};expect(completedParentConversation({receipt,result:{conversation:'created-chat'}},account,'parent')).toBe('created-chat');expect(completedParentConversation({receipt:{...receipt,status:'unknown'},result:{conversation:'unproven'}},account,'parent')).toBeUndefined();expect(()=>completedParentConversation({receipt,result:{conversation:'wrong'}},account,'other')).toThrow('does not match');expect(()=>completedParentConversation({receipt:{...receipt,account:{...account,userId:'other'}}},account,'parent')).toThrow('does not match');});
