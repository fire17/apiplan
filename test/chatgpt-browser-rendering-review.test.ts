import {expect,test} from 'bun:test';
import {join} from 'node:path';

test('rendering setup fails closed, remains retryable, and never touches an untracked tab',()=>{
 const source=join(import.meta.dir,'../src/chatgpt/browser.py');
 const probe=`import ast,sys,asyncio,types
source=sys.argv[1];tree=ast.parse(open(source).read());node=next(n for n in ast.walk(tree) if isinstance(n,ast.AsyncFunctionDef) and n.name=='ensure_rendering')
ns={'cdp':types.SimpleNamespace(emulation=types.SimpleNamespace(set_focus_emulation_enabled=lambda enabled:('focus',enabled)))}
exec(compile(ast.Module(body=[node],type_ignores=[]),source,'exec'),ns)
class Tab:
 def __init__(self,fail=False):self.calls=[];self.fail=fail
 async def send(self,command):
  self.calls.append(command)
  if self.fail:raise RuntimeError('focus emulation unsupported')
async def main():
 owned=Tab(fail=True);daily=Tab();worker=types.SimpleNamespace(tab=owned,api_tab=None,session_tab=None,tabs={'main':owned})
 observations=[{'visibilityState':'hidden','hidden':True,'focused':False},{'visibilityState':'visible','hidden':False,'focused':True}]
 async def evaluate(expression,tab):return observations.pop(0)
 worker.evaluate=evaluate
 try:await ns['ensure_rendering'](worker,owned)
 except RuntimeError as error:assert str(error)=='Owned tab rendering emulation is unavailable; no rendering guarantee was established.'
 else:raise AssertionError('unsupported CDP command claimed success')
 assert getattr(worker,'rendering_tabs',{})=={}
 owned.fail=False
 try:await ns['ensure_rendering'](worker,owned)
 except RuntimeError as error:assert 'did not verify visible rendering' in str(error)
 else:raise AssertionError('hidden readback claimed success')
 assert getattr(worker,'rendering_tabs',{})=={}
 result=await ns['ensure_rendering'](worker,owned)
 assert result['enabled'] is True and result['visibilityState']=='visible' and result['hidden'] is False
 assert len(owned.calls)==3
 assert await ns['ensure_rendering'](worker,owned)==result and len(owned.calls)==3
 assert await ns['ensure_rendering'](worker,daily)=={'enabled':False,'reason':'not worker-owned'} and daily.calls==[]
asyncio.run(main())`;
 const result=Bun.spawnSync(['python3','-c',probe,source],{stderr:'pipe'});
 expect(new TextDecoder().decode(result.stderr)).toBe('');
 expect(result.exitCode).toBe(0);
});

test('rendering helper contains no navigation, browser lifecycle, or response completion operation',()=>{
 const source=Bun.file(join(import.meta.dir,'../src/chatgpt/browser.py')).text();
 return source.then(text=>{
  const match=text.match(/    async def ensure_rendering\(self, tab\):([\s\S]*?)\n    async def snapshot/);
  expect(match).not.toBeNull();
  const body=match![1];
  expect(body).not.toMatch(/await\s+tab\.get\(|bring_to_front|\.close\(|browser\.start|response|complete/i);
  expect(body).toContain("visibilityState");
  expect(body).toContain("hidden");
 });
});
