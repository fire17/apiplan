import {expect,test} from 'bun:test';
import {join} from 'node:path';
test('durable queue service integration in isolated private home',async()=>{const child=Bun.spawn([process.execPath,'test',join(import.meta.dir,'helpers/chatgpt-queue-service-suite.ts')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw new Error(out+'\n'+err);expect(code).toBe(0);},15000);
