import {expect,test} from 'bun:test';
import {join} from 'node:path';
test('quit and a new process restore conversation, reading position, draft and files while pausing queue',async()=>{
 const child=Bun.spawn([process.env.CHATGPT_PYTHON||Bun.which('python3')!,join(import.meta.dir,'helpers/chatgpt-tui-reopen-suite.py')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code!==0)throw new Error(stdout+'\n'+stderr);expect(code).toBe(0);
},30000);
