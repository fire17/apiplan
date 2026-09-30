import type {Actions,Snapshot} from './actions.ts';
const normalized=(s:any)=>String(s||'').replace(/\s+/g,' ').trim();
const label=(c:any)=>c?.name?.split('\n')[0].trim();
const selected=(c:any)=>c.checked===true||c.checked==='true'||c.selected===true||c.selected==='true';
const responses=(s:Snapshot)=>s.controls.some(c=>c.testId==='stop-button'||/^(Stop answering|Stop generating|Stop streaming|Stop response|Cancel loading)$/.test(c.name));
const modelRows=(s:Snapshot)=>s.controls.filter(c=>(c.role==='menuitemradio'||c.role==='option')&&!['Chat','Work'].includes(c.name));
const power=(s:Snapshot)=>{const row=s.controls.find(c=>c.name==='Power'&&c.role==='menuitem'&&!c.disabled),m=row?.context?.match(/^(.+?),\s*(\d+) of (\d+)\./);return m?{row,label:m[1],index:Number(m[2]),total:Number(m[3]),snapshot:s}:null;};
const root=(s:Snapshot)=>!!power(s)||s.controls.some(c=>c.name==='Select model'&&c.role==='menuitem');
const menuVisible=(s:Snapshot)=>s.controls.some(c=>['menuitem','menuitemradio','menuitemcheckbox','option'].includes(c.role));
const trigger=(c:any)=>!c.disabled&&((c.name==='Select model'&&c.tag==='button')||/^(?:GPT|ChatGPT)[-\s].*(?:Light|Medium|High|Pro|Instant|Ultra|Standard|Extended|Thinking|Heavy)$/.test(normalized(c.name))||/^(?:[\d.]+\s*)?(?:Pro|High|Medium|Low|Light|Standard|Extended|Extra High|Thinking|Instant|Heavy|Ultra)$/.test(normalized(c.name)));
export class ModelControls {
 constructor(private a:Actions){}
 async idle(){const s=await this.a.snapshot();if(responses(s))throw new Error('A response is running. Stop it before changing model, effort, or mode.');return s;}
 async close(){
  await this.a.b.call('key',{key:'Escape'});await Bun.sleep(180);await this.a.b.call('key',{key:'Escape'});
  let absent=0;
  for(let i=0;i<24;i++){
   const s=await this.a.snapshot();if(!modelRows(s).length){if(++absent>=2)return;}else absent=0;
   if(i===3&&menuVisible(s)){
    const composer=s.controls.find(c=>c.role==='textbox'&&c.name==='Chat with ChatGPT');
    if(composer){await this.a.press(s,composer);await this.a.b.call('key',{key:'Escape'});}
    // Isolated unit adapters may expose a fixed menu without a surrounding page.
    else if(!s.controls.some(trigger))return;
   }
   if(i===7&&modelRows(s).length){const button=s.controls.find(trigger);if(button)await this.a.press(s,button);}
   await Bun.sleep(150);
  }
  throw new Error('Model menu did not close. No further selection was attempted.');
 }
 async picker(){
  let s=await this.idle();
  if(root(s)&&!modelRows(s).length)return s;
  if(modelRows(s).length){await this.close();s=await this.a.snapshot();}
  if(root(s))return s;
  const target=await this.a.find(trigger);await this.a.press(target.s,target.c);
  let stable=0;
  for(let i=0;i<40;i++){
   s=await this.a.snapshot();if(root(s)&&!modelRows(s).length){if(++stable>=2)return s;}else stable=0;
   await Bun.sleep(150);
  }
  throw new Error('Model picker root did not expose its controls. Capture a fresh snapshot.');
 }
 async menu(){
  let s=await this.idle();if(modelRows(s).length)return s;s=await this.picker();
  const c=s.controls.find(c=>c.name==='Select model'&&c.role==='menuitem'&&!c.disabled);if(!c)throw new Error('Model submenu is unavailable.');await this.a.press(s,c);
  for(let i=0;i<30;i++){s=await this.a.snapshot();if(modelRows(s).length)return s;await Bun.sleep(150);}throw new Error('Model options did not load.');
 }
 async settledPower(expected?:number,previousLabel?:string){
  let signature='',stable=0;
  for(let i=0;i<32;i++){
   const state=power(await this.a.snapshot());
   if(state&&state.total<=12&&(expected===undefined||state.index===expected)&&(previousLabel===undefined||state.label!==previousLabel)){
    const next=state.index+':'+state.total+':'+state.label;stable=next===signature?stable+1:1;signature=next;if(stable>=3)return state;
   }else{signature='';stable=0;}
   await Bun.sleep(150);
  }
  throw new Error('Effort slider did not settle at its expected position and label. Inspect the website before retrying.');
 }
 async step(state:NonNullable<ReturnType<typeof power>>,direction:-1|1){
  const target=state.index+direction;if(target<1||target>state.total)return state;
  const current=await this.settledPower(state.index);
  await this.a.b.call('action',{kind:'focus',ref:current.row.ref,epoch:current.snapshot.epoch});
  await this.a.b.call('key',{key:direction<0?'ArrowLeft':'ArrowRight'});
  return this.settledPower(target,current.label);
 }
 async restorePower(index:number){
  let state=await this.settledPower();for(let attempts=0;state.index!==index&&attempts<12;attempts++)state=await this.step(state,state.index>index?-1:1);
  if(state.index!==index)throw new Error('Effort restoration was not confirmed.');return state;
 }
 async mode(wanted:string){wanted=/^work$/i.test(wanted)?'Work':/^chat$/i.test(wanted)?'Chat':wanted;if(!['Chat','Work'].includes(wanted))throw new Error('Mode must be Chat or Work.');await this.idle();await this.close();let s=await this.a.snapshot();const c=s.controls.find(c=>c.role==='radio'&&c.name===wanted&&!c.disabled);if(!c)throw new Error('This conversation does not expose Chat/Work switching. Start a new conversation in the requested mode.');if(!selected(c))await this.a.press(s,c);for(let i=0;i<40;i++){s=await this.a.snapshot();const current=s.controls.find(c=>c.role==='radio'&&c.name===wanted);if(current&&selected(current))return {kind:'mode',selected:wanted,verified:true,via:'website selected mode',url:s.url};await Bun.sleep(100);}throw new Error('Mode outcome unknown. Inspect the website before retrying.');}
 async options(){
  await this.idle();await this.close();const base=await this.a.snapshot(),modes=base.controls.filter(c=>c.role==='radio'&&['Chat','Work'].includes(c.name)).map(c=>c.name),mode=base.controls.find(c=>c.role==='radio'&&['Chat','Work'].includes(c.name)&&selected(c))?.name;
  try{
   const s=await this.menu(),models=modelRows(s).map(c=>({label:label(c),description:c.name,selected:selected(c)}));await this.close();const menu=await this.picker();
   if(!power(menu))return {models,efforts:[],mode,modes,via:'observed website picker',effortAvailable:false,powerRestored:true};
   const initial=await this.settledPower(),efforts:string[]=[];
   try{let state=await this.restorePower(1);for(;;){efforts.push(state.label);if(state.index===state.total)break;state=await this.step(state,1);}}
   finally{const restored=await this.restorePower(initial.index);if(restored.label!==initial.label)throw new Error('Effort restoration label was not confirmed.');}
   return {models,efforts,mode,modes,selectedEffort:initial.label,via:'observed website picker',powerRestored:true};
  }finally{await this.close();}
 }
 async choose(kind:'model'|'effort',wanted:string){
  if(!wanted?.trim())throw new Error('Supply the exact website option label.');wanted=wanted.trim();await this.idle();await this.close();
  try{
   if(kind==='model'){
    const s=await this.menu(),rows=modelRows(s),matches=rows.filter(c=>label(c)===wanted||c.name.trim()===wanted);if(matches.length!==1)throw new Error('Model unavailable or ambiguous. Observed options: '+rows.map(label).join(', '));
    if(!selected(matches[0]))await this.a.press(s,matches[0]);await this.close();const next=await this.menu(),actual=modelRows(next).find(c=>selected(c));if(label(actual)!==label(matches[0]))throw new Error('Model outcome unknown: the website did not confirm the requested selection.');return {selected:label(actual),kind,verified:true,via:'website selected model',url:next.url};
   }
   const s=await this.picker();if(!power(s))throw new Error('Effort slider unavailable. Inspect the model picker.');
   const initial=await this.settledPower(),available:string[]=[];let found=false;
   try{
    let state=await this.restorePower(1);
    for(;;){available.push(state.label);if(state.label.toLowerCase()===wanted.toLowerCase()){found=true;return {selected:state.label,kind,verified:true,position:state.index,via:'website selected effort'};}if(state.index===state.total)break;state=await this.step(state,1);}
    throw new Error('Effort unavailable. Restored previous power. Observed options: '+available.join(', '));
   }finally{if(!found)await this.restorePower(initial.index);}
  }finally{await this.close();}
 }
}
