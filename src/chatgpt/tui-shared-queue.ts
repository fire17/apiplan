import {mergeThinking} from './tui-thinking.ts';
export type QueueContext={conversation?:string;new?:boolean;project?:string;gpt?:string;mode?:string;model?:string;effort?:string};
export type QueueOutboxItem={id:string;text:string;files?:string[];context?:QueueContext};
export function queueContextLabel(draft:QueueContext){return draft.conversation?'conversation '+draft.conversation:draft.project?'new · project '+draft.project:draft.gpt?'new · GPT '+draft.gpt:'new conversation';}
export function queuePermissions(phase:string){return {edit:['queued','not-submitted'].includes(phase),remove:['queued','not-submitted','complete'].includes(phase),reorder:['queued','not-submitted'].includes(phase),retry:phase==='not-submitted',reconcile:['unknown','not-submitted'].includes(phase)};}
/** Thin client of the CLI's durable account queue. Outbox IDs must be checkpointed before migrate. */
export class SharedQueue {
 state:any={items:[],paused:true,running:false};pending=false;loaded=false;details:Record<string,any>={};private stateEpoch=0;
 constructor(private rpc:(op:string,args?:any,event?:(value:any)=>void)=>Promise<any>,private account:{id:string;userId?:string;workspace?:string}){}
 private accept(result:any,apply=true){if(!Array.isArray(result?.items)||result.account?.id!==this.account.id||this.account.userId&&result.account.userId!==this.account.userId||result.account?.workspace!==this.account.workspace)throw new Error('Shared queue account identity did not match this TUI. Local drafts were retained.');if(!result.account.userId)throw new Error('Shared queue receipt has no bound website user.');this.account.userId??=result.account.userId;if(apply){this.state=result;this.loaded=true;this.stateEpoch++;}return result;}
 private async exclusive<T>(fn:()=>Promise<T>){if(this.pending)throw new Error('A shared queue operation is active. Wait for it to finish.');this.pending=true;try{return await fn();}finally{this.pending=false;}}
 async refresh(){const epoch=this.stateEpoch;const result=await this.rpc('queue.list');return this.accept(result,epoch===this.stateEpoch);}
 mutate(operation:string,args:any={}){if(operation==='pause')return (async()=>{const epoch=this.stateEpoch,result=await this.rpc('queue.pause');this.accept(result,epoch===this.stateEpoch);this.state.paused=true;this.stateEpoch++;return this.state;})();return this.exclusive(async()=>this.accept(await this.rpc('queue.'+operation,args)));}
 async migrate(items:QueueOutboxItem[],ack:(id:string)=>void){return this.exclusive(async()=>{
  this.accept(await this.rpc('queue.pause'));
  for(const item of items){if(!item.context?.conversation&&item.context?.new!==true)throw new Error('Queued draft has no explicit destination. Preserve it and choose a conversation.');
   const result=this.accept(await this.rpc('queue.add',{...item.context,text:item.text,files:item.files||[],clientId:item.id}));
   if(!result.item?.id||result.item.clientId!==item.id)throw new Error('Shared queue did not acknowledge this outbox ID. Local draft retained; no send was attempted.');ack(item.id);
  }
  return this.state;
 });}
 run(event:(value:any)=>void,guard?:(state:any)=>void){return this.exclusive(async()=>{
  const state=this.accept(await this.rpc('queue.list'));guard?.(state);if(state.items.some((item:any)=>['unknown','not-submitted','submitting','submitted','responding'].includes(item.phase))||state.running)throw new Error('Resolve the active, uncertain or not-submitted queue item before running. No replay was attempted.');
  this.accept(await this.rpc('queue.resume'));this.state.running=true;return this.accept(await this.rpc('queue.run',{},value=>{this.stateEpoch++;const item=this.state.items.find((item:any)=>item.id===value.id);if(item){if(value.type==='queue.submitting')item.phase='submitting';if(value.type==='queue.complete')item.phase='complete';if(value.type==='queue.paused'){item.phase=value.reason;this.state.paused=true;}if(value.type==='queue.event'){const detail=this.details[item.id]??={text:'',thinking:[],media:[],timestamp:new Date().toISOString()},nested=value.event;detail.updated=new Date().toISOString();if(nested?.type==='text')detail.text+=String(nested.text||'');if(nested?.type==='replace')detail.text=String(nested.text||'');if(nested?.type==='thinking')detail.thinking=mergeThinking(detail.thinking,nested);if(nested?.type==='media')detail.media=nested.items||[];if(value.event?.type==='submitted')item.phase='submitted';if(['text','replace','thinking'].includes(value.event?.type))item.phase='responding';}}event(value);}));
 });}
}

export function sharedQueueSummary(state:any){const items=state.items||[];return items.filter((item:any)=>item.phase==='queued').length+' shared queued'+(state.paused?' (paused)':'')+(['submitting','submitted','responding','unknown','not-submitted'].map(phase=>{const count=items.filter((item:any)=>item.phase===phase).length;return count?' · '+count+' '+phase:'';}).join(''));}

/** Separate target-labeled projection; never appended to the currently opened conversation. */
export function sharedQueueTranscript(state:any,details:Record<string,any>={}){return (state.items||[]).flatMap((item:any)=>{
 const detail=details[item.id]||{},time={timestamp:item.created||detail.timestamp||new Date().toISOString(),timestampSource:'local'},messages:any[]=[{id:item.id+'-target',role:'system',text:'SHARED QUEUE · '+queueContextLabel(item.draft)+' · '+item.phase.toUpperCase(),...time},{id:item.id+'-prompt',role:'user',text:item.draft.text||'',files:item.draft.files||[],delivery:item.phase==='queued'?'queued · not submitted':item.phase,...time}];
 const complete=item.phase==='complete',liveIsNewer=Date.parse(detail.updated||detail.timestamp||'')>Date.parse(item.updated||'');
 const text=(complete&&item.result?.text)||(liveIsNewer?detail.text||item.response:item.response||detail.text)||item.result?.text||'';
 const combine=(...groups:any[])=>[...new Map(groups.flatMap(group=>Array.isArray(group)?group:[]).map((entry:any)=>[entry.id||entry.reference||entry.url||entry.src||JSON.stringify(entry),entry])).values()];
 const thinking=complete?combine(detail.thinking,item.thinking,item.result?.thinking):liveIsNewer?combine(item.thinking,detail.thinking):combine(detail.thinking,item.thinking);
 const media=complete?combine(detail.media,item.media,item.result?.media):liveIsNewer?combine(item.media,detail.media):combine(detail.media,item.media);

 if(text||thinking.length||media.length||['submitting','submitted','responding'].includes(item.phase))messages.push({id:item.id+'-response',role:'assistant',text,thinking,media,timestamp:detail.timestamp||item.updated||time.timestamp,timestampSource:'observed'});
 return messages;
});}
