import {expect,test} from 'bun:test';
import {join} from 'node:path';

test('all ChatGPT production modules compile and import in isolation',async()=>{
 const child=Bun.spawn([process.execPath,'test',join(import.meta.dir,'helpers/chatgpt-import-suite.ts')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(code!==0)throw new Error(stdout+'\n'+stderr);
 expect(code).toBe(0);
},15000);
