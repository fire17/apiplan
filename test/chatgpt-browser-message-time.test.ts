import {expect,test} from 'bun:test';
import {join} from 'node:path';

test('first-observed message time survives roleless-to-server identity promotion',()=>{
 const source=join(import.meta.dir,'../src/chatgpt/browser.py');
 const probe=`import ast,sys\ntree=ast.parse(open(sys.argv[1]).read())\nnode=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='observe_message_times')\nns={'datetime':None,'timezone':None}\nexec(compile(ast.Module(body=[node],type_ignores=[]),sys.argv[1],'exec'),ns)\nworker=type('Worker',(),{})()\nfirst={'url':'https://chatgpt.com/c/test','messages':[{'id':'dom:conversation-turn-10','domTurnId':'conversation-turn-10','role':'assistant'}]}\nns['observe_message_times'](worker,first,'2026-09-15T14:00:00.000Z')\nsecond={'url':'https://chatgpt.com/c/test','messages':[{'id':'server-message-id','domTurnId':'conversation-turn-10','role':'assistant'},{'id':None,'role':'assistant'}]}\nns['observe_message_times'](worker,second,'2026-09-15T14:01:00.000Z')\nassert first['messages'][0]['firstObservedAt']=='2026-09-15T14:00:00.000Z'\nassert second['messages'][0]['firstObservedAt']==first['messages'][0]['firstObservedAt']\nassert 'firstObservedAt' not in second['messages'][1]`;
 const result=Bun.spawnSync(['python3','-c',probe,source],{stderr:'pipe'});
 expect(new TextDecoder().decode(result.stderr)).toBe('');
 expect(result.exitCode).toBe(0);
});
