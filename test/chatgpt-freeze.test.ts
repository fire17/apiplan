import {expect,test} from 'bun:test';
import {join} from 'node:path';

// The freeze switch suite runs in a child process so its CHATGPT_HOME never leaks into other suites.
test('ChatGPT freeze switch suite runs in an isolated module cache',async()=>{
 const child=Bun.spawn([process.execPath,'test',join(import.meta.dir,'helpers/chatgpt-freeze-suite.ts')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(code!==0)throw new Error(stdout+'\n'+stderr);
 expect(code).toBe(0);
},20000);
