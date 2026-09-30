import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HARNESS_PROTOCOL_EXTRACTOR,WebsiteHarnessDriver} from '../src/chatgpt/harness-web.ts';

// Live failure this falsifies — run live-20260915-1551, agent "beta", requestId
// 53e44f9a-90b8-4917-8533-b8a4c98b94c2: the semantic extraction was a SECOND RPC
// message pinned to the epoch and URL of a FIRST one. Anything that republished
// window.__apiplanRefs.epoch or rewrote location.href in between (every `snapshot`
// republishes the epoch; the SPA rewrites /c/WEB:<draft> to /c/<id> right after a
// first submit) failed the turn with "Harness protocol snapshot changed before
// semantic extraction.". After a submit that is classified OUTCOME_UNKNOWN, which
// bars replay for that agent for the rest of the run.

const account={id:'fixture',label:'Fixture',userId:'user-fixture',baseURL:'https://chatgpt.com',cdpURL:'http://127.0.0.1:9222',transportMode:'attached' as const,created:''};
const source=join(import.meta.dir,'../src/chatgpt/browser.py');

test('the driver reads a protocol snapshot as one worker operation, never as a snapshot plus a separately pinned evaluate',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'harness-epoch-'));
 const ops:string[]=[],events:any[]=[];let epoch=0,page='https://chatgpt.com/c/WEB:draft';
 const worker={
  async start(){},async close(){},
  async call(op:string,args:any={}){
   ops.push(op);
   if(op==='snapshot')return {epoch:'epoch-'+(++epoch),url:page,messages:[],controls:[],media:[]};
   if(op==='evaluate'){
    // A split extraction cannot bind to its own snapshot: by the time this second
    // message runs, another surface reader has already republished the epoch.
    epoch++;
    throw new Error('Error: Harness protocol snapshot changed before semantic extraction.\n    at <anonymous>:1:340');
   }
   if(op==='snapshot.evaluate'){
    new Function('return ('+args.expression+')'); // the page-side extractor must parse
    const snapshot={epoch:'epoch-'+(++epoch),url:page,messages:[{id:'a1',domTurnId:'conversation-turn-2',role:'assistant',text:'reply'}],controls:[],media:[]};
    return {snapshot,value:{url:snapshot.url,visibilityState:'visible',hidden:false,messages:[{id:'a1',domTurnId:'conversation-turn-2',protocolText:'frame',protocolSource:'semantic-dom',diagnostic:{turnTextLength:5}}]}};
   }
   throw new Error('Unexpected '+op);
  },
 };
 const driver=new WebsiteHarnessDriver(account,{directory,emit:(event:any)=>events.push(event)},{worker:()=>worker});
 try{
  for(let round=0;round<20;round++){
   if(round===7)page='https://chatgpt.com/c/6aa9694f-5d8c-83ed-8e98-31985246e6c3'; // the rewrite beta died on
   const snapshot=await (driver as any).readProtocolSnapshot('harness-fixture');
   expect(snapshot.url).toBe(page);
   expect(snapshot.harnessDOM.visibilityState).toBe('visible');
   expect(snapshot.messages[0].protocolText).toBe('frame');
   expect(snapshot.messages[0].protocolSource).toBe('semantic-dom');
  }
  expect(ops.filter(op=>op==='snapshot.evaluate')).toHaveLength(20);
  expect(ops).not.toContain('evaluate');
  expect(ops).not.toContain('snapshot');
  expect(events.filter(event=>event.type==='harness.snapshot.retry')).toHaveLength(0);
 }finally{await driver.close();rmSync(directory,{recursive:true,force:true});}
});

