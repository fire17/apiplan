import {expect,test} from 'bun:test';
import {existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';

const armed=process.env.APIPLAN_OM_AGENT_PROOF==='1';
const requested=process.env.APIPLAN_OM_RUNTIME||'/Users/magic/.om/runtime-current';
const runtime=existsSync(requested)?realpathSync(requested):'';
const helper=join(import.meta.dir,'helpers','online-om-agent-host.ts');
test.skipIf(!armed||!runtime)('real OM Agent executes six fragmented online tool rounds, continues with correlated results, and propagates abort',async()=>{
 const proc=Bun.spawn(['bun',helper],{cwd:join(import.meta.dir,'..'),env:{...process.env,APIPLAN_OM_RUNTIME:runtime},stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,exitCode]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
 expect(exitCode,stderr||stdout).toBe(0);
 const result=JSON.parse(stdout.trim().split('\n').at(-1)!);
 expect(result).toMatchObject({complete:true,runtime,sequence:{ok:true},abort:{stopReason:'aborted',activeRequests:0,requestCountAfterAbort:8}});
 expect(result.executions).toHaveLength(6);expect(new Set(result.executions.map((row:any)=>row.id)).size).toBe(6);expect(new Set(result.executions.map((row:any)=>row.value)).size).toBe(6);
 expect(result.requests).toHaveLength(8);
 for(let i=0;i<7;i++){expect(result.requests[i].mode).toBe('Work');expect(result.requests[i].model).toBe('GPT-6 Astra');expect(result.requests[i].effort).toBe('Light');expect(result.requests[i].toolCallIds).toEqual(Array.from({length:i},(_,j)=>`call-${j+1}`));expect(result.requests[i].toolResultIds).toEqual(result.requests[i].toolCallIds);}
 expect(result.events).toMatchObject({tool_execution_start:6,tool_execution_end:6,turn_end:7});
 expect(result.sequence.finalText).toBe(result.sequence.expected);
 expect(result.abort.elapsedMs).toBeLessThan(2000);
});
