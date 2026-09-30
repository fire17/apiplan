/** Website-only conversation management. Never retries a mutation or guesses backend writes. */
export type ConversationBrowser={call(op:string,args?:any):Promise<any>};
export type ManagementAction='rename'|'archive'|'unarchive'|'pin'|'unpin'|'share'|'unshare';
const labels:Partial<Record<ManagementAction,string>>={rename:'Rename',archive:'Archive',pin:'Pin chat',unpin:'Unpin chat',share:'Share',unarchive:'Unarchive conversation'};
function one(rows:any[],reason:string){if(rows.length!==1)throw new Error(reason);return rows[0];}
function row(snapshot:any,id:string){return one(snapshot.controls.filter((c:any)=>c.href==='/c/'+id),'Conversation must have exactly one visible sidebar row; no action performed.');}
const rowTitle=(c:any)=>String(c.name||'').trim().replace(/, pinned conversation$/,'');
const unknown=()=>Object.assign(new Error('Conversation outcome unknown after one change. Inspect its current state before retrying; no write was replayed.'),{code:'UNKNOWN_OUTCOME'});
export class ConversationActions {
 constructor(private browser:ConversationBrowser,private surface='chat-management',private options:{attempts?:number;delayMs?:number}={}){if(surface==='main')throw new Error('Conversation management requires a dedicated surface.');}
 private call(op:string,args:any={}){return this.browser.call(op,{...args,surface:this.surface});}
 private async snapshot(){return this.call('snapshot');}
 private async click(s:any,c:any){if(c.disabled)throw new Error('Conversation control disabled.');await this.call('action',{kind:'click',ref:c.ref,epoch:s.epoch});}
 private async poll(predicate:(s:any)=>any){for(let i=0;i<(this.options.attempts??20);i++){const s=await this.snapshot(),result=predicate(s);if(result)return {s,result};await Bun.sleep(this.options.delayMs??150);}throw unknown();}
 async open(id:string){
  if(!/^[a-zA-Z0-9-]+$/.test(id))throw new Error('Invalid conversation ID.');
  const initial=await this.snapshot(),target=row(initial,id),title=rowTitle(target);
  // An exact href binds the target. Reject duplicate titles because the observed menu label uses title.
  if(initial.controls.filter((c:any)=>c.href?.startsWith('/c/')&&rowTitle(c)===title).length!==1)throw new Error('Ambiguous sidebar title; cannot safely bind its menu.');
  await this.call('hover',{ref:target.ref,epoch:initial.epoch});
  const opened=await this.poll(s=>{row(s,id);return s.controls.find((c:any)=>c.name==='Open conversation options for '+title&&!c.disabled);});
  const menu=one(opened.s.controls.filter((c:any)=>c.name==='Open conversation options for '+title&&!c.disabled),'Ambiguous conversation menu.');
  await this.click(opened.s,menu);
  const ready=await this.poll(s=>s.controls.some((c:any)=>c.role==='menuitem'&&c.name==='Rename'));
  return {snapshot:ready.s,title};
 }
 /** Read-only discovery. An empty dialog does not verify its absent restore controls. */
 async archived(){
  let s=await this.snapshot();
  const empty=(snap:any)=>snap.text?.includes('You have no archived conversations.')&&snap.controls.every((c:any)=>c.name==='Close');
  if(s.controls.some((c:any)=>c.name?.startsWith('Unarchive conversation ')))return {scope:'archived-dialog',empty:false,complete:false,restoreFlowVerified:true,controls:s.controls};
  if(empty(s))return {scope:'archived-dialog',empty:true,items:[],complete:false,restoreFlowVerified:false,reason:'Website reports no archived conversations; unarchive row controls remain unobserved.'};
  if(!s.controls.some((c:any)=>c.role==='tab'&&c.name==='Data controls')){
   const profile=one(s.controls.filter((c:any)=>c.testId==='accounts-profile-button'&&!c.disabled),'Cannot uniquely identify the profile menu.');await this.click(s,profile);
   const settings=await this.poll(s=>s.controls.find((c:any)=>c.role==='menuitem'&&c.name==='Settings'));await this.click(settings.s,settings.result);
   s=(await this.poll(s=>s.controls.some((c:any)=>c.role==='tab'&&c.name==='Data controls'))).s;
  }
  const tab=one(s.controls.filter((c:any)=>c.role==='tab'&&c.name==='Data controls'),'Cannot uniquely identify Data controls.');await this.click(s,tab);
  const manage=await this.poll(s=>s.controls.find((c:any)=>c.name==='Manage Archived chats'&&!c.disabled));await this.click(manage.s,manage.result);
  const dialog=await this.poll(s=>empty(s)||s.controls.some((c:any)=>c.href?.startsWith('/c/'))&&s.controls.some((c:any)=>/unarchive/i.test(c.name)));
  if(empty(dialog.s))return {scope:'archived-dialog',empty:true,items:[],complete:false,restoreFlowVerified:false,reason:'Website reports no archived conversations; unarchive row controls remain unobserved.'};
  return {scope:'archived-dialog',empty:false,complete:false,restoreFlowVerified:true,controls:dialog.s.controls,reason:'Visible archive controls captured; row binding, pagination and restore action require verification.'};
 }
 async manage(action:ManagementAction,args:{id:string;title?:string}){
  if(!labels[action])throw new Error('Unsupported conversation action: its website flow has not been observed. No control was clicked.');
  if(action==='rename'&&(!args.title?.trim()||args.title.length>500))throw new Error('Rename requires a nonempty title of at most 500 characters.');
  if(action==='unarchive'){
   await this.archived();const s=await this.snapshot(),target=row(s,args.id),title=rowTitle(target);
   if(s.controls.filter((c:any)=>c.href?.startsWith('/c/')&&rowTitle(c)===title).length!==1)throw new Error('Ambiguous archived title; no restore submitted.');
   const restore=one(s.controls.filter((c:any)=>c.name==='Unarchive conversation '+title&&!c.disabled),'Unarchive control not uniquely bound to the archived row.');
   await this.click(s,restore);await this.poll(s=>!s.controls.some((c:any)=>c.href==='/c/'+args.id));
   // The observed website does not invalidate its sidebar after restoration. Refresh only this owned surface.
   await this.call('surface.close');await this.call('surface.open',{url:'https://chatgpt.com/'});
   await this.poll(s=>s.controls.some((c:any)=>c.href==='/c/'+args.id));
   return {id:args.id,action,changed:true,verifiedUI:true,persistence:'Exact row removed from Archived chats and restored in freshly loaded sidebar.'};
  }
  const {snapshot,title}=await this.open(args.id);
  const receipt=(changed:boolean,extra:any={})=>({id:args.id,action,changed,verifiedUI:true,persistence:'Website state observed; server persistence not independently verified.',...extra});
  if(action==='rename'&&title===args.title){await this.call('key',{key:'Escape'});return receipt(false,{title});}
  const reverse=action==='pin'?'Unpin chat':action==='unpin'?'Pin chat':undefined;
  if(reverse&&snapshot.controls.some((c:any)=>c.role==='menuitem'&&c.name===reverse)){await this.call('key',{key:'Escape'});return receipt(false);}
  const target=one(snapshot.controls.filter((c:any)=>c.role==='menuitem'&&c.name===labels[action]&&!c.disabled),'Observed conversation action is not uniquely available.');
  await this.click(snapshot,target);
  if(action==='rename'){
   const input=await this.poll(s=>s.controls.find((c:any)=>c.tag==='input'&&c.name==='Chat title'&&c.value===title&&!c.disabled));
   const field=one(input.s.controls.filter((c:any)=>c.tag==='input'&&c.name==='Chat title'&&!c.disabled),'Ambiguous chat title input.');
   await this.call('action',{kind:'fill',ref:field.ref,epoch:input.s.epoch,text:args.title});await this.call('key',{key:'Enter'});
   await this.poll(s=>s.controls.some((c:any)=>c.href==='/c/'+args.id&&rowTitle(c)===args.title));return receipt(true,{title:args.title,previousTitle:title});
  }
  if(action==='pin'||action==='unpin'){
   // Read the inverse menu label to verify state, not merely the disappearance of a control.
   await this.call('key',{key:'Escape'});await this.poll(s=>s.controls.some((c:any)=>c.href==='/c/'+args.id));
   const after=await this.open(args.id);const verified=after.snapshot.controls.some((c:any)=>c.role==='menuitem'&&c.name===reverse);await this.call('key',{key:'Escape'});if(!verified)throw unknown();return receipt(true);
  }
  // Sharing activates its launcher only. Publishing and revoking have no verified flow yet.
  if(action==='share')return {id:args.id,action,changed:false,stage:'share-launcher-clicked',shared:false,complete:false,reason:'No publish or copy-link control was submitted; inspect the dialog for the next observed step.'};
  if(action==='archive'){await this.call('key',{key:'Escape'});await this.archived();const s=await this.snapshot(),archived=row(s,args.id);if(rowTitle(archived)!==title||!s.controls.some((c:any)=>c.name==='Unarchive conversation '+title&&!c.disabled))throw unknown();return receipt(true,{state:'archived',verification:'Exact archived row and its unarchive control observed.'});}
  throw unknown();
 }
}
