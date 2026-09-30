import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {localCommands,parseSlash,serviceOperations,slashCommands,tokenizeSlash} from '../src/chatgpt/slash.ts';

test('plain input is not intercepted and a doubled slash sends one literal slash',()=>{
 expect(parseSlash('ordinary message')).toBeNull();
 expect(parseSlash('  ordinary message')).toBeNull();
 expect(parseSlash('//chat send $HOME `whoami`')).toEqual({kind:'message',text:'/chat send $HOME `whoami`'});
 expect(parseSlash('  //help')).toEqual({kind:'message',text:'  /help'});
});

test('tokenizer preserves quoted Unicode, newlines and inert shell syntax',()=>{
 const source='chat send "שלום 🌍\nsecond line" \'$HOME `whoami` $(id)\'';
 expect(tokenizeSlash(source)).toEqual(['chat','send','שלום 🌍\nsecond line','$HOME `whoami` $(id)']);
 expect(parseSlash('/chat send \'$HOME `whoami` $(id)\'')).toEqual({
  kind:'operation',operation:'chat.send',args:{text:'$HOME `whoami` $(id)'}
 });
});

test('canonical dotted and spaced operations use the longest registered match',()=>{
 expect(parseSlash('/audio.output.status')).toEqual({kind:'operation',operation:'audio.output.status',args:{}});
 expect(parseSlash('/audio output status')).toEqual({kind:'operation',operation:'audio.output.status',args:{}});
 expect(parseSlash('/queue')).toEqual({kind:'local',command:'queue',args:{},positionals:[]});
 expect(parseSlash('/queue list')).toEqual({kind:'operation',operation:'queue.list',args:{}});
 expect(parseSlash('/')).toEqual({kind:'local',command:'help',args:{},positionals:[]});
});

