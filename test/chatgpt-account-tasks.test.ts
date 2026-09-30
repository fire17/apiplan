import {test,expect} from 'bun:test';
import {listTasks} from '../src/chatgpt/account-tasks.ts';
test('task_id pagination preserves raw task fields, every page and encoded cursors',async()=>{
 const pages=[{tasks:[{task_id:'one',messages:[{nested:'kept'}],status:'interrupted'}],cursor:'opaque/+='},{tasks:[{task_id:'two',final_message:null}],cursor:null}],paths:string[]=[];
 const r=await listTasks(async p=>{paths.push(p);return pages[paths.length-1];},'/backend-api/tasks');
 expect(r.complete).toBe(true);expect(r.items).toEqual(pages.flatMap(p=>p.tasks));expect(r.rawPages).toEqual(pages);expect(paths[1]).toBe('/backend-api/tasks?cursor=opaque%2F%2B%3D');expect(r.coverage.pages).toBe(2);
});
test('empty explicit terminal response closes only the observed task scope',async()=>{
 expect((await listTasks(async()=>({tasks:[],cursor:null}),'/tasks')).complete).toBe(true);
 expect((await listTasks(async()=>({tasks:[]}),'/tasks')).complete).toBe(false);
});
test('contradictions, unknown identities and repeated cursors remain explicit gaps',async()=>{
 for(const raw of [{tasks:[],cursor:null,hasMore:true},{tasks:[],cursor:null,total:3},{tasks:[{}],cursor:null},{tasks:[],cursor:42},{tasks:[],cursor:'a',next_cursor:'b'},{tasks:[],cursor:'a',has_more:false}]){
  const r=await listTasks(async()=>raw,'/tasks');expect(r.complete).toBe(false);expect(r.rawPages).toEqual([raw]);
 }
 const r=await listTasks(async()=>({tasks:[{task_id:'same'}],cursor:'repeat'}),'/tasks');expect(r.complete).toBe(false);expect(r.coverage.pages).toBe(2);expect(r.items).toHaveLength(1);
});
test('budget and network errors never become a complete task catalog',async()=>{
 const r=await listTasks(async()=>({tasks:[{task_id:'x'}],cursor:'next'}),'/tasks',{maxPages:1});expect(r.complete).toBe(false);expect(r.coverage.reason).toContain('budget');
 await expect(listTasks(async()=>{throw new Error('429');},'/tasks')).rejects.toThrow('429');
 await expect(listTasks(async()=>({}),'/tasks',{maxPages:0})).rejects.toThrow('budget');
});
