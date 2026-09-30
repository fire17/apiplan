import {expect,test} from 'bun:test';
import {mergeThinking,thinkingLines,generationIndicator} from './tui-thinking.ts';
test('retains observed thinking when the website removes its active panel',()=>{
 const first=mergeThinking([],{items:[{id:'a',title:'Checking sources',text:'Observed details',expanded:true}]});
 const next=mergeThinking(first,{items:[],active:false});
 expect(next).toEqual(first);
 expect(thinkingLines(next,true).join('\n')).toContain('Observed details');
 expect(thinkingLines(next,false).join('\n')).not.toContain('Observed details');
 expect(thinkingLines(next,false).join('\n')).toContain('Checking sources');
});
test('updates snapshots without duplicating text and appends explicit deltas',()=>{
 const first=mergeThinking([],{items:[{id:'a',title:'Thinking',text:'one'}]});
 const snapshot=mergeThinking(first,{items:[{id:'a',text:'one two'}]});
 expect(snapshot).toHaveLength(1);expect(snapshot[0].text).toBe('one two');
 expect(mergeThinking(snapshot,{type:'thinking.delta',id:'a',text:' three'})[0].text).toBe('one two three');
 expect(first[0].text).toBe('one');
});
test('spinner advances without claiming additional website detail',()=>{
 expect(generationIndicator(1000,1200,true)).toContain('Thinking · 0s');
 expect(generationIndicator(1000,2200)).toContain('Responding · 1s');
 expect(generationIndicator(1000,1100)).not.toBe(generationIndicator(1000,1200));
});

test('current observed thinking label excludes completed historical work',async()=>{const {currentThinkingLabel}=await import('./tui-thinking.ts');expect(currentThinkingLabel([{id:'old',title:'Worked for 4m 3s',text:''},{id:'new',title:'Pro thinking',text:''}])).toBe('Pro thinking');expect(currentThinkingLabel([{id:'old',title:'Stopped thinking',text:''}])).toBe('');expect(generationIndicator(0,1000,true,'responding','Pro thinking')).toContain('Pro thinking');});
