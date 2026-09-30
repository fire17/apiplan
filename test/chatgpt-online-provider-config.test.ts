import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function probe(transportMode?:'attached'|'managed',cdpURL='http://127.0.0.1:9222'){
 const root=mkdtempSync(join(tmpdir(),'online-provider-config-'));roots.push(root);mkdirSync(root,{recursive:true});
 const account={id:'legacy',label:'Legacy attached',baseURL:'https://chatgpt.com',cdpURL,userId:'user-legacy',workspace:'space',created:'2026-09-15T00:00:00.000Z',...(transportMode?{transportMode}:{})};
 writeFileSync(join(root,'accounts.json'),JSON.stringify({version:1,selected:'legacy',accounts:[account]}));
 const child=Bun.spawn(['bun',join(import.meta.dir,'helpers','online-provider-config-probe.ts')],{cwd:join(import.meta.dir,'..'),env:{...process.env,CHATGPT_HOME:root},stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(exit,stderr).toBe(0);return JSON.parse(stdout);
}

test('legacy attached accounts without transportMode remain usable and map only verified controls',async()=>{
 const result=await probe();expect(result.probe.connected).toBe(true);expect(result.creds).toEqual({account:'legacy',source:'signed-in website browser'});
 expect(result.chat).toEqual({mode:'Chat',model:'Latest',effort:'Instant'});expect(result.astra).toEqual({mode:'Work',model:'GPT-6 Astra',effort:'Light'});
});

test('managed or non-loopback browser configurations fail before provider use',async()=>{
 expect((await probe('managed')).probe).toMatchObject({connected:false});expect((await probe('attached','https://remote.example')).probe).toMatchObject({connected:false});
});
