import {expect,test} from 'bun:test';
import {join} from 'node:path';

test('Python asset streaming enforces frames, integrity, limits and cleanup',async()=>{
 const python=process.env.CHATGPT_PYTHON||Bun.which('python3');
 expect(python).toBeTruthy();
 const child=Bun.spawn([python!,join(import.meta.dir,'helpers/chatgpt-asset-stream-suite.py')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(code!==0)throw new Error(stdout+'\n'+stderr);
 expect(code).toBe(0);
 expect(stderr).toContain('OK');
});

test('service transfer paths are verified and cleaned in an isolated module process',async()=>{
 const child=Bun.spawn([process.execPath,'test',join(import.meta.dir,'helpers/chatgpt-asset-service-suite.ts')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(code!==0)throw new Error(stdout+'\n'+stderr);
 expect(code).toBe(0);
});
