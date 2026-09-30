import {expect,test} from 'bun:test';
import {join} from 'node:path';

test('browser surface lookup fails closed instead of falling back to main',()=>{
 const source=join(import.meta.dir,'../src/chatgpt/browser.py');
 const probe=`import ast,sys\ntree=ast.parse(open(sys.argv[1]).read())\nnode=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='surface_tab')\nns={}\nexec(compile(ast.Module(body=[node],type_ignores=[]),sys.argv[1],'exec'),ns)\nmain=object(); worker=type('Worker',(),{'tabs':{'main':main}})()\nassert ns['surface_tab'](worker,{}) is main\ntry: ns['surface_tab'](worker,{'surface':'missing'})\nexcept ValueError as error: assert str(error)=='Unknown browser surface.'\nelse: raise AssertionError('unknown surface fell back to main')`;
 const result=Bun.spawnSync(['python3','-c',probe,source]);
 expect(result.exitCode).toBe(0);
});
