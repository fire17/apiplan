import {expect,test} from 'bun:test';
import {uncertainDuplicate,reconcileMessages} from './tui-delivery.ts';
test('unconfirmed repeated text and attachments are blocked without blocking a different draft',()=>{
 const messages=[{role:'user',text:'same',files:['/tmp/a.png'],delivery:'unconfirmed'}];
 expect(uncertainDuplicate(messages,'same',['/tmp/a.png'])).toBeTruthy();expect(uncertainDuplicate(messages,'different',['/tmp/a.png'])).toBeUndefined();
});
test('website reconciliation replaces speculative replies and preserves unknown drafts once',()=>{
 const previous=[{role:'user',text:'unknown',delivery:'unconfirmed'},{role:'user',text:'unknown',delivery:'unconfirmed'},{role:'assistant',text:'Response did not complete'}];
 const messages=reconcileMessages(previous,[{id:'actual',role:'user',text:'confirmed'}]);
 expect(messages).toHaveLength(2);expect(messages[1]).toMatchObject({role:'draft',text:'unknown',delivery:'unconfirmed'});expect(uncertainDuplicate(messages,'unknown')).toBeTruthy();
});
test('positive website message identity reconciles its local attempt',()=>{
 expect(reconcileMessages([{id:'known',role:'user',text:'hello',delivery:'unconfirmed'}],[{id:'known',role:'user',text:'hello'}])).toMatchObject([{id:'known',role:'user',text:'hello',timestampSource:'observed'}]);
});

test('interrupted submitted messages survive and matching text alone never proves receipt',()=>{
 const previous=[{role:'user',text:'same',delivery:'submitted',requestId:'pending'},{role:'user',text:'same',delivery:'unconfirmed'},{role:'system',text:'Browser session timed out'},{role:'assistant',text:'Unconfirmed response placeholder'}];
 const result=reconcileMessages(previous,[{id:'website-user',role:'user',text:'same'},{id:'answer',role:'assistant',text:'actual response'}]);
 expect(result).toHaveLength(3);expect(result[2]).toMatchObject({role:'draft',text:'same',delivery:'unconfirmed'});expect(result.filter(message=>message.role==='user')).toHaveLength(1);expect(uncertainDuplicate(result,'same')).toBeTruthy();
});

test('a visible website suffix preserves the confirmed historical prefix',()=>{
 const previous=[{id:'old-user',role:'user',text:'earlier question'},{id:'old-answer',role:'assistant',text:'earlier answer'},{id:'current-user',role:'user',text:'current question',delivery:'unconfirmed'},{role:'assistant',text:'stale placeholder'},{role:'system',text:'connection failed'}];
 const result=reconcileMessages(previous,[{id:'current-user',role:'user',text:'current question'},{id:'current-answer',role:'assistant',text:'streaming response'}]);
 expect(result.map(message=>message.id)).toEqual(['old-user','old-answer','current-user','current-answer']);expect(result.some(message=>message.text==='stale placeholder')).toBe(false);
});
