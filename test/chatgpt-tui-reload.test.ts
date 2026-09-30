import {expect,test} from 'bun:test';
import {join} from 'node:path';
test('live TUI retains draft, verified model and palette across reload and rejects syntax errors',async()=>{
 const python=process.env.CHATGPT_PYTHON||Bun.which('python3');expect(python).toBeTruthy();
 const child=Bun.spawn([python!,join(import.meta.dir,'helpers/chatgpt-tui-reload-suite.py')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(code!==0)throw new Error(stdout+'\n'+stderr);expect(code).toBe(0);
},30000);
