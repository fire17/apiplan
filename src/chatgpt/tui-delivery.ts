import {messageTime} from './message-time.ts';
export type DeliveryMessage={role:string;text:string;id?:string;files?:string[];delivery?:string;requestId?:string;[key:string]:any};
const identity=(text:string,files:string[]=[])=>JSON.stringify([text.trim(),files]);
export function uncertainDuplicate(messages:DeliveryMessage[],text:string,files:string[]=[]){return messages.find(message=>['unconfirmed','submitting','submitted'].includes(message.delivery||'')&&identity(message.text,message.files)===identity(text,files));}
/** Positive website message identities reconcile attempts; absence never proves non-submission. */
export function reconcileMessages(previous:DeliveryMessage[],observed:any[]):DeliveryMessage[]{
 const byId=new Map(previous.filter(message=>message.id).map(message=>[message.id,message])),byTurn=new Map(previous.filter(message=>message.domTurnId).map(message=>[message.domTurnId,message]));
 const confirmed=observed.map(message=>{const id=message.id||message.message_id,prior=byId.get(id)||(message.domTurnId?byTurn.get(message.domTurnId):undefined);return {id,role:message.role||message.author?.role||'assistant',text:typeof message.text==='string'?message.text:typeof message.content==='string'?message.content:(message.content?.parts||[]).map((part:any)=>typeof part==='string'?part:JSON.stringify(part)).join('\n'),...(message.media?{media:message.media}:{}),...(message.files||prior?.files?{files:[...(message.files||prior!.files)]}:{}),...(message.domTurnId?{domTurnId:message.domTurnId}:{}),...(message.identitySource?{identitySource:message.identitySource}:{}),...messageTime(message,prior)};});
 const turns=new Set(confirmed.map(message=>message.domTurnId).filter(Boolean));
 const ids=new Set(confirmed.map(message=>message.id).filter(Boolean)),drafts=new Map<string,DeliveryMessage>();
 for(const message of previous)if(['user','draft'].includes(message.role)&&(['unconfirmed','submitting','submitted'].includes(message.delivery||'')&&(!message.id||!ids.has(message.id))))drafts.set(identity(message.text,message.files),{...message,role:'draft',delivery:'unconfirmed'});
 const anchor=previous.findIndex(message=>!!message.id&&ids.has(message.id));
 const prefix=previous.slice(0,anchor<0?previous.length:anchor).filter(message=>message.id&&!ids.has(message.id)&&!(message.domTurnId&&turns.has(message.domTurnId))&&['user','assistant','tool'].includes(message.role)&&!['unconfirmed','submitting','submitted'].includes(message.delivery||''));
 return [...prefix,...confirmed,...drafts.values()];
}

/** Recovery is read-only; uncertainty remains until a positive message identity is observed. */
export function needsReconciliation(messages:DeliveryMessage[]){return messages.some(message=>['unconfirmed','submitting','submitted'].includes(message.delivery||'')||message.role==='system'&&/session.*timed out|connection|daemon|OUTCOME_UNKNOWN|NOT_SUBMITTED/i.test(message.text));}
export function recoverableConnectionError(error:any){return /session.*timed out|timed out|timeout|connection|socket|daemon|fetch failed|ECONN|network/i.test(String(error?.message||error));}
