import type {QueueContext} from './tui-shared-queue.ts';
export type QueuedDraft={id:string;text:string;files?:string[];context?:QueueContext;awaitingConversation?:boolean;parentRequestId?:string};
/** Local drafts only: dequeueing does not constitute website submission. */
export class LocalQueue {
 items:QueuedDraft[]=[];paused=false;
 add(text:string,files:string[]=[],context?:QueueContext){if(!text.trim()&&!files.length)throw new Error('Queued message is empty.');if(this.items.length>=50)throw new Error('Local queue is full (50 messages).');const item={id:crypto.randomUUID(),text,files:[...files],...(context?{context:{...context}}:{})};this.items.push(item);return item;}
 edit(id:string,text:string){const item=this.items.find(value=>value.id===id);if(!item)throw new Error('Queued message no longer exists.');if(!text.trim()&&!item.files?.length)throw new Error('Queued message is empty.');item.text=text;}
 remove(id:string){this.items=this.items.filter(item=>item.id!==id);}
 move(id:string,direction:-1|1){const at=this.items.findIndex(item=>item.id===id),target=at+direction;if(at<0||target<0||target>=this.items.length)return;[this.items[at],this.items[target]]=[this.items[target],this.items[at]];}
 next(){return this.paused?undefined:this.items.shift();}
 snapshot(){return {items:this.items.map(item=>({...item,files:[...(item.files||[])]})),paused:this.paused};}
 restore(state?:{items:QueuedDraft[];paused:boolean}){this.items=(state?.items||[]).map(item=>({...item,files:[...(item.files||[])]}));this.paused=state?.paused??false;}
}

/** Bind only never-published follow-ups to a positively observed creation receipt. */
export function bindQueuedConversation(items:QueuedDraft[],conversation:string){
 if(!/^[A-Za-z0-9_-]+$/.test(conversation))throw new Error('A valid observed conversation ID is required.');
 for(const item of items)if(item.awaitingConversation){item.context={conversation,...(item.context?.model?{model:item.context.model}:{}),...(item.context?.effort?{effort:item.context.effort}:{})};delete item.awaitingConversation;}
}

export function completedParentConversation(evidence:any,account:{id:string;userId?:string;workspace?:string},parentRequestId:string){
 const receipt=evidence?.receipt;
 if(receipt?.id!==parentRequestId||!['chat.send','chat.new'].includes(receipt.operation)||receipt.account?.id!==account.id||receipt.account?.userId!==account.userId||receipt.account?.workspace!==account.workspace)throw new Error('Parent send receipt does not match this account and request. Follow-ups remain paused.');
 if(receipt.status!=='complete')return;
 const conversation=evidence.result?.conversation;return typeof conversation==='string'&&/^[A-Za-z0-9_-]+$/.test(conversation)?conversation:undefined;
}
