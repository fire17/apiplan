import {expect,test} from 'bun:test';
import {ModelControls} from '../src/chatgpt/model-controls.ts';
import type {Snapshot} from '../src/chatgpt/actions.ts';
const snapshot=(context:string):Snapshot=>({epoch:'e',url:'https://chatgpt.com/',title:'',text:'',messages:[],media:[],controls:[{name:'Power',role:'menuitem',ref:1,context}]});
test('effort step waits for both new index and new label before confirming',async()=>{
 let pressed=false,reads=0;
 const a:any={snapshot:async()=>snapshot(!pressed?'Light, 1 of 3.':++reads<3?'Light, 2 of 3.':'Medium, 2 of 3.'),b:{call:async(op:string,args:any)=>{if(op==='key'){expect(args.key).toBe('ArrowRight');pressed=true;}}}};
 const controls=new ModelControls(a);const initial=await controls.settledPower();const next=await controls.step(initial,1);
 expect(next.index).toBe(2);expect(next.label).toBe('Medium');expect(reads).toBeGreaterThanOrEqual(5);
});
test('restoration moves using confirmed website positions and retains original label',async()=>{
 let index=3;const names=['Light','Medium','High'];
 const a:any={snapshot:async()=>snapshot(names[index-1]+', '+index+' of 3.'),b:{call:async(op:string,args:any)=>{if(op==='key')index+=args.key==='ArrowLeft'?-1:1;}}};
 const result=await new ModelControls(a).restorePower(1);expect(result.index).toBe(1);expect(result.label).toBe('Light');
});
