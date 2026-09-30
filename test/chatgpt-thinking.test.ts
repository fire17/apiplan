import {expect,test} from 'bun:test';
import {ThinkingTracker,type ThinkingEvent} from '../src/chatgpt/thinking.ts';

test('thinking tracker emits full observed state and append-only deltas',()=>{
 const first={id:'turn-7:thinking:reasoning',title:'Thinking',text:'Checking sources',expanded:true,status:'active'},events:ThinkingEvent[]=[];
 const tracker=new ThinkingTracker([first],true);
 expect(tracker.update([{...first,text:'Checking sources and dates'}],true,event=>events.push(event))).toBe(true);
 expect(events).toEqual([
  {type:'thinking',items:[{...first,text:'Checking sources and dates'}],active:true},
  {type:'thinking.delta',id:first.id,title:'Thinking',text:' and dates',replace:false,expanded:true},
 ]);
 expect(tracker.update([{...first,text:'Checking sources and dates'}],true,event=>events.push(event))).toBe(false);
 expect(events).toHaveLength(2);
});

test('thinking tracker marks rewritten visible text as replacement and never invents ids',()=>{
 const old={id:'turn-2:thinking:0',title:'Thought for 3s',text:'First observation',expanded:true},events:ThinkingEvent[]=[];
 const tracker=new ThinkingTracker([old]);
 tracker.update([{...old,title:'Thought for 4s',text:'Revised observation',expanded:false}],false,event=>events.push(event));
 expect(events[1]).toEqual({type:'thinking.delta',id:old.id,title:'Thought for 4s',text:'Revised observation',replace:true,expanded:false});
 expect(()=>tracker.update([{...old,id:''}],false,()=>{})).toThrow('require observed id');
});
