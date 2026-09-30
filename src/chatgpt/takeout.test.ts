import {test,expect,afterAll} from 'bun:test';
import {existsSync,mkdtempSync,readFileSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {TakeoutService} from './takeout.ts';

// Isolated account home: these tests never read, write or even touch the real ~/.apiplan archive.
const TEST_HOME=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-takeout-unit-'));
process.env.CHATGPT_HOME=TEST_HOME;
afterAll(()=>rmSync(TEST_HOME,{recursive:true,force:true}));
const {exportMedia}=await import('./media.ts');
const {runTakeout,auditTakeout,mediaReferences,conversationBudget,DEFAULT_CONVERSATION_READS}=await import('./takeout.ts');
const tree={id:'one',current_node:'b',mapping:{root:{parent:null,children:['a','b'],message:null},a:{parent:'root',children:[],message:{content:{parts:['alternative']}}},b:{parent:'root',children:[],message:{content:{parts:['selected',{asset_pointer:'file-service://asset'}]}}}}};
function fixture():TakeoutService & {calls:number}{return {calls:0,account:{id:'test',userId:'u',label:'Test',baseURL:'https://chatgpt.com',created:'now'},async conversations(){return {items:[{id:'one'}],complete:true,coverage:[]};},async conversation(){this.calls++;return tree;},async request(){return {};},async dispatch(op){if(op==='projects.list'||op==='gpts.list')return {items:[],complete:true};return {complete:true};},async downloadMedia(){return {bytes:Buffer.from('asset bytes')};}};}
async function withDir(fn:(dir:string)=>Promise<void>){const dir=mkdtempSync(join(tmpdir(),'takeout-'));try{await fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
test('preserves every branch, private modes and media bytes; resumes verified files',()=>withDir(async output=>{const s=fixture();const result=await runTakeout(s,{output,maxRetries:0});expect(result.integrity).toBe(true);expect(result.complete).toBe(false);const m=JSON.parse(readFileSync(join(output,'manifest.json'),'utf8'));expect(JSON.parse(readFileSync(join(output,m.files['conversation:one'].path),'utf8'))).toEqual(tree);expect(statSync(output).mode&0o777).toBe(0o700);expect(statSync(join(output,m.files['conversation:one'].path)).mode&0o777).toBe(0o600);await runTakeout(s,{output,maxRetries:0});expect(s.calls).toBe(1);}));
test('interruption after checkpoint resumes without repeating conversation read',()=>withDir(async output=>{const s=fixture();await expect(runTakeout(s,{output,maxRetries:0},event=>{if(event.type==='takeout.progress')throw new Error('simulated interruption');})).rejects.toThrow('simulated interruption');await runTakeout(s,{output,maxRetries:0});expect(s.calls).toBe(1);expect(auditTakeout(output).integrity).toBe(true);}));
test('audit detects corruption and resume repairs it',()=>withDir(async output=>{const s=fixture();await runTakeout(s,{output,maxRetries:0});const m=JSON.parse(readFileSync(join(output,'manifest.json'),'utf8'));writeFileSync(join(output,m.files['conversation:one'].path),'corrupt');expect(auditTakeout(output).integrity).toBe(false);await runTakeout(s,{output,maxRetries:0});expect(s.calls).toBe(2);expect(auditTakeout(output).integrity).toBe(true);}));
test('missing tree nodes are reported and retried, raw snapshot retained',()=>withDir(async output=>{const s=fixture();s.conversation=async()=>({mapping:{root:{parent:null,children:['missing']}}});const r=await runTakeout(s,{output,maxRetries:0});expect(r.coverage['conversation:one'].status).toBe('partial');const m=JSON.parse(readFileSync(join(output,'manifest.json'),'utf8'));expect(m.files['conversation:one']).toBeDefined();}));
test('denied reads expose no remote secret and remain resumable',()=>withDir(async output=>{const s=fixture();s.conversation=async()=>{throw new Error('403 secret-token https://signed.example?a=secret');};const events:any[]=[];const r=await runTakeout(s,{output,maxRetries:0},e=>events.push(e));expect(r.coverage['conversation:one'].status).toBe('inaccessible');expect(JSON.stringify(r)+JSON.stringify(events)).not.toContain('secret');s.conversation=async()=>tree;expect((await runTakeout(s,{output,maxRetries:0})).coverage['conversation:one'].status).toBe('complete');}));
test('identity mismatch refuses mixing accounts',()=>withDir(async output=>{const s=fixture();await runTakeout(s,{output,maxRetries:0});s.account.userId='other';await expect(runTakeout(s,{output})).rejects.toThrow('identity');}));
test('media scan finds pointers and attachment IDs across branches but ignores prose URLs',()=>{const refs=mediaReferences({mapping:tree.mapping,attachments:[{id:'file-123'}],text:'https://example.com'},'one');expect(refs.map(r=>r.reference).sort()).toEqual(['file-123','file-service://asset']);});
test('partial catalog is reread on resume and newly discovered conversations are fetched',()=>withDir(async output=>{const s=fixture();let pages=0;s.conversations=async()=>++pages===1?{items:[{id:'one'}],complete:false}:{items:[{id:'one'},{id:'two'}],complete:true};await runTakeout(s,{output,maxRetries:0});const result=await runTakeout(s,{output,maxRetries:0});expect(pages).toBe(2);expect(s.calls).toBe(2);expect(result.coverage['conversations:index'].status).toBe('complete');}));
test('cyclic trees remain partial',()=>withDir(async output=>{const s=fixture();s.conversation=async()=>({mapping:{a:{parent:'b',children:['b']},b:{parent:'a',children:['a']}}});expect((await runTakeout(s,{output,maxRetries:0})).coverage['conversation:one'].status).toBe('partial');}));
test('another active writer is rejected without disturbing its lock',()=>withDir(async output=>{writeFileSync(join(output,'.writer.lock'),String(process.pid));await expect(runTakeout(fixture(),{output})).rejects.toThrow('already being written');expect(readFileSync(join(output,'.writer.lock'),'utf8')).toBe(String(process.pid));}));
test('rate-limit retries honor the server hint and report a wait without response secrets',()=>withDir(async output=>{const s=fixture();let calls=0;const events:any[]=[];s.conversation=async()=>{if(++calls===1)throw Object.assign(new Error('429 private server details'),{status:429,retryAfterMs:5});return tree;};await runTakeout(s,{output,maxRetries:2},e=>events.push(e));expect(calls).toBe(2);expect(events.find(e=>e.type==='takeout.wait')).toEqual({type:'takeout.wait',reason:'rate-limit',waitMs:5,attempt:1});expect(JSON.stringify(events)).not.toContain('private server details');}));
test('library integration downloads only positively identified owned assets with valid extensions',()=>withDir(async output=>{const s=fixture(),original=s.dispatch!;s.dispatch=async op=>op==='media.list'?{items:[{id:'own',reference:'sediment://file_owned',downloadable:true},{id:'external',reference:'external-file',downloadable:false}],complete:false}:original(op);const downloaded:string[]=[];s.downloadMedia=async ref=>{downloaded.push(ref.reference);return {bytes:Buffer.from('binary asset'),contentType:'image/png',extension:'png'};};await runTakeout(s,{output,maxRetries:0});expect(downloaded).toContain('sediment://file_owned');expect(downloaded).not.toContain('external-file');const m=JSON.parse(readFileSync(join(output,'manifest.json'),'utf8'));expect(Object.values(m.files).filter((e:any)=>e.kind==='media').every((e:any)=>e.path.endsWith('.png')&&e.contentType==='image/png')).toBe(true);}));

test('takeout reuses account-bound media export, rejects corruption and falls back to downloader',()=>withDir(async root=>{const cache=join(root,'cache'),output=join(root,'archive'),s=fixture();const reference='sediment://file_cached',png=Buffer.from([137,80,78,71,13,10,26,10,0]);s.conversation=async()=>({mapping:{root:{parent:null,children:[],message:{content:{parts:[{asset_pointer:reference}]}}}}});await exportMedia({items:[{id:'cached',reference,downloadable:true}],complete:true,coverage:[]},async path=>path.includes('/files/download/')?{status:'success',download_url:'https://chatgpt.com/backend-api/estuary/content?id=cached'}:{bytes:png,contentType:'image/png'},{output:cache,accountId:'test',userId:'u'});s.downloadMedia=undefined;const result=await runTakeout(s,{output,mediaExport:cache,maxRetries:0});expect(result.integrity).toBe(true);const manifest=JSON.parse(readFileSync(join(output,'manifest.json'),'utf8'));const e:any=Object.values(manifest.files).find((e:any)=>e.kind==='media');expect(readFileSync(join(output,e.path))).toEqual(png);expect(e.contentType).toBe('image/png');const m=JSON.parse(readFileSync(join(cache,'media-manifest.json'),'utf8'));writeFileSync(join(cache,(Object.values(m.entries)[0] as any).file),'corrupt');let downloads=0;s.downloadMedia=async()=>{downloads++;return {bytes:png,extension:'png'};};await runTakeout(s,{output:join(root,'repair'),mediaExport:cache,maxRetries:0});expect(downloads).toBe(1);m.userId='other';writeFileSync(join(cache,'media-manifest.json'),JSON.stringify(m));await runTakeout(s,{output:join(root,'other'),mediaExport:cache,maxRetries:0});expect(downloads).toBe(2);}));

test('persistent detail rate limit stops before the next conversation and resumes later',()=>withDir(async output=>{const s=fixture();s.conversations=async()=>({items:[{id:'one'},{id:'two'}],complete:true});let reads=0;s.conversation=async()=>{reads++;throw Object.assign(new Error('429'),{status:429});};const result=await runTakeout(s,{output,maxRetries:0});expect((result as any).paused).toBe(true);expect(reads).toBe(1);s.conversation=async()=>tree;const next=await runTakeout(s,{output,maxRetries:0});expect(next.coverage['conversations:details']).toBeUndefined();expect(next.coverage['conversation:two'].status).toBe('complete');}));

test('the read budget is explicit: a default slice, an opt-in unbounded run, and no silent coercion',()=>{
 expect(DEFAULT_CONVERSATION_READS).toBe(25);
 expect(conversationBudget(undefined)).toBe(DEFAULT_CONVERSATION_READS);
 expect(conversationBudget('')).toBe(DEFAULT_CONVERSATION_READS);
 expect(conversationBudget(3)).toBe(3);
 expect(conversationBudget('3')).toBe(3);
 expect(conversationBudget(0)).toBe(0);
 expect(conversationBudget('all')).toBe(Infinity);
 expect(conversationBudget('unbounded')).toBe(Infinity);
 for(const bad of ['many',-1,2.5,'-4',NaN])expect(()=>conversationBudget(bad)).toThrow('maxConversations');
});

test('a frozen account defers before identity, before the lock and before any read',()=>withDir(async output=>{
 const s=fixture() as any;let identity=0;s.identity=async()=>{identity++;return {authenticated:true};};
 s.freeze=()=>({frozen:true,reason:'his STOP'});
 const events:any[]=[];
 const result:any=await runTakeout(s,{output,maxRetries:0},e=>events.push(e));
 expect(result).toMatchObject({deferred:true,paused:true,reason:'frozen',freezeReason:'his STOP',reads:0,attempted:0,complete:false});
 expect(identity).toBe(0);expect(s.calls).toBe(0);
 expect(existsSync(join(output,'.writer.lock'))).toBe(false);
 expect(existsSync(join(output,'manifest.json'))).toBe(false);
 expect(events).toEqual([{type:'takeout.deferred',reason:'frozen'}]);
 s.freeze=()=>({frozen:false});
 expect((await runTakeout(s,{output,maxRetries:0})).coverage['conversation:one'].status).toBe('complete');
 expect(identity).toBe(1);expect(s.calls).toBe(1);
}));

test('a zero-read slice attempts nothing and still records every target as pending',()=>withDir(async output=>{
 const s=fixture();
 const result:any=await runTakeout(s,{output,maxRetries:0,maxConversations:0});
 expect(s.calls).toBe(0);
 expect(result).toMatchObject({stopped:true,reason:'read-limit',reads:0,limit:0,attempted:0,remaining:1,targets:1});
 const m=JSON.parse(readFileSync(join(output,'manifest.json'),'utf8'));
 expect(m.complete).toBe(false);
 expect(m.coverage['conversation:one']).toMatchObject({required:true,status:'partial',reason:'Pending conversation detail read; no attempt recorded yet.'});
}));

test('a writer lock is reclaimed only from a provably dead owner, never from an unprobeable one',()=>withDir(async output=>{
 // PID 1 (launchd) answers EPERM for a normal user: liveness is UNKNOWN, so the lock stays put.
 writeFileSync(join(output,'.writer.lock'),'1');
 await expect(runTakeout(fixture(),{output,maxRetries:0})).rejects.toThrow(/cannot be probed|already being written/);
 expect(readFileSync(join(output,'.writer.lock'),'utf8')).toBe('1');
 const child=Bun.spawn(['true'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});const pid=child.pid;await child.exited;
 writeFileSync(join(output,'.writer.lock'),String(pid));
 const s=fixture();await runTakeout(s,{output,maxRetries:0});
 expect(s.calls).toBe(1);expect(existsSync(join(output,'.writer.lock'))).toBe(false);
}));
