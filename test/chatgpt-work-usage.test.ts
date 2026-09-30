import {test,expect} from 'bun:test';
import {workUsageLimit} from '../src/chatgpt/work-usage.ts';
import {ChatGPTService} from '../src/chatgpt/service.ts';
const snapshot=(controls:any[]=[],notices:any[]=[],text='')=>({controls,notices,text,messages:[],media:[],epoch:'e',url:'https://chatgpt.com/',title:''});
test('Work exhaustion uses notices or selected Work meter, never quoted user prose',()=>{
 const warning='You’re out of Work usage for now. Add credits to keep using Work now, or wait for your usage to reset on Friday.';
 expect(workUsageLimit(snapshot([],[],warning))).toBeNull();
 expect(workUsageLimit(snapshot([],[{text:warning}]))?.code).toBe('WORK_USAGE_EXHAUSTED');
 const meter={name:'Open Work usage details. Weekly limit: 0% remaining.'};
 expect(workUsageLimit(snapshot([meter]))).toBeNull();
 expect(workUsageLimit(snapshot([meter,{name:'Work',role:'radio',checked:'true'}]))?.source).toBe('website Work usage meter');
});
test('fallback confirms Chat and uses its selected settings without retaining an unavailable Work model',async()=>{
 const calls:any[]=[],events:any[]=[];
 const actions={snapshot:async()=>snapshot([],[{text:"You're out of Work usage for now"}]),mode:async(mode:string)=>{calls.push(mode);return {verified:true};},options:async()=>({models:[{label:'Latest',selected:true}],selectedEffort:'Pro'})};
 const result=await ChatGPTService.prototype.workFallback.call({actions} as any,{mode:'Work',model:'GPT-6 Astra',effort:'High',text:'draft'},event=>events.push(event));
 expect(calls).toEqual(['Chat']);expect(result).toEqual({mode:'Chat',model:'Latest',effort:'Pro',text:'draft'});expect(events[0]).toMatchObject({type:'mode.fallback',verified:true,to:'Chat'});
});
test('unverified fallback does not report success or proceed',async()=>{
 const events:any[]=[];const actions={snapshot:async()=>snapshot([],[{text:"You're out of Work usage for now"}]),mode:async()=>({verified:false})};
 await expect(ChatGPTService.prototype.workFallback.call({actions} as any,{},event=>events.push(event))).rejects.toThrow('not verified');expect(events).toHaveLength(0);
});
