import {expect,test} from 'bun:test';
import {join} from 'node:path';
test('recovered generation queues Enter, guards model, stops once only on Ctrl+C',async()=>{const child=Bun.spawn([process.env.CHATGPT_PYTHON||Bun.which('python3')!,join(import.meta.dir,'helpers/chatgpt-tui-active-recovery-suite.py')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw new Error(out+'\n'+err);expect(code).toBe(0);},20000);