test('every service dispatch operation is registered and parses in dot and space forms',()=>{
 const source=readFileSync(join(import.meta.dir,'../src/chatgpt/service.ts'),'utf8');
 const execute=source.slice(source.indexOf('async execute('));
 const dispatched=new Set<string>([...execute.matchAll(/case '([^']+)'/g)].map(match=>match[1]));
 const harnessOperations=[...new Set([...execute.matchAll(/'(harness\.[^']+)'/g)].map(match=>match[1]))];
 expect(harnessOperations).toEqual(['harness.run','harness.test','harness.status','harness.list']);
 for(const op of harnessOperations)dispatched.add(op);
 for(const op of ['browser.start','browser.stop'])dispatched.add(op);
 for(const action of ['list','status','add','edit','remove','reorder','pause','resume','retry','reconcile','run'])dispatched.add('queue.'+action);
 expect(serviceOperations.length).toBeGreaterThan(0);
 expect(serviceOperations.filter(operation=>operation.startsWith('harness.'))).toEqual(['harness.run','harness.test','harness.status','harness.list']);
 expect(serviceOperations.filter(operation=>operation.startsWith('online.'))).toEqual(['online.list','online.status']);
 expect(execute.indexOf("['harness.run','harness.test','harness.status','harness.list'].includes(op)")).toBeLessThan(execute.indexOf("await this.start()"));
 expect(execute.indexOf("['online.list','online.status','receipts.list'")).toBeLessThan(execute.indexOf("await this.start()"));
 expect(execute).toContain("fresh('online-receipts')");
 const cli=readFileSync(join(import.meta.dir,'../bin/chatgpt.ts'),'utf8');
 expect(cli).toContain("'acknowledge','includeRaw'");
 expect(new Set(serviceOperations).size).toBe(serviceOperations.length);
 expect([...serviceOperations].sort()).toEqual([...dispatched].sort());
 for(const operation of serviceOperations){
  expect(parseSlash('/'+operation)).toMatchObject({kind:'operation',operation});
  expect(parseSlash('/'+operation.replaceAll('.',' '))).toMatchObject({kind:'operation',operation});
 }
});

test('online receipt commands remain local and preserve safe lookup arguments',()=>{
 expect(parseSlash('/online list --limit 25')).toEqual({kind:'operation',operation:'online.list',args:{limit:25}});
 expect(parseSlash('/online status api-0123456789abcdef0123456789abcdef01234567')).toEqual({kind:'operation',operation:'online.status',args:{id:'api-0123456789abcdef0123456789abcdef01234567'}});
 expect(parseSlash('/online status --id api-0123456789abcdef0123456789abcdef01234567 --include-raw')).toEqual({kind:'operation',operation:'online.status',args:{id:'api-0123456789abcdef0123456789abcdef01234567',includeRaw:true}});
});

test('harness commands preserve their bounded run and local lookup arguments',()=>{
 expect(parseSlash('/harness list')).toEqual({kind:'operation',operation:'harness.list',args:{}});
 expect(parseSlash('/harness status --run-id run_123')).toEqual({kind:'operation',operation:'harness.status',args:{runId:'run_123'}});
 expect(parseSlash('/harness test --turns 6 --model Latest --effort Instant --timeout 5000')).toEqual({kind:'operation',operation:'harness.test',args:{turns:6,model:'Latest',effort:'Instant',timeout:5000}});
 expect(parseSlash('/harness run --text "compare two plans" --turns 8')).toEqual({kind:'operation',operation:'harness.run',args:{text:'compare two plans',turns:8}});
});

test('the full local registry parses locally and remains represented in completion metadata',()=>{
 expect(new Set(localCommands).size).toBe(localCommands.length);
 for(const command of localCommands)expect(parseSlash('/'+command)).toEqual({kind:'local',command,args:{},positionals:[]});
 expect(parseSlash('/custom "two words" --limit 2',['custom'])).toEqual({kind:'local',command:'custom',args:{limit:2},positionals:['two words']});
 const names=slashCommands().map(item=>item.name);
 expect(names).toEqual([...localCommands,...serviceOperations,'run']);
});

test('positionals map to operation-specific arguments without losing Unicode',()=>{
 expect(parseSlash('/chat send hello שלום')).toEqual({kind:'operation',operation:'chat.send',args:{text:'hello שלום'}});
 expect(parseSlash('/chat new "line one\nline two"')).toEqual({kind:'operation',operation:'chat.new',args:{text:'line one\nline two'}});
 expect(parseSlash('/queue add queued words --new')).toEqual({kind:'operation',operation:'queue.add',args:{new:true,text:'queued words'}});
 expect(parseSlash('/conversations search exact phrase')).toEqual({kind:'operation',operation:'conversations.search',args:{query:'exact phrase'}});
 expect(parseSlash('/conversations open chat-id')).toEqual({kind:'operation',operation:'conversations.open',args:{id:'chat-id',conversation:'chat-id'}});
 expect(parseSlash('/flow run ./plan.json')).toMatchObject({kind:'operation',operation:'flow.run',args:{path:expect.stringContaining('/plan.json')}});
 expect(parseSlash('/settings open Personalization')).toEqual({kind:'operation',operation:'settings.open',args:{section:'Personalization'}});
 expect(parseSlash('/chat model "GPT-5.6 Instant"')).toEqual({kind:'operation',operation:'chat.model',args:{model:'GPT-5.6 Instant'}});
 expect(parseSlash('/audio input ./voice.wav')).toMatchObject({kind:'operation',operation:'audio.input',args:{path:expect.stringContaining('/voice.wav')}});
 const upload=parseSlash('/ui upload "./one image.png" two.wav') as any;
 expect(upload).toMatchObject({kind:'operation',operation:'ui.upload'});
 expect(upload.args.files).toHaveLength(2);
 expect(upload.args.files[0]).toEndWith('/one image.png');
 expect(upload.args.files[1]).toEndWith('/two.wav');
});

test('flags parse numbers, booleans, repeated files and multiline JSON without evaluation',()=>{
 const invocation=parseSlash('/api request --path=/backend-api/test --method POST --timeout 2500 --binary=false --body \'{"text":"שלום\\n$HOME \`whoami\`"}\'') as any;
 expect(invocation).toEqual({kind:'operation',operation:'api.request',args:{
  path:'/backend-api/test',method:'POST',timeout:2500,binary:false,body:{text:'שלום\n$HOME `whoami`'}
 }});
 const queued=parseSlash('/queue add --new --file "./a one.png" --file ./b.wav --text "hello"') as any;
 expect(queued.args.new).toBe(true);
 expect(queued.args.files).toHaveLength(2);
 expect(queued.args.files.every((path:string)=>path.startsWith('/'))).toBe(true);
 expect(parseSlash('/conversations list --all')).toEqual({kind:'operation',operation:'conversations.list',args:{all:true,archived:'all'}});
 expect(parseSlash('/browser start --headed')).toEqual({kind:'operation',operation:'browser.start',args:{headless:false}});
});

test('/run supports explicit future operation names but still parses only data',()=>{
 expect(parseSlash('/run future.experimental --id item-1 --dry-run')).toEqual({
  kind:'operation',operation:'future.experimental',args:{id:'item-1',dryRun:true}
 });
 expect(()=>parseSlash('/run ../bad --id x')).toThrow('explicit operation');
});

test('invalid commands, quoting, options and ambiguous arguments fail closed',()=>{
 for(const input of ['/unknown','/chat send "open','/chat send trailing\\','/chat send --unknown x','/chat send --text','/chat send --binary=maybe','/chat send --timeout NaN','/chat send words --text duplicate','/projects get one two','/browser start --headed --headless','/status --account other']){
  expect(()=>parseSlash(input)).toThrow();
 }
 expect(()=>parseSlash('/queue add --body not-json')).toThrow('--body');
 expect(()=>parseSlash('/queue add --id one --id two')).toThrow('Repeated');
});
