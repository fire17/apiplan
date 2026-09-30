import {expect,test} from 'bun:test';
import {WebsiteSelection,type SelectionContext} from './tui-model.ts';
import {mockClient} from './tui-mock.ts';
const context:SelectionContext={conversation:'saved-chat',new:false};
test('model and effort changes immediately target the current context and require verification',async()=>{
 const calls:any[]=[];let verified=true;
 const chooser=new WebsiteSelection(async(op,args)=>{calls.push({op,args});return {verified};},()=>context,()=>false);
 expect((await chooser.change('model','Thinking')).label).toBe('Thinking');
 expect(calls[0]).toEqual({op:'chat.model',args:{conversation:'saved-chat',new:false,model:'Thinking'}});
 verified=false;await expect(chooser.change('effort','High')).rejects.toThrow('did not verify');
 expect(chooser.pending).toBe(false);
});
test('rejects overlapping selections and options, then releases the lock on failure',async()=>{
 let reject!:(error:Error)=>void;
 const chooser=new WebsiteSelection(()=>new Promise((_,fail)=>{reject=fail;}),()=>context,()=>false);
 const first=chooser.change('model','Thinking');
 await expect(chooser.change('effort','High')).rejects.toThrow('already in progress');
 await expect(chooser.options()).rejects.toThrow('already in progress');
 reject(new Error('browser failed'));await expect(first).rejects.toThrow('browser failed');
 expect(chooser.pending).toBe(false);
});
test('active generation blocks both selection and picker without stopping it',async()=>{
 let calls=0;
 const chooser=new WebsiteSelection(async()=>{calls++;return {};},()=>context,()=>true);
 await expect(chooser.options()).rejects.toThrow('Stop generation with Ctrl+C');
 await expect(chooser.change('model','Thinking')).rejects.toThrow('Stop generation with Ctrl+C');
 expect(calls).toBe(0);
});
test('options use the latest new, project and GPT context',async()=>{
 let current:SelectionContext={project:'project-1',new:true};const calls:any[]=[];
 const chooser=new WebsiteSelection(async(op,args)=>{calls.push({op,args});return {};},()=>current,()=>false);
 await chooser.options();current={gpt:'gpt-1',new:true};await chooser.options();
 expect(calls).toEqual([{op:'models.options',args:{project:'project-1',new:true}},{op:'models.options',args:{gpt:'gpt-1',new:true}}]);
});
test('offline demo returns verified simulated receipts and retains scoped selections',async()=>{
 const rpc=mockClient();const chooser=new WebsiteSelection(rpc,()=>context,()=>false);
 const receipt=await chooser.change('model','GPT-5.6 Sol');expect(receipt.receipt).toMatchObject({verified:true,simulated:true});
 await chooser.change('effort','High');
 expect((await chooser.options()).current).toEqual({model:'GPT-5.6 Sol',effort:'High',mode:'Chat'});
 expect((await rpc('models.options',{new:true})).current).toEqual({model:'Latest',effort:'Medium',mode:'Chat'});
});

test('Work mode verification exposes its scoped model options',async()=>{
 const rpc=mockClient();const chooser=new WebsiteSelection(rpc,()=>({new:true}),()=>false);
 expect((await chooser.mode('Work')).receipt.verified).toBe(true);
 expect((await chooser.options()).models.some((m:any)=>m.label==='GPT-6 Astra')).toBe(true);
 await chooser.change('model','GPT-6 Astra');
 expect((await chooser.options()).current.model).toBe('GPT-6 Astra');
});
