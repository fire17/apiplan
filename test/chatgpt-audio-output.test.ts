import {expect,test} from 'bun:test';
import {join} from 'node:path';

test('website playback capture validates bounds and records with a simulated audio graph',async()=>{
 const python=process.env.CHATGPT_PYTHON||Bun.which('python3');
 expect(python).toBeTruthy();
 const child=Bun.spawn([python!,join(import.meta.dir,'helpers/chatgpt-audio-output-suite.py')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(code!==0)throw new Error(stdout+'\n'+stderr);
 expect(code).toBe(0);
 expect(stderr).toContain('OK');
});
