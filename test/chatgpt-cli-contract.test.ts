import {expect,test} from 'bun:test';
import {chmodSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const CLI=join(import.meta.dir,'../bin/chatgpt.ts');
async function cli(home:string,args:string[]){
 const child=Bun.spawn([process.execPath,CLI,...args],{stdin:'ignore',stdout:'pipe',stderr:'pipe',env:{...process.env,CHATGPT_HOME:home}});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 return {stdout,stderr,code};
}

test('takeout status and audit separate archive input from JSON output',async()=>{
 const home=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-cli-contract-')),archive=join(home,'archive'),receipts=join(home,'receipts');
 mkdirSync(archive,{mode:0o700});mkdirSync(receipts,{mode:0o755});chmodSync(receipts,0o755);
 writeFileSync(join(archive,'manifest.json'),JSON.stringify({version:1,account:'default',started:'2026-09-15T00:00:00.000Z',updated:'2026-09-15T00:00:00.000Z',complete:true,coverage:{},files:{}}),{mode:0o600});
 try{
  const statusFile=join(receipts,'status.json'),status=await cli(home,['takeout','status','--archive',archive,'--output',statusFile]);
  expect({code:status.code,stderr:status.stderr}).toEqual({code:0,stderr:''});
  expect(JSON.parse(status.stdout)).toEqual({path:statusFile});
  expect(JSON.parse(readFileSync(statusFile,'utf8'))).toMatchObject({path:archive,exists:true,complete:true,files:0});

  const auditFile=join(receipts,'audit.json'),audit=await cli(home,['takeout','audit','--archive',archive,'--output',auditFile]);
  expect({code:audit.code,stderr:audit.stderr}).toEqual({code:0,stderr:''});
  expect(JSON.parse(audit.stdout)).toEqual({path:auditFile});
  expect(JSON.parse(readFileSync(auditFile,'utf8'))).toMatchObject({path:archive,integrity:true,complete:true,files:0});
  if(process.platform!=='win32')expect((await import('node:fs')).statSync(receipts).mode&0o777).toBe(0o755);
 }finally{
  await cli(home,['daemon','stop']).catch(()=>{});
  rmSync(home,{recursive:true,force:true});
 }
},15000);

test('queue CLI parses context, files and position without submitting paused drafts',async()=>{
 const home=mkdtempSync(join(tmpdir(),'apiplan-queue-cli-'));
 writeFileSync(join(home,'accounts.json'),JSON.stringify({version:1,selected:'fixture',accounts:[{id:'fixture',userId:'fixture-user',label:'Fixture',baseURL:'https://chatgpt.com',created:''}]}),{mode:0o600});
 try{
  const added=await cli(home,['queue','add','--conversation','fixture-chat','--text','draft','--client-id','cli:fixture-add','--file','/private/tmp/fixture-image.png']);expect({code:added.code,stderr:added.stderr}).toEqual({code:0,stderr:''});const item=JSON.parse(added.stdout).item;expect(item.draft).toMatchObject({conversation:'fixture-chat',text:'draft',files:['/private/tmp/fixture-image.png']});
  expect(item.clientId).toBe('cli:fixture-add');const retried=await cli(home,['queue','add','--conversation','fixture-chat','--text','draft','--client-id','cli:fixture-add','--file','/private/tmp/fixture-image.png']);expect(retried.code).toBe(0);expect(JSON.parse(retried.stdout).items).toHaveLength(1);expect(JSON.parse(retried.stdout).item.id).toBe(item.id);
  const edited=await cli(home,['queue','edit',item.id,'--text','edited']);expect(edited.code).toBe(0);
  const ordered=await cli(home,['queue','reorder',item.id,'--index','0']);expect(ordered.code).toBe(0);
  const run=await cli(home,['queue','run','--max-items','1']);expect(run.code).toBe(0);expect(JSON.parse(run.stdout).completedThisRun).toBe(0);
  const state=JSON.parse((await cli(home,['queue','status'])).stdout);expect(state.items[0].draft.text).toBe('edited');expect(state.items[0].phase).toBe('queued');
  const invalid=await cli(home,['queue','reorder',item.id,'--index','bad']);expect(invalid.code).toBe(1);expect(JSON.parse(invalid.stderr).code).toBe('QUEUE_INVALID_ORDER');
 }finally{await cli(home,['daemon','stop']).catch(()=>{});rmSync(home,{recursive:true,force:true});}
},15000);

test('takeout watch-status reads local checkpoint without daemon startup',async()=>{
 const home=mkdtempSync(join(tmpdir(),'apiplan-watch-status-cli-'));
 try{const result=await cli(home,['takeout','watch-status']);expect(result.code).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({source:'local durable recovery state',running:false});expect((await import('node:fs')).existsSync(join(home,'accounts','default','daemon.json'))).toBe(false);}
 finally{rmSync(home,{recursive:true,force:true});}
},5000);
