import {expect,test} from 'bun:test';
import {join} from 'node:path';
test('rendering emulation is owned-target-only, cached across snapshots and safe after hot reload',()=>{
 const source=join(import.meta.dir,'../src/chatgpt/browser.py');
 const probe=`import ast,sys,asyncio,types
source=sys.argv[1];tree=ast.parse(open(source).read());node=next(n for n in ast.walk(tree) if isinstance(n,ast.AsyncFunctionDef) and n.name=='ensure_rendering')
ns={'cdp':types.SimpleNamespace(emulation=types.SimpleNamespace(set_focus_emulation_enabled=lambda enabled:('focus',enabled)))}
exec(compile(ast.Module(body=[node],type_ignores=[]),source,'exec'),ns)
class Tab:
 def __init__(self):self.calls=[]
 async def send(self,command):self.calls.append(command)
async def main():
 main=Tab();aux=Tab();daily=Tab();worker=types.SimpleNamespace(tab=main,api_tab=None,session_tab=None,tabs={'main':main,'aux':aux})
 async def evaluate(expression,tab):return {'visibilityState':'visible','hidden':False,'focused':True}
 worker.evaluate=evaluate
 first=await ns['ensure_rendering'](worker,main);second=await ns['ensure_rendering'](worker,main)
 assert first['enabled'] and first==second and main.calls==[('focus',True)]
 assert (await ns['ensure_rendering'](worker,daily))['enabled'] is False and daily.calls==[]
 await ns['ensure_rendering'](worker,aux);assert aux.calls==[('focus',True)]
 assert not hasattr(worker,'owned')
 broken=Tab();worker.tabs['broken']=broken
 async def unsupported(command):raise ValueError('Unknown experimental command')
 broken.send=unsupported
 try:await ns['ensure_rendering'](worker,broken)
 except RuntimeError as error:assert str(error)=='Owned tab rendering emulation is unavailable; no rendering guarantee was established.'
 else:raise AssertionError('unsupported command was silently accepted')
 assert id(broken) not in worker.rendering_tabs
 broken.send=types.MethodType(Tab.send,broken)
 await ns['ensure_rendering'](worker,broken);assert id(broken) in worker.rendering_tabs
 hidden=Tab();worker.tabs['hidden']=hidden
 async def hidden_evaluate(expression,tab):return {'visibilityState':'hidden','hidden':True,'focused':False}
 worker.evaluate=hidden_evaluate
 try:await ns['ensure_rendering'](worker,hidden)
 except RuntimeError as error:assert 'did not verify visible rendering' in str(error)
 else:raise AssertionError('hidden readback was accepted')
 assert id(hidden) not in worker.rendering_tabs
 worker.evaluate=evaluate
 await ns['ensure_rendering'](worker,hidden);assert len(hidden.calls)==2
asyncio.run(main())`;
 const result=Bun.spawnSync(['python3','-c',probe,source],{stderr:'pipe'});expect(new TextDecoder().decode(result.stderr)).toBe('');expect(result.exitCode).toBe(0);
});