test('a genuinely changed surface still fails the turn instead of extracting a stale frame',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'harness-epoch-'));
 const worker={
  async start(){},async close(){},
  async call(op:string){
   if(op!=='snapshot.evaluate')throw new Error('Unexpected '+op);
   throw new Error('Error: Harness protocol snapshot changed before semantic extraction.');
  },
 };
 const driver=new WebsiteHarnessDriver(account,{directory},{worker:()=>worker});
 try{await expect((driver as any).readProtocolSnapshot('harness-fixture')).rejects.toThrow('Harness protocol snapshot changed before semantic extraction.');}
 finally{await driver.close();rmSync(directory,{recursive:true,force:true});}
});

test('the worker serializes every surface-bound operation and leaves independent reads free',()=>{
 const probe=`import ast,sys,asyncio,types
source=sys.argv[1];tree=ast.parse(open(source).read())
node=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='operation_lock')
ns={'asyncio':asyncio}
exec(compile(ast.Module(body=[node],type_ignores=[]),source,'exec'),ns)
lock=ns['operation_lock']
async def main():
 worker=types.SimpleNamespace(lock=asyncio.Lock(),surface_locks={})
 first=lock(worker,'snapshot',{'surface':'harness-1'})
 for op in ('snapshot','snapshot.evaluate','evaluate','action','thinking.expand','generation.receipt','surface.open'):
  assert lock(worker,op,{'surface':'harness-1'}) is first, op
 assert lock(worker,'evaluate',{'surface':'harness-2'}) is not first
 assert lock(worker,'evaluate',{}) is not first
 for op in ('request','status','session','network','screenshot'):
  assert lock(worker,op,{'surface':'harness-1'}) is None, op
 for op in ('init','mode','reload','close'):
  assert lock(worker,op,{}) is worker.lock, op
asyncio.run(main())`;
 const result=Bun.spawnSync(['python3','-c',probe,source],{stderr:'pipe'});
 expect(new TextDecoder().decode(result.stderr)).toBe('');
 expect(result.exitCode).toBe(0);
});

test('snapshot_evaluate binds the expression to its own snapshot while a rival surface reader runs, where the split form loses',()=>{
 const probe=`import ast,sys,asyncio,json
source=sys.argv[1];tree=ast.parse(open(source).read())
ns={'asyncio':asyncio,'json':json}
for name,kind in (('operation_lock',ast.FunctionDef),('snapshot_evaluate',ast.AsyncFunctionDef)):
 node=next(n for n in ast.walk(tree) if isinstance(n,kind) and n.name==name)
 exec(compile(ast.Module(body=[node],type_ignores=[]),source,'exec'),ns)

class Worker:
 """The live semantics: every snapshot republishes the epoch; an expression pinned
 to an older epoch or URL throws the page guard instead of reading a stale frame."""
 def __init__(self):
  self.lock=asyncio.Lock();self.surface_locks={};self.epoch=0;self.url='https://chatgpt.com/c/WEB:draft'
 async def snapshot(self,tab=None):
  await asyncio.sleep(0)
  self.epoch+=1
  return {'epoch':'epoch-%d'%self.epoch,'url':self.url,
          'messages':[{'id':'a1','domTurnId':'conversation-turn-2','role':'assistant','text':'reply'}]}
 async def evaluate(self,expression,tab=None):
  await asyncio.sleep(0)
  spec=json.loads(expression.split(')(',1)[1][:-1])
  if spec['epoch']!='epoch-%d'%self.epoch or spec['url']!=self.url:
   raise RuntimeError('Harness protocol snapshot changed before semantic extraction.')
  return {'url':self.url,'messages':[]}

async def dispatch(worker,op,args,body):
 lock=ns['operation_lock'](worker,op,args)
 if lock is None:return await body()
 async with lock:return await body()

async def rival(worker,rounds):
 for _ in range(rounds):
  await dispatch(worker,'snapshot',{'surface':'s'},lambda: worker.snapshot(None))
  await asyncio.sleep(0)

async def atomic(worker,rounds):
 done=0
 for _ in range(rounds):
  result=await dispatch(worker,'snapshot.evaluate',{'surface':'s'},lambda: ns['snapshot_evaluate'](worker,None,'spec=>spec'))
  assert result['snapshot']['epoch'].startswith('epoch-')
  assert result['value']['url']==worker.url
  done+=1
  await asyncio.sleep(0)
 return done

async def split(worker,rounds):
 """What the driver used to send: two RPC messages, the second pinned to the first."""
 lost=0
 for _ in range(rounds):
  snapshot=await dispatch(worker,'snapshot',{'surface':'s'},lambda: worker.snapshot(None))
  await asyncio.sleep(0)
  spec=json.dumps({'epoch':snapshot['epoch'],'url':snapshot['url'],'messages':[]})
  try:
   await dispatch(worker,'evaluate',{'surface':'s'},lambda: worker.evaluate('(spec=>spec)('+spec+')',None))
  except RuntimeError:
   lost+=1
 return lost

async def main():
 worker=Worker()
 done,_=await asyncio.gather(atomic(worker,30),rival(worker,60))
 assert done==30
 worker=Worker()
 lost,_=await asyncio.gather(split(worker,30),rival(worker,60))
 assert lost>0, 'control arm never reproduced the split-call race; the probe proves nothing'
asyncio.run(main())`;
 const result=Bun.spawnSync(['python3','-c',probe,source],{stderr:'pipe'});
 expect(new TextDecoder().decode(result.stderr)).toBe('');
 expect(result.exitCode).toBe(0);
});

