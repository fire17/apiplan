import {test,expect} from 'bun:test';
import {join} from 'node:path';
const python=Bun.spawnSync(['python3','-c','import ast,sys; t=ast.parse(open(sys.argv[1]).read()); f=next(n for n in ast.walk(t) if isinstance(n,ast.AsyncFunctionDef) and n.name=="snapshot"); print(next(n.value for n in ast.walk(f) if isinstance(n,ast.Constant) and isinstance(n.value,str) and n.value.startswith("(()=>")))',join(import.meta.dir,'../src/chatgpt/browser.py')]);
if(python.exitCode!==0)throw Error('Cannot extract snapshot function');
const script=python.stdout.toString();
function element(tag:string,text:string,attrs:any={},visible=true){const e:any={tagName:tag.toUpperCase(),innerText:text,textContent:text,id:'',tabIndex:attrs.tabindex?Number(attrs.tabindex):-1,disabled:false,parentElement:{innerText:'x'.repeat(599)+'😀tail'},getAttribute:(k:string)=>attrs[k]??null,getClientRects:()=>visible?[{}]:[],getBoundingClientRect:()=>({x:10,y:10,width:100,height:30,right:110,bottom:40}),checkVisibility:()=>visible,closest:()=>null,contains:(other:any)=>other===e};return e;}
function snapshot(elements:any[],messages:any[]=[],turns:any[]=[],browserWindow:any={crypto},noticeNodes:any[]=[]){const document:any={title:'Fixture',body:{innerText:'Fixture'},getElementById:()=>null,elementFromPoint:()=>elements[0],querySelectorAll:(selector:string)=>selector==='[data-message-author-role]'?messages:selector==='[data-testid^="conversation-turn-"]'?turns:selector.startsWith('[role="alert"]')?noticeNodes:selector.startsWith('h1,h2')?[]:selector.startsWith('main img')?[]:elements.filter(e=>e.tagName==='BUTTON'||selector.includes('[tabindex]')&&e.tabIndex>=0)};return new Function('document','getComputedStyle','window','innerWidth','innerHeight','location','return '+script)(document,()=>({visibility:'visible',display:'block'}),browserWindow,1000,1000,{href:'https://chatgpt.com/'});}
test('keyboard-only div menu triggers are captured and hidden controls kept separate',()=>{const result=snapshot([element('div','More',{tabindex:'0','aria-haspopup':'menu'}),element('button','Hidden',{},false)]);expect(result.controls.map(c=>c.name)).toEqual(['More']);expect(result.controls[0].hasPopup).toBe('menu');expect(result.hiddenControls[0].name).toBe('Hidden');expect(result.coverage.complete).toBe(false);});
test('context truncation does not split emoji into unpaired surrogates',()=>{const result=snapshot([element('button','Example')]);expect(result.controls[0].context.endsWith('😀')).toBe(true);expect(result.controls[0].context.isWellFormed()).toBe(true);});
test('background message text falls back to textContent without browser focus',()=>{const m={getAttribute:(k:string)=>k==='data-message-id'?'m':'assistant',innerText:'',textContent:'BACKGROUND_OK'};expect(snapshot([], [m]).messages[0].text).toBe('BACKGROUND_OK');});
test('a site-visible roleless turn after an explicit user is captured as a provenance-marked assistant',()=>{
 let userTurn:any,assistantTurn:any;
 const user:any={innerText:'User prompt',textContent:'User prompt',closest:(selector:string)=>selector.startsWith('[data-testid^=')?userTurn:null,getAttribute:(key:string)=>key==='data-message-id'?'user-1':key==='data-message-author-role'?'user':null};
 userTurn={innerText:'User prompt',textContent:'User prompt',contains:(node:any)=>node===user,getAttribute:(key:string)=>key==='data-testid'?'conversation-turn-9':null,querySelector:(selector:string)=>selector==='[data-message-author-role]'?user:null,querySelectorAll:()=>[]};
 assistantTurn={innerText:'Observed answer\nPrepared the protocol package',textContent:'Observed answer\nPrepared the protocol package',contains:()=>false,getAttribute:(key:string)=>key==='data-testid'?'conversation-turn-10':null,querySelector:()=>null,querySelectorAll:()=>[]};
 const inTurnAlert:any={innerText:'Something went wrong in quoted content',textContent:'Something went wrong in quoted content',getAttribute:(key:string)=>key==='role'?'alert':null,closest:(selector:string)=>selector.startsWith('[data-testid^=')?assistantTurn:null,getClientRects:()=>[{}]};
 const result=snapshot([],[user],[userTurn,assistantTurn],{crypto},[inTurnAlert]);
 expect(result.messages).toEqual([{id:'user-1',domTurnId:'conversation-turn-9',role:'user',text:'User prompt'},{id:'dom:conversation-turn-10',domTurnId:'conversation-turn-10',role:'assistant',text:'Observed answer\nPrepared the protocol package',identitySource:'dom-turn',source:'site-visible roleless assistant turn'}]);
 expect(result.notices).toEqual([]);
});
test('a roleless activity-only turn is not promoted to an assistant answer',()=>{
 let userTurn:any;
 const user:any={innerText:'User prompt',textContent:'User prompt',closest:(selector:string)=>selector.startsWith('[data-testid^=')?userTurn:null,getAttribute:(key:string)=>key==='data-message-id'?'user-1':key==='data-message-author-role'?'user':null};
 userTurn={innerText:'User prompt',textContent:'User prompt',getAttribute:(key:string)=>key==='data-testid'?'conversation-turn-7':null,querySelector:(selector:string)=>selector==='[data-message-author-role]'?user:null,querySelectorAll:()=>[]};
 const activity:any={innerText:'Stopped thinking\nSources',textContent:'Stopped thinking\nSources',getAttribute:(key:string)=>key==='data-testid'?'conversation-turn-8':null,querySelector:()=>null,querySelectorAll:()=>[]};
 expect(snapshot([],[user],[userTurn,activity]).messages).toEqual([{id:'user-1',domTurnId:'conversation-turn-7',role:'user',text:'User prompt'}]);
});
test('current roleless Pro thinking is activity while its visible commentary remains assistant text',()=>{
 let userTurn:any,assistantTurn:any;
 const user:any={innerText:'Prompt',textContent:'Prompt',closest:(selector:string)=>selector.startsWith('[data-testid^=')?userTurn:null,getAttribute:(key:string)=>key==='data-message-id'?'user-2':key==='data-message-author-role'?'user':null};
 userTurn={innerText:'Prompt',textContent:'Prompt',getAttribute:(key:string)=>key==='data-testid'?'conversation-turn-9':null,querySelector:(selector:string)=>selector==='[data-message-author-role]'?user:null,querySelectorAll:()=>[]};
 const activity:any={tagName:'DIV',innerText:'Pro thinking',textContent:'Pro thinking',id:'',parentElement:null,getAttribute:()=>null,closest:()=>null,matches:()=>false,querySelectorAll:()=>[],contains:()=>false};
 assistantTurn={innerText:'Visible commentary\nPrepared the protocol package\nPro thinking',textContent:'Visible commentary\nPrepared the protocol package\nPro thinking',contains:(node:any)=>node===activity,getAttribute:(key:string)=>key==='data-testid'?'conversation-turn-10':null,querySelector:()=>null,querySelectorAll:(selector:string)=>selector.startsWith('h1')?[activity]:[]};
 const result=snapshot([],[user],[userTurn,assistantTurn]);
 expect(result.messages.at(-1)).toMatchObject({id:'dom:conversation-turn-10',domTurnId:'conversation-turn-10',role:'assistant',text:'Visible commentary\nPrepared the protocol package',identitySource:'dom-turn'});
 expect(result.thinking.at(-1)).toEqual({id:'conversation-turn-10:thinking:0',title:'Pro thinking',text:'',expanded:false,status:'not-expandable'});
});
test('expanded site thinking is scoped to its assistant turn with a stable DOM id',()=>{
 const trigger:any={tagName:'SUMMARY',innerText:'Thinking',textContent:'Thinking',getAttribute:(key:string)=>key==='aria-expanded'?'true':null,closest:()=>details};
 const details:any={tagName:'DETAILS',id:'reasoning-panel',open:true,innerText:'Thinking\nObserved detail only',textContent:'Thinking\nObserved detail only',getAttribute:()=>null,matches:()=>false,querySelector:()=>trigger,querySelectorAll:()=>[trigger]};
 const message:any={innerText:'Final answer',textContent:'Final answer',getAttribute:(key:string)=>key==='data-message-author-role'?'assistant':key==='data-message-id'?'message-1':null,closest:(selector:string)=>selector.startsWith('[data-testid^=')?turn:null};
 const turn:any={contains:(node:any)=>node===details||node===trigger,getAttribute:(key:string)=>key==='data-testid'?'conversation-turn-4':null,querySelector:()=>message,querySelectorAll:(selector:string)=>selector.startsWith('details')?[details]:[trigger]};
 const browserWindow:any={crypto},result=snapshot([],[message],[turn],browserWindow);
 expect(result.thinking).toEqual([{id:'conversation-turn-4:thinking:reasoning-panel',title:'Thinking',text:'Observed detail only',expanded:true}]);
 expect(result.messages[0].text).toBe('Final answer');
 expect(result.thinking[0].text).not.toContain(result.messages[0].text);
 expect(browserWindow.__apiplanThinking.items[0]).toMatchObject({id:result.thinking[0].id,turn,trigger});
});
test('visible semantic alerts become bounded notices',()=>{
 const alert:any={id:'work-limit',innerText:'Work usage limit reached',textContent:'Work usage limit reached',getAttribute:(key:string)=>key==='role'?'alert':null,closest:()=>null,getClientRects:()=>[{}]};
 expect(snapshot([],[],[],{crypto},[alert]).notices).toEqual([{id:'work-limit',role:'alert',text:'Work usage limit reached'}]);
});
test('observed thinking labels without expansion semantics are never presented as expandable',()=>{
 const label:any={tagName:'DIV',innerText:'Worked for 16s',textContent:'Worked for 16s',id:'',parentElement:null,getAttribute:()=>null,closest:()=>null,matches:()=>false,querySelectorAll:()=>[],contains:()=>false};
 const message:any={getAttribute:(key:string)=>key==='data-message-author-role'?'assistant':null};
 const turn:any={contains:(node:any)=>node===label,getAttribute:()=> 'conversation-turn-2',querySelector:()=>message,querySelectorAll:(selector:string)=>selector.startsWith('h1')?[label]:[]};
 expect(snapshot([],[],[turn]).thinking).toEqual([{id:'conversation-turn-2:thinking:0',title:'Worked for 16s',text:'',expanded:false,status:'not-expandable'}]);
});
test('an observed stopped-thinking label is captured exactly without implying expandable details',()=>{
 const label:any={tagName:'DIV',innerText:'Stopped thinking',textContent:'Stopped thinking',id:'',parentElement:null,getAttribute:()=>null,closest:()=>null,matches:()=>false,querySelectorAll:()=>[],contains:()=>false};
 const message:any={getAttribute:(key:string)=>key==='data-message-author-role'?'assistant':null};
 const turn:any={contains:(node:any)=>node===label,getAttribute:()=> 'conversation-turn-stopped',querySelector:()=>message,querySelectorAll:(selector:string)=>selector.startsWith('h1')?[label]:[]};
 expect(snapshot([],[],[turn]).thinking).toEqual([{id:'conversation-turn-stopped:thinking:0',title:'Stopped thinking',text:'',expanded:false,status:'not-expandable'}]);
});
test('timed Thought labels preserve all expanded site-visible text',()=>{
 const trigger:any={tagName:'SUMMARY',innerText:'Thought for 4s',textContent:'Thought for 4s',getAttribute:()=>null,closest:()=>details};
 const details:any={tagName:'DETAILS',id:'thought-panel',open:true,innerText:'Thought for 4s\nFirst observed line\nSecond observed line',textContent:'Thought for 4s\nFirst observed line\nSecond observed line',getAttribute:()=>null,matches:()=>false,querySelector:()=>trigger,querySelectorAll:()=>[trigger]};
 const message:any={getAttribute:(key:string)=>key==='data-message-author-role'?'assistant':null};
 const turn:any={contains:(node:any)=>node===details||node===trigger,getAttribute:()=> 'conversation-turn-3',querySelector:()=>message,querySelectorAll:(selector:string)=>selector.startsWith('details')?[details]:[trigger]};
 expect(snapshot([],[],[turn]).thinking[0]).toEqual({id:'conversation-turn-3:thinking:thought-panel',title:'Thought for 4s',text:'First observed line\nSecond observed line',expanded:true});
});
