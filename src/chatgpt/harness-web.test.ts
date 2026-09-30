import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readdirSync,statSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamToolParser} from './harness-protocol.ts';
import {WebsiteHarnessDriver,extractHarnessProtocolText,passiveDisplayText,waitHarnessSurfaceReady} from './harness-web.ts';
import {OperationJournal} from './receipts.ts';
import {ALLOW_WHILE_FROZEN} from './freeze.ts';
const account={id:'fixture',label:'Fixture',userId:'user-fixture',baseURL:'https://chatgpt.com',cdpURL:'http://127.0.0.1:9222',transportMode:'attached' as const,created:''};
function fixture(options:{identity?:string;unverified?:boolean;unknown?:boolean;wait?:Promise<void>;protocol?:string;display?:string;passiveText?:string;syncDisplays?:string[]}={}){
 const directory=mkdtempSync(join(tmpdir(),'harness-web-')),calls:any[]=[],surfaces=new Map<string,string>();let counter=0,readReceipt:any,currentMessage:any,receiptSeen=false;
 const worker={async start(){calls.push(['start']);},async close(){calls.push(['close']);},async call(op:string,args:any={}){calls.push([op,args]);if(op==='generation.receipt'){receiptSeen=true;return options.passiveText?{authoritative:true,text:options.passiveText,conversation:surfaces.get(args.surface)?.split('/c/')[1],sequence:1,source:'observed page generation response',additionalRequests:0,messages:[{id:'assistant-protocol',role:'assistant',status:'finished_successfully',text:options.passiveText}]}:{authoritative:false};}if(op==='session')return {authenticated:true,user:{id:options.identity||account.userId}};if(op==='surface.open'){surfaces.set(args.surface,args.url);return {...args,rendering:{enabled:true,visibilityState:'visible',hidden:false,focused:true}};}if(op==='surface.close'){surfaces.delete(args.surface);return {closed:true};}const takeSnapshot=()=>{if(receiptSeen&&options.syncDisplays?.length&&currentMessage)currentMessage.text=options.syncDisplays.shift();return {url:surfaces.get(args.surface),controls:[{id:'prompt-textarea'},{role:'radio',name:'Chat'},{role:'radio',name:'Work'}],messages:currentMessage?[currentMessage]:[],media:[],text:'',title:'',epoch:'fixture'};};if(op==='snapshot')return takeSnapshot();if(op==='snapshot.evaluate'){new Function('return ('+args.expression+')');const snapshot=takeSnapshot();return {snapshot,value:{url:snapshot.url,visibilityState:'visible',hidden:false,messages:currentMessage?[{id:currentMessage.id,domTurnId:currentMessage.domTurnId,protocolText:options.protocol||'',protocolSource:'semantic-dom'}]:[]}};}throw new Error(op);}};
 const dependencies={worker:()=>worker,actions:(proxy:any,read:any)=>{readReceipt=read;return {idle:()=>proxy.call('snapshot'),snapshot:()=>proxy.call('snapshot'),async mode(value:string){calls.push(['mode',value]);return {verified:!options.unverified,selected:value};},async choose(kind:string,value:string){calls.push([kind,value]);return {verified:!options.unverified,selected:value};},async composer(text:string){calls.push(['composer',text]);},async submit(){calls.push(['submit']);if(options.unknown)throw new Error('Submit timed out');},async waitReply(before:any,emit:any){await options.wait;const surface=[...surfaces.entries()].find(([,url])=>url===before.url)?.[0];const conversation=before.url.match(/\/c\/([^/]+)/)?.[1]||'conversation-'+(++counter),url='https://chatgpt.com/c/'+conversation;if(surface)surfaces.set(surface,url);if(options.protocol!==undefined){currentMessage={id:'assistant-protocol',role:'assistant',text:options.display||'Displayed reply'};await proxy.call('snapshot');}emit({type:'submitted',verified:true,url,messages:[{id:'user-'+counter}]});if(options.passiveText)await proxy.call('snapshot');emit({type:'thinking',items:[{id:'thought',title:'Fixture thought'}]});emit({type:'text',text:'Fixture reply'});emit({type:'media',items:[{src:'https://chatgpt.com/fixture.png'}]});return {text:options.display||'Fixture reply',url,conversation,messages:[{id:'reply'}]};}};}};
 return {directory,calls,dependencies,getRead:()=>readReceipt,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
test('isolated driver reuses agent surface, streams evidence and disables bulk receipt fallback',async()=>{
 const f=fixture(),events:any[]=[],driver=new WebsiteHarnessDriver(account,{directory:f.directory,emit:e=>events.push(e)},f.dependencies);
 try{const first=await driver.send({id:'one',name:'One'},'First');const second=await driver.send({id:'one',name:'One'},'Second');expect(second.conversation).toBe(first.conversation);expect(f.calls.filter(c=>c[0]==='surface.open')).toHaveLength(1);expect(f.calls.filter(c=>c[0]==='mode')).toEqual([['mode','Chat']]);expect(f.calls.filter(c=>c[0]==='model')).toEqual([['model','Latest']]);expect(f.calls.filter(c=>c[0]==='effort')).toEqual([['effort','Instant']]);expect(events.map(e=>e.type)).toEqual(expect.arrayContaining(['submitted','thinking','text','media']));expect(first.driver.submission.verified).toBe(true);expect(first.driver.identity.userId).toBe(account.userId);expect(first.driver.browserOwned).toBe(false);expect(new OperationJournal(account,{directory:join(f.directory,'receipts')}).get(second.requestId).receipt.status).toBe('complete');expect(statSync(join(f.directory,'receipts',second.requestId+'.json')).mode&0o777).toBe(0o600);await expect(f.getRead()('/backend-api/conversation/test')).rejects.toThrow('429');expect(f.calls.some(c=>c[0]==='request'||c[0]==='goto')).toBe(false);await driver.close();expect(f.calls.filter(c=>c[0]==='surface.close')).toHaveLength(1);expect(f.calls.at(-1)[0]).toBe('close');}finally{await driver.close();f.cleanup();}
});
test('uncertain submit blocks same agent after driver recreation and never submits again',async()=>{
 const f=fixture({unknown:true}),driver=new WebsiteHarnessDriver(account,{directory:f.directory},f.dependencies);
 try{await expect(driver.send({id:'one',name:'One'},'First')).rejects.toMatchObject({code:'OUTCOME_UNKNOWN',submissionState:'unknown'});const diagnosticFile=readdirSync(f.directory).find(name=>name.endsWith('.diagnostic.json'));expect(diagnosticFile).toBeDefined();const diagnostic=JSON.parse(readFileSync(join(f.directory,diagnosticFile!),'utf8'));expect(diagnostic.lastObserved.messageMetadata).toEqual([]);expect(diagnostic.coverage).toContain('no conversation text');await driver.close();const replacement=new WebsiteHarnessDriver(account,{directory:f.directory},f.dependencies);try{await expect(replacement.send({id:'one',name:'One'},'First')).rejects.toMatchObject({code:'NEEDS_RECONCILIATION'});expect(f.calls.filter(c=>c[0]==='submit')).toHaveLength(1);}finally{await replacement.close();}}finally{await driver.close();f.cleanup();}
});
test('identity mismatch journals non-submission without opening an agent or writing composer',async()=>{
 const f=fixture({identity:'different-user'}),driver=new WebsiteHarnessDriver(account,{directory:f.directory},f.dependencies);
 try{await expect(driver.send({id:'one',name:'One'},'First')).rejects.toMatchObject({code:'ACCOUNT_MISMATCH',submissionState:'not-submitted'});expect(f.calls.some(c=>['submit','composer','surface.open'].includes(c[0]))).toBe(false);expect(new OperationJournal(account,{directory:join(f.directory,'receipts')}).list().items[0].status).toBe('not-submitted');}finally{await driver.close();f.cleanup();}
});
test('unverified model settings fail before submission and clean up only owned surface',async()=>{
 const f=fixture({unverified:true}),driver=new WebsiteHarnessDriver(account,{directory:f.directory},f.dependencies);
 try{await expect(driver.send({id:'one',name:'One'},'First')).rejects.toMatchObject({code:'NOT_SUBMITTED'});expect(f.calls.some(c=>['composer','submit'].includes(c[0]))).toBe(false);expect(f.calls.filter(c=>c[0]==='surface.close')).toHaveLength(1);}finally{await driver.close();f.cleanup();}
});
test('same-agent concurrency rejects while independent agents can start their own turns',async()=>{
 let release!:()=>void;const f=fixture({wait:new Promise<void>(resolve=>release=resolve)}),driver=new WebsiteHarnessDriver(account,{directory:f.directory},f.dependencies);
 try{const first=driver.send({id:'one',name:'One'},'First');await expect(driver.send({id:'one',name:'One'},'Duplicate')).rejects.toMatchObject({code:'AGENT_BUSY'});const second=driver.send({id:'two',name:'Two',parentId:'one'},'Second');for(let i=0;i<100&&f.calls.filter(c=>c[0]==='submit').length<2;i++)await Bun.sleep(5);expect(f.calls.filter(c=>c[0]==='submit')).toHaveLength(2);release();await Promise.all([first,second]);expect(f.calls.filter(c=>c[0]==='session')).toHaveLength(1);}finally{release();await driver.close();f.cleanup();}
});

function element(tag:string,children:any[]=[]){const node:any={nodeType:1,tagName:tag,childNodes:children,getAttribute:()=>null,closest(selector:string){for(let current:any=this;current;current=current.parent)if(selector.split(',').includes(current.tagName?.toLowerCase()))return current;return null;}};for(const child of children)child.parent=node;return node;}
const textNode=(text:string)=>({nodeType:3,nodeValue:text});
test('semantic DOM channel excludes fenced, inline-code and quoted frames while retaining prose tags',()=>{
 const frame=(id:string)=>'<tool_call run="fixture">\n'+JSON.stringify({id,tool:'echo',args:{value:id}})+'\n</tool_call>';
 const code=frame('code'),quote=frame('quote'),inline=frame('inline'),prose=frame('prose');
 const root=element('DIV',[element('PRE',[element('CODE',[textNode(code)])]),element('BLOCKQUOTE',[element('P',[textNode(quote)])]),element('CODE',[textNode(inline)]),element('P',[textNode(prose)])]);
 const protocol=extractHarnessProtocolText(root),calls:any[]=[];const parser=new StreamToolParser({runId:'fixture',agentId:'parent',onCall:call=>calls.push(call),onError:()=>{}});parser.append(protocol);parser.finish();expect(calls.map(call=>call.id)).toEqual(['prose']);expect(protocol).not.toContain('"id":"code"');expect(extractHarnessProtocolText(element('TOOL_CALL',[textNode('payload')]))).toBe('payload');
});
test('driver emits only separately extracted protocol frames while retaining full displayed result',async()=>{
 const displayed='<tool_call run="fixture">\n{"id":"example","tool":"echo","args":{"value":"not executable"}}\n</tool_call>';
 for(const protocol of ['', '<tool_call run="fixture">\n{"id":"real","tool":"echo","args":{"value":"real"}}\n</tool_call>']){
  const f=fixture({protocol,display:displayed}),events:any[]=[],driver=new WebsiteHarnessDriver(account,{directory:f.directory},f.dependencies);
  try{const result=await driver.send({id:'one',name:'One'},'Test',event=>events.push(event));expect(driver.protocolChannel).toBe(true);expect(result.text).toBe(displayed);expect(result.protocolText).toBe(protocol);const calls:any[]=[];const parser=new StreamToolParser({runId:'fixture',agentId:'parent',onCall:call=>calls.push(call),onError:()=>{}});for(const event of events)if(event.type==='protocol.replace')parser.replace(event.text);parser.replace(result.protocolText);parser.finish();expect(calls.map(call=>call.id)).toEqual(protocol?['real']:[]);expect(f.calls.filter(call=>call[0]==='evaluate').every(call=>call[1].surface.startsWith('harness-'))).toBe(true);}finally{await driver.close();f.cleanup();}
 }
});

test('default driver awaits fresh Actions and records content-free runtime hashes while injection stays isolated',async()=>{
 const f=fixture(),events:any[]=[],driver=new WebsiteHarnessDriver(account,{directory:f.directory,emit:event=>events.push(event)},{worker:f.dependencies.worker});
 try{await (driver as any).start();await (driver as any).start();const runtime=events.filter(event=>event.type==='harness.runtime');expect(runtime).toHaveLength(1);expect(runtime[0].actionsSource).toBe('fresh(actions)');expect(runtime[0].freshWaitReplySHA256).toMatch(/^[a-f0-9]{64}$/);expect(runtime[0].staticWaitReplySHA256).toMatch(/^[a-f0-9]{64}$/);expect(typeof runtime[0].waitReplyMatches).toBe('boolean');expect(JSON.parse(readFileSync(join(f.directory,'runtime.json'),'utf8')).freshWaitReplySHA256).toBe(runtime[0].freshWaitReplySHA256);expect(f.calls.filter(call=>call[0]==='start')).toHaveLength(1);}finally{await driver.close();f.cleanup();}
});

test('snapshot epoch/URL races reacquire only reads and return the consistent newer snapshot',async()=>{
 const f=fixture(),calls:string[]=[],events:any[]=[];let reads=0;
 const worker={async start(){},async close(){},async call(op:string){calls.push(op);if(op==='snapshot.evaluate'){const snapshot={epoch:'epoch-'+(++reads),url:'https://chatgpt.com/c/final',messages:[]};if(reads<3)throw new Error('Error: Harness protocol snapshot changed before semantic extraction.');return {snapshot,value:{url:snapshot.url,messages:[]}};}throw new Error('Unexpected write '+op);}};
 const driver=new WebsiteHarnessDriver(account,{directory:f.directory,emit:event=>events.push(event)},{worker:()=>worker});
 try{const snapshot=await (driver as any).readProtocolSnapshot('harness-fixture');expect(snapshot.epoch).toBe('epoch-3');expect(calls).toEqual(['snapshot.evaluate','snapshot.evaluate','snapshot.evaluate']);expect(events.filter(event=>event.type==='harness.snapshot.retry')).toHaveLength(2);}finally{await driver.close();f.cleanup();}
});
test('snapshot race retries are bounded and unrelated extraction errors never retry',async()=>{
 for(const message of ['Harness protocol snapshot changed before semantic extraction.','Unexpected semantic extraction failure']){
  const f=fixture();let reads=0;const worker={async start(){},async close(){},async call(op:string){if(op!=='snapshot.evaluate')throw new Error('Unexpected write '+op);reads++;throw new Error(message);}};
  const driver=new WebsiteHarnessDriver(account,{directory:f.directory},{worker:()=>worker});try{await expect((driver as any).readProtocolSnapshot('harness-fixture')).rejects.toThrow(message);expect(reads).toBe(message.startsWith('Harness protocol')?4:1);}finally{await driver.close();f.cleanup();}
 }
});

test('passive completion is bound to submitted user and never executes recovered fenced text',async()=>{
 const recovered='```xml\n<tool_call run="fixture">\n{"id":"inert","tool":"echo","args":{"value":1}}\n</tool_call>\n```';
 const f=fixture({protocol:'',display:recovered.replace(/^```xml\n|\n```$/g,''),passiveText:recovered}),events:any[]=[],driver=new WebsiteHarnessDriver(account,{directory:f.directory},f.dependencies);
 try{const result=await driver.send({id:'one',name:'One'},'First',event=>events.push(event));expect(result.authoritativeText).toBe(recovered);expect(result.displayText).toBe(result.text);expect(result.protocolText).toBe('');expect(result.generationReceipt.authoritative).toBe(true);expect(f.calls.find(call=>call[0]==='generation.receipt')[1].userIds).toEqual(['user-1']);expect(f.calls.filter(call=>call[0]==='submit')).toHaveLength(1);expect(events.some(event=>event.type==='replace'&&event.text===result.displayText)).toBe(true);}finally{await driver.close();f.cleanup();}
});
test('explicit Work mode is verified on new agents while Chat remains the default',async()=>{
 const f=fixture(),driver=new WebsiteHarnessDriver(account,{directory:f.directory,mode:'Work',model:'GPT-6 Astra',effort:'Light'},f.dependencies);
 try{const result=await driver.send({id:'one',name:'One'},'Fixture');expect(result.driver.selection.mode.selected).toBe('Work');expect(f.calls.filter(call=>call[0]==='mode')).toEqual([['mode','Work']]);expect(result.driver.selection.model.selected).toBe('GPT-6 Astra');}finally{await driver.close();f.cleanup();}
});

test('passive final display requires exact assistant binding and complete rendered frame, preserving Markdown separation',()=>{
 const frame='<tool_call run="fixture">{"id":"real"}</tool_call>';
 const receipt={messages:[{id:'final',text:'**Hello** world\n'+frame}]};
 const snap=(text:string,id='final',protocolSource='semantic-dom')=>({messages:[{id,role:'assistant',text,protocolText:frame,protocolSource}]});
 expect(passiveDisplayText(snap('Hello world\n'+frame.slice(0,-4)),receipt)).toBeUndefined();
 expect(passiveDisplayText(snap('Hello world\n'+frame,'wrong'),receipt)).toBeUndefined();
 expect(passiveDisplayText(snap('Hello world\n'+frame,'final','unresolved-dom'),receipt)).toBeUndefined();
 expect(passiveDisplayText(snap('Hello world\n'+frame),receipt)).toBe('Hello world\n'+frame);
 expect(passiveDisplayText(snap('Hello'),{messages:[{id:'final',text:'Hello world'}]})).toBeUndefined();
});

test('passive completion reacquires delayed full DOM before final protocol, with one submission',async()=>{
 const frame='<tool_call run="fixture">{"id":"real","tool":"echo","args":{}}</tool_call>';
 const f=fixture({protocol:frame,display:'Partial',passiveText:frame,syncDisplays:['Still partial',frame]}),events:any[]=[],driver=new WebsiteHarnessDriver(account,{directory:f.directory},f.dependencies);
 try{const result=await driver.send({id:'one',name:'One'},'First',event=>events.push(event));expect(result.text).toBe(frame);expect(result.protocolText).toBe(frame);expect(result.authoritativeText).toBe(frame);expect(f.calls.filter(call=>call[0]==='submit')).toHaveLength(1);expect(f.calls.filter(call=>call[0]==='generation.receipt')).toHaveLength(1);}finally{await driver.close();f.cleanup();}
});
test('cancellation is terminal and stops only an observed owned active surface once',async()=>{
 const f=fixture(),calls:any[]=[];let stopped=false;
 const worker={async start(){},async close(){calls.push(['close']);},async call(op:string,args:any){calls.push([op,args]);if(op==='snapshot')return {epoch:'current',controls:stopped?[]:[{testId:'stop-button',ref:'stop-ref'}]};if(op==='action'){stopped=true;return {};}if(op==='surface.close')return {};throw new Error(op);}};
 const driver=new WebsiteHarnessDriver(account,{directory:f.directory},{worker:()=>worker});
 (driver as any).surfaces.set('one',{surface:'harness-owned',state:{phase:'submitted'}});(driver as any).active.add('one');
 try{const result=await driver.cancel();expect(result.results[0].confirmed).toBe(true);await driver.cancel();await expect(driver.send({id:'two',name:'Two'},'Never')).rejects.toMatchObject({code:'HARNESS_CLOSED'});await driver.close();expect(calls.filter(call=>call[0]==='action')).toEqual([['action',{surface:'harness-owned',epoch:'current',ref:'stop-ref',kind:'click',[ALLOW_WHILE_FROZEN]:true}]]);}finally{await driver.close();f.cleanup();}
});

test('homepage readiness tolerates delayed hydration beyond15s but preserves requested mode verification',async()=>{
 let time=0,reads=0;const composer={id:'prompt-textarea'};
 const result=await waitHarnessSurfaceReady(async()=>{reads++;return {controls:time<18000?[composer]:[composer,{role:'radio',name:'Chat'}]};},'Chat',false,{now:()=>time,sleep:async ms=>{time+=ms;}});
 expect(result.composerReady).toBe(true);expect(result.requestedModeReady).toBe(true);expect(time).toBe(18000);expect(reads).toBeGreaterThan(100);
 time=0;await expect(waitHarnessSurfaceReady(async()=>({controls:[composer,{role:'radio',name:'Work'}]}),'Chat',false,{now:()=>time,sleep:async ms=>{time+=ms;}})).rejects.toMatchObject({code:'HARNESS_PREPARATION_TIMEOUT',preparation:{composerReady:true,requestedModeReady:false,requestedMode:'Chat'}});expect(time).toBe(45000);
});
