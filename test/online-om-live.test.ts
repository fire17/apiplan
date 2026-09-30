import {test,expect} from 'bun:test';
import {join} from 'node:path';

test.skipIf(process.env.APIPLAN_ONLINE_LIVE!=='1')('real OM completes five Chat/Instant website tool-result rounds',async()=>{
 const child=Bun.spawn([process.execPath,join(import.meta.dir,'helpers/online-om-live.ts')],{env:{...process.env,ONLINE_TEST_SETUP_ONLY:''},stdout:'inherit',stderr:'inherit'});
 expect(await child.exited).toBe(0);
},20*60*1000);
