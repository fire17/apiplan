import type {Actions,Snapshot} from './actions.ts';

function control(snapshot:Snapshot,name:string){const matches=snapshot.controls.filter(c=>c.name?.trim()===name&&!c.disabled);if(matches.length!==1)throw new Error('Setting must match exactly one enabled control. Inspect the selected settings section.');return matches[0];}
function current(c:any,value:string){return c.role==='switch'||c.role==='checkbox'?String(c.checked)===value:c.value===value||c.context?.split('\n').map((v:string)=>v.trim()).includes(value);}

/** One explicit setting, fresh references, no guessed save/confirmation clicks. */
export async function setSetting(actions:Actions,args:{section:string;name:string;value:string;commit?:string}){
 if(!args.section||!args.name||args.value===undefined)throw new Error('settings set requires --section, --name and --value.');
 const value=String(args.value),before=await actions.settings(args.section),target=control(before,args.name);
 const receipt=(changed:boolean,c:any)=>({section:args.section,name:args.name,value,changed,verifiedUI:true,persistence:'Website state observed; server persistence not independently verified.',control:{role:c.role||c.tag,checked:c.checked,value:c.value,context:c.context}});
 if(current(target,value))return receipt(false,target);
 if(target.role==='switch'||target.role==='checkbox'){
  if(!['true','false'].includes(value))throw new Error('Switch values must be true or false.');
  await actions.press(before,target);
 }else if(target.role==='combobox'){
  await actions.press(before,target);
  const option=await actions.find(c=>c.name?.trim()===value&&['option','menuitemradio','radio'].includes(c.role)&&!c.disabled);
  await actions.press(option.s,option.c);
 }else if(['textarea','input'].includes(target.tag)||target.role==='textbox'){
  if(['password','file'].includes(target.type))throw new Error('Use the dedicated website flow for this input.');
  await actions.b.call('action',{kind:'fill',ref:target.ref,epoch:before.epoch,text:value});
  if(args.commit)await actions.named(args.commit);
 }else throw new Error('This setting needs a mapped website flow. No control was clicked.');
 for(let i=0;i<40;i++){const snapshot=await actions.snapshot(),matches=snapshot.controls.filter(c=>c.name?.trim()===args.name);if(matches.length===1&&current(matches[0],value))return receipt(true,matches[0]);await Bun.sleep(125);}
 throw new Error('Setting outcome unknown after one change. Inspect its current state before retrying; no write was replayed.');
}
