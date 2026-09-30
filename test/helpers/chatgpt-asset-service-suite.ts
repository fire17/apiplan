import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const TEST_HOME=mkdtempSync(join(tmpdir(),'apiplan-chatgpt-transfer-'));
process.env.CHATGPT_HOME=TEST_HOME;
const {ChatGPTService}=await import('../../src/chatgpt/service.ts');

test('service consumes and removes private transfers on success and integrity failure',async()=>{
 const account={id:'transfer',label:'Transfer',baseURL:'https://chatgpt.com',created:'2026-09-15T00:00:00.000Z',source:{provider:'managed' as const}};
 const service=Object.create(ChatGPTService.prototype) as InstanceType<typeof ChatGPTService>;
 Object.assign(service,{account,requestQueue:Promise.resolve(),nextRequestAt:0,rateLimitedUntil:0,rateFailures:0,limitedScope:'',conversationReadsPaused:false,store:{bindIdentity:()=>{}}});
 let transferPath='';
 service.browser={call:async(_op:string,args:any)=>{
  transferPath=join(args.directory,'asset-fixture.part');const bytes=Buffer.from('streamed fixture');writeFileSync(transferPath,bytes,{mode:0o600});
  return {status:200,path:transferPath,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 }} as any;
 try{
  const success=await service.request('/backend-api/estuary/content?id=fixture','GET',undefined,true);
  expect(Buffer.from(success.bytes).toString()).toBe('streamed fixture');
  expect(success.path).toBeUndefined();
  expect(existsSync(transferPath)).toBe(false);

  service.browser={call:async(_op:string,args:any)=>{transferPath=join(args.directory,'bad.part');writeFileSync(transferPath,'damaged',{mode:0o600});return {status:200,path:transferPath,size:7,sha256:'0'.repeat(64)};}} as any;
  await expect(service.request('/backend-api/estuary/content?id=bad','GET',undefined,true)).rejects.toThrow('integrity mismatch');
  expect(existsSync(transferPath)).toBe(false);
 }finally{rmSync(TEST_HOME,{recursive:true,force:true});}
});
