import {expect,test} from 'bun:test';
import {join} from 'node:path';
test('preflight failures restore drafts and unknown submissions cannot duplicate a send',async()=>{
 const child=Bun.spawn([process.env.CHATGPT_PYTHON||Bun.which('python3')!,join(import.meta.dir,'helpers/chatgpt-tui-submission-suite.py')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code!==0)throw new Error(stdout+'\n'+stderr);expect(code).toBe(0);
},20000);
