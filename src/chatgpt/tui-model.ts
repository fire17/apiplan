/** Website selection is committed to the TUI only after a verified receipt. */
export type SelectionContext={conversation?:string;project?:string;gpt?:string;new:boolean};
export class WebsiteSelection {
 pending=false;
 constructor(private rpc:(op:string,args:any)=>Promise<any>,private context:()=>SelectionContext,private generating:()=>boolean){}
 private async exclusive<T>(work:()=>Promise<T>):Promise<T>{
  if(this.generating())throw new Error('Stop generation with Ctrl+C before changing model or thinking effort.');
  if(this.pending)throw new Error('A model or thinking effort operation is already in progress. Wait for it to finish.');
  this.pending=true;
  try{return await work();}finally{this.pending=false;}
 }
 options(){return this.exclusive(()=>this.rpc('models.options',this.context()));}
 mode(mode:'Chat'|'Work'){return this.exclusive(async()=>{
  const receipt=await this.rpc('chat.mode',{...this.context(),mode});
  if(receipt?.verified!==true)throw new Error('The website did not verify the mode change. The displayed mode was preserved.');
  return {mode,receipt};
 });}
 change(kind:'model'|'effort',label:string){return this.exclusive(async()=>{
  if(!label.trim())throw new Error('Choose an exact website '+kind+' label.');
  const receipt=await this.rpc('chat.'+kind,{...this.context(),[kind]:label});
  if(receipt?.verified!==true)throw new Error('The website did not verify the '+kind+' change. The displayed selection was preserved.');
  return {label:typeof receipt.selected==='string'?receipt.selected:label,receipt};
 });}
}
