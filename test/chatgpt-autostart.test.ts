import {expect,test} from 'bun:test';
import {join} from 'node:path';

test('ChatGPT launchd autostart suite uses only fixture command runners',async()=>{
 const child=Bun.spawn([process.execPath,'test',join(import.meta.dir,'helpers/chatgpt-autostart-suite.ts')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(code!==0)throw new Error(stdout+'\n'+stderr);
 expect(code).toBe(0);
},15000);
