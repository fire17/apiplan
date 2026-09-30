import {BrowserWorker} from './transport.ts';
import {ALLOW_WHILE_FROZEN} from './freeze.ts';
import {mapSettings,exportAcknowledged} from './settings-map.ts';
import {statSync} from 'node:fs';
import {join} from 'node:path';
async function fresh(name:string){const path=join(import.meta.dir,'fresh.ts');return (await import(path+'?revision='+statSync(path).mtimeMs)).fresh(name);}
import {adapter} from './adapters.ts';

export type Snapshot={epoch:string;url:string;title:string;text:string;controls:any[];messages:any[];media:any[];thinking?:any[];notices?:any[]};
export class Actions {
 constructor(public b:BrowserWorker,public readReceipt?: (path:string)=>Promise<any>){}
 async snapshot():Promise<Snapshot>{return this.b.call('snapshot');}
 async find(predicate:(c:any)=>boolean,timeout=10000){const end=Date.now()+timeout;do{const s=await this.snapshot();const choices=s.controls.filter(predicate);if(choices.length===1)return {s,c:choices[0]};if(choices.length>1)throw new Error('More than one matching control. Use an explicit UI reference.');await Bun.sleep(150);}while(Date.now()<end);throw new Error('The expected ChatGPT control is not available. Use ui snapshot to inspect the current page.');}
 async click(predicate:(c:any)=>boolean){const {s,c}=await this.find(predicate);await this.b.call('action',{ref:c.ref,epoch:s.epoch,kind:'click'});return c;}
 async named(name:string,role?:string){return this.click(c=>c.name.trim()===name&&(!role||c.role===role));}
 async settings(section?:string){let s=await this.snapshot();if(!s.controls.some(c=>c.role==='tab'&&c.name==='General')){const profiles=s.controls.filter(c=>c.testId==='accounts-profile-button'&&!c.disabled).sort((a,b)=>(b.rect?.width||0)-(a.rect?.width||0));if(!profiles.length)throw new Error('Account profile button not available.');await this.press(s,profiles[0]);await this.named(adapter().labels.settings[0],'menuitem');}await this.find(c=>c.role==='tab'&&c.name==='General');if(section)await this.named(section,'tab');await Bun.sleep(250);return this.snapshot();}
 async press(s:Snapshot,c:any){if(c.disabled)throw new Error('Website control is disabled.');await this.b.call('action',{ref:c.ref,epoch:s.epoch,kind:'click'});await Bun.sleep(180);}
 async idle(){const s=await this.snapshot();if(s.controls.some(c=>c.testId==='stop-button'||/^(Stop answering|Stop generating|Stop streaming|Stop response|Cancel loading)$/.test(c.name)))throw new Error('Stop the active response before changing model or message branches.');return s;}
 async modelControls(){const {ModelControls}=await fresh('model-controls');return new ModelControls(this);}
 async picker(){return (await this.modelControls()).picker();}
 async options(){return (await this.modelControls()).options();}
 async choose(kind:'model'|'effort',wanted:string){return (await this.modelControls()).choose(kind,wanted);}
 async mode(wanted:string){return (await this.modelControls()).mode(wanted);}
 async turn(messageId:string|undefined,role:'user'|'assistant',names:string[]){
  const s=await this.idle(),messages=s.messages.filter(m=>m.role===role),target=messageId?messages.find(m=>m.id===messageId):messages.at(-1);
  if(!target?.id)throw new Error('The requested '+role+' message is not visible in this conversation.');
  const controls=s.controls.filter(c=>names.includes(c.name?.trim())&&!c.disabled);
  let matches=controls.filter(c=>c.messageId===target.id);
  if(!matches.length&&messages.length===1&&controls.length===1&&!controls[0].messageId)matches=controls;
  if(matches.length!==1)throw new Error('Cannot uniquely associate this action with message '+target.id+'. Refresh the browser adapter or use an explicit UI reference.');
  return {s,c:matches[0],message:target};
 }
 async edit(messageId:string,text:string,emit:(e:any)=>void=()=>{}){
  if(!text.trim())throw new Error('Edited message must contain text.');
  const {s,c,message}=await this.turn(messageId,'user',['Edit message']);await this.press(s,c);
  const editor=await this.find(c=>c.tag==='textarea'&&c.name==='Edit message');
  await this.b.call('action',{ref:editor.c.ref,epoch:editor.s.epoch,kind:'fill',text});
  await this.click(c=>c.name==='Send'&&!c.disabled&&(c.messageId===message.id||!c.messageId));
  return {...await this.waitReply(s,emit),editedMessage:message.id,via:'website edit'};
 }
 async branch(messageId?:string){
  const {s,c,message}=await this.turn(messageId,'assistant',['More actions']);await this.press(s,c);
  await this.named('Open new branch','menuitem');await this.named('Branch in new Chat','menuitem');
  const end=Date.now()+20000;while(Date.now()<end){const next=await this.snapshot();if(next.url!==s.url&&/\/c\//.test(next.url))return {conversation:next.url.match(/\/c\/([^/?]+)/)?.[1],url:next.url,source:s.url,message:message.id,via:'website branch'};await Bun.sleep(200);}
  throw new Error('The website branch action did not return a new conversation URL. Inspect the browser before retrying.');
 }
 async regenerate(messageId?:string,emit:(e:any)=>void=()=>{}){
  let target;try{target=await this.turn(messageId,'assistant',['Try again','Regenerate','Regenerate response']);}catch{
   target=await this.turn(messageId,'assistant',['Switch model']);await this.press(target.s,target.c);
   const menu=await this.find(c=>['menuitem','button'].includes(c.role||c.tag)&&['Try again','Regenerate','Regenerate response'].includes(c.name?.trim()),1500);
   await this.press(menu.s,menu.c);return {...await this.waitReply(target.s,emit),regeneratedMessage:target.message.id,via:'website regenerate'};
  }
  await this.press(target.s,target.c);return {...await this.waitReply(target.s,emit),regeneratedMessage:target.message.id,via:'website regenerate'};
 }
 async composer(text:string){const {s,c}=await this.find(c=>!c.disabled&&(c.id==='prompt-textarea'||c.id==='mobile-composer-prompt'||c.role==='textbox'&&c.name==='Chat with ChatGPT'));await this.b.call('action',{ref:c.ref,epoch:s.epoch,kind:'fill',text});}
 async submit(timeout=10000){const {s,c}=await this.find(c=>!c.disabled&&(c.testId==='send-button'||/^(Send prompt|Send message)$/.test(c.name)),timeout);await this.press(s,c);}
 async stop(){const s=await this.snapshot();const c=s.controls.find(c=>c.testId==='stop-button'||/^(Stop answering|Stop generating|Stop streaming|Stop response|Cancel loading)$/.test(c.name));if(!c)return {stopped:false};await this.b.call('action',{ref:c.ref,epoch:s.epoch,kind:'click',[ALLOW_WHILE_FROZEN]:true});return {stopped:true};}
 async waitReply(before:Snapshot,emit:(e:any)=>void,timeout=600000,aborted:()=>boolean=()=>false){
  const {workUsageLimit}=await fresh('work-usage');const {ThinkingTracker}=await fresh('thinking');const previousThinking=new Map((before.thinking||[]).map(item=>[item.id,JSON.stringify(item)])),thinking=new ThinkingTracker([],false),expansionAttempts=new Map<string,number>();
  const start=Date.now(),old=new Map(before.messages.map(m=>[m.id,m.text])),oldMedia=new Set((before.media||[]).map(m=>m.src)),submittedIds=new Set<string>();let submitted=false,last='',lastChange=Date.now(),seen=false,lastMedia='',nextReceipt=Date.now()+2500,receiptDelay=2000,inactiveSince:number|undefined;
  while(Date.now()-start<timeout){
   if(aborted())throw new Error('Generation cancelled. The website conversation is preserved.');
   const s=await this.snapshot(),newMessages=s.messages.filter(m=>m.role==='assistant'&&(!old.has(m.id)||!m.id||old.get(m.id)!==m.text));
   const submittedMessages=s.messages.filter(m=>m.role==='user'&&(!old.has(m.id)||old.get(m.id)!==m.text));for(const message of submittedMessages)if(typeof message.id==='string'&&message.id)submittedIds.add(message.id);if(!submitted&&submittedMessages.length){submitted=true;emit({type:'submitted',url:s.url,messages:submittedMessages.map(m=>({id:m.id,role:m.role})),verified:true,source:'website message observed'});}
   const limit=workUsageLimit(s);if(limit)throw Object.assign(new Error('ChatGPT reports that Work usage is exhausted.'),{code:limit.code,action:'Switch to Chat and inspect the existing message before another submission.',submissionObserved:submitted});
   const text=newMessages.map(m=>m.text).join('\n\n'),media=JSON.stringify(s.media);
   const newMedia=(s.media||[]).filter(m=>m.src&&!oldMedia.has(m.src)&&m.messageRole!=='user'&&m.complete!==false&&!/^data:image\/(svg|gif)/.test(m.src));if(newMessages.length||newMedia.length)seen=true;
   if(text!==last){emit({type:text.startsWith(last)?'text':'replace',text:text.startsWith(last)?text.slice(last.length):text});last=text;lastChange=Date.now();}
   if(media!==lastMedia){emit({type:'media',items:s.media});lastMedia=media;lastChange=Date.now();}
   const active=s.controls.some(c=>c.testId==='stop-button'||/^(Stop answering|Stop generating|Stop streaming|Stop response|Cancel loading)$/.test(c.name));if(active)inactiveSince=undefined;else inactiveSince??=Date.now();
   const currentThinking=(s.thinking||[]).filter(item=>previousThinking.get(item.id)!==JSON.stringify(item));thinking.update(currentThinking,active,emit);
   for(const item of currentThinking){if(item.status!=='not-expandable'&&!item.expanded&&(expansionAttempts.get(item.id)||0)<2){expansionAttempts.set(item.id,(expansionAttempts.get(item.id)||0)+1);try{await this.b.call('thinking.expand',{id:item.id,epoch:s.epoch});}catch(error:any){emit({type:'thinking.expansion.error',id:item.id,message:error.message,retryable:expansionAttempts.get(item.id)!<2});}break;}}

   if((seen||submitted)&&!last.trim()&&!newMedia.length&&!active&&Date.now()>=nextReceipt){
    nextReceipt=Date.now()+receiptDelay;receiptDelay=Math.min(30000,receiptDelay*2);const conversation=s.url.match(/\/c\/([^/?]+)/)?.[1];
    if(conversation){try{
     const path='/backend-api/conversation/'+encodeURIComponent(conversation);
     const pending=this.readReceipt?this.readReceipt(path).then(body=>({status:200,body})):this.b.call('request',{path,workspace:this.b.account?.workspace});
     let timer:ReturnType<typeof setInterval>|undefined;
     const response:any=await Promise.race([pending,new Promise((_,reject)=>{const deadline=Math.min(start+timeout,Date.now()+2000);timer=setInterval(()=>{if(aborted()||Date.now()>=deadline)reject(new Error('Receipt observation timed out; continue observing the existing reply.'));},100);})]).finally(()=>clearInterval(timer));
     if(response.status===429){nextReceipt=Date.now()+60000;receiptDelay=30000;}const raw=response.body;if(response.status===200&&raw?.mapping){const ids=new Set(newMessages.map(m=>m.id));const branch:any[]=[],visited=new Set<string>();let node=raw.current_node;while(node&&!visited.has(node)){visited.add(node);const entry=raw.mapping[node];if(!entry)break;if(entry.message)branch.unshift(entry.message);node=entry.parent;}let candidates=branch;if(submittedIds.size){let anchor=-1;for(let i=0;i<branch.length;i++)if(branch[i]?.author?.role==='user'&&submittedIds.has(branch[i]?.id))anchor=i;if(anchor<0)candidates=[];else{const nextUser=branch.findIndex((m:any,i:number)=>i>anchor&&m?.author?.role==='user');candidates=branch.slice(anchor+1,nextUser<0?undefined:nextUser);}}const completed=candidates.filter((m:any)=>m&&m.author?.role==='assistant'&&m.status==='finished_successfully'&&(submittedIds.size||ids.has(m.id)));const receiptText=completed.map((m:any)=>(m.content?.parts||[]).filter((p:any)=>typeof p==='string').join('\n')).filter(Boolean).join('\n\n');
      if(receiptText){emit({type:'text',text:receiptText});return {text:receiptText,url:s.url,conversation,messages:completed,media:s.media,elapsedMs:Date.now()-start,source:'website conversation receipt'};}
     }
    }catch(error:any){if(/429|rate.limit/i.test(error?.message||'')){nextReceipt=Date.now()+60000;receiptDelay=30000;}/* Keep observing DOM when receipt reads are unavailable. */}}
   }
   if(seen&&(last.trim()||newMedia.length)&&!active&&inactiveSince!==undefined&&Date.now()-inactiveSince>2000&&Date.now()-lastChange>2000){return {text:last,url:s.url,conversation:s.url.match(/\/c\/([^/?]+)/)?.[1],messages:newMessages,media:s.media,elapsedMs:Date.now()-start};}
   if((s.notices||[]).some(notice=>/Something went wrong|Unusual activity|Unable to load conversation/i.test(notice.text||'')))throw new Error('ChatGPT reported a problem. Inspect the browser; no automatic resubmission was made.');
   emit({type:'progress',elapsedMs:Date.now()-start,responding:active});await Bun.sleep(250);
  }
  throw new Error('Timed out waiting for the reply. Inspect/resume the existing chat; do not blindly resubmit.');
 }
 async originalExport(confirm=false){
  await this.settings('Data controls');await this.click(c=>['Export Export data',...adapter().labels.export].includes(c.name.trim()));
  const confirmation=await this.find(c=>['Confirm export',...adapter().labels.exportConfirm].includes(c.name.trim()));
  const before=confirmation.s;
  if(!confirm)return {stage:'confirmation',requested:false,launcher:'Export Export data',confirmation:confirmation.c.name,controls:before.controls,dialog:before.text,executionEvidence:'not-confirmed'};
  await this.press(before,confirmation.c);
  for(let i=0;i<80;i++){const s=await this.snapshot();if(exportAcknowledged(before,s,confirmation.c.name))return {requested:true,via:'ChatGPT official export',delivery:'Registered email',preparation:'asynchronous'};await Bun.sleep(250);}
  throw new Error('Export confirmation outcome unknown. Inspect the website and email before another request; this write was not replayed.');
 }
 async settingsMap(emit:(e:any)=>void){return (await fresh('settings-map')).mapSettings(this,emit);}
}
