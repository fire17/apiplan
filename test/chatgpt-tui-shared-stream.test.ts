import {expect,test} from 'bun:test';
import {join} from 'node:path';
test('shared queue PTY streams mixed targets and media while preserving literal Alt text on Mac',async()=>{const child=Bun.spawn([process.env.CHATGPT_PYTHON||Bun.which('python3')!,join(import.meta.dir,'helpers/chatgpt-tui-shared-stream-suite.py')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw new Error(out+'\n'+err);expect(code).toBe(0);},15000);