test('the worker calls the page-side extractor with the identity of the snapshot it just took',()=>{
 const probe=`import ast,sys,asyncio,json
source,extractor=sys.argv[1],sys.argv[2]
tree=ast.parse(open(source).read());ns={'asyncio':asyncio,'json':json}
node=next(n for n in ast.walk(tree) if isinstance(n,ast.AsyncFunctionDef) and n.name=='snapshot_evaluate')
exec(compile(ast.Module(body=[node],type_ignores=[]),source,'exec'),ns)
class Worker:
 async def snapshot(self,tab=None):
  return {'epoch':'epoch-1','url':'https://chatgpt.com/c/WEB:draft','text':'private page text',
          'messages':[{'id':'a1','domTurnId':'conversation-turn-2','role':'assistant','text':'private reply'},
                      {'id':'u1','domTurnId':'conversation-turn-1','role':'user','text':'private prompt'}]}
 async def evaluate(self,expression,tab=None):
  self.expression=expression
  return {'url':'https://chatgpt.com/c/WEB:draft','messages':[]}
async def main():
 worker=Worker()
 result=await ns['snapshot_evaluate'](worker,None,extractor)
 assert result['snapshot']['epoch']=='epoch-1'
 sys.stdout.write(worker.expression)
 for bad in (None,'','   '):
  try:await ns['snapshot_evaluate'](worker,None,bad)
  except ValueError:pass
  else:raise AssertionError('an empty expression was accepted')
asyncio.run(main())`;
 const result=Bun.spawnSync(['python3','-c',probe,source,HARNESS_PROTOCOL_EXTRACTOR],{stderr:'pipe'});
 expect(new TextDecoder().decode(result.stderr)).toBe('');
 expect(result.exitCode).toBe(0);
 const composed=new TextDecoder().decode(result.stdout);
 const head='('+HARNESS_PROTOCOL_EXTRACTOR+')(';
 expect(composed.startsWith(head)).toBe(true);
 expect(composed.endsWith(')')).toBe(true);
 new Function('return '+composed); // the composed page-side call must compile
 const spec=JSON.parse(composed.slice(head.length,-1));
 expect(spec).toEqual({epoch:'epoch-1',url:'https://chatgpt.com/c/WEB:draft',messages:[{id:'a1',domTurnId:'conversation-turn-2',role:'assistant'},{id:'u1',domTurnId:'conversation-turn-1',role:'user'}]});
 expect(composed).not.toContain('private reply'); // conversation text never re-enters the page
 expect(composed).not.toContain('private page text');
});
