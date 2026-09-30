export type MessageTime={timestamp:string;timestampSource:'website'|'local'|'observed'};
/** Normalize actual epoch seconds/milliseconds or timezone-qualified ISO values. */
export function timestampISO(value:unknown):string|undefined{
 if(value===null||value===undefined||value==='')return;
 let milliseconds:number;
 if(typeof value==='number'||typeof value==='string'&&/^-?\d+(?:\.\d+)?$/.test(value)){
  const number=Number(value);milliseconds=Math.abs(number)<1e11?number*1000:number;
 }else if(typeof value==='string'&&/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(value)&&/(?:Z|[+-]\d\d:\d\d)$/i.test(value))milliseconds=Date.parse(value);
 else return;
 if(!Number.isFinite(milliseconds))return;
 try{return new Date(milliseconds).toISOString();}catch{return;}
}
function websiteTime(message:any){
 for(const candidate of [message?.create_time,message?.created_at,message?.createTime,message?.createdAt,message?.timestampSource==='website'?message?.timestamp:undefined]){const value=timestampISO(candidate);if(value)return value;}
}
function savedTime(message:any):MessageTime|undefined{
 const timestamp=timestampISO(message?.timestamp);if(!timestamp)return;
 const source=message.timestampSource;
 return {timestamp,timestampSource:['website','local','observed'].includes(source)?source:'observed'};
}
/** Prefer server creation time; a later DOM observation must never move an existing timestamp. */
export function messageTime(message:any,previous?:any,now=new Date().toISOString()):MessageTime{
 const website=websiteTime(message)||websiteTime(previous);if(website)return {timestamp:website,timestampSource:'website'};
 const saved=savedTime(previous)||savedTime(message);if(saved)return saved;
 return {timestamp:timestampISO(message?.firstObservedAt)||timestampISO(message?.observedAt)||timestampISO(now)!,timestampSource:'observed'};
}
export function localMessageTime(now=new Date().toISOString()):MessageTime{return {timestamp:timestampISO(now)!,timestampSource:'local'};}
const formatters=new Map<string,Intl.DateTimeFormat>();
/** Local calendar date, seconds and UTC offset keep old chats and DST changes unambiguous. */
export function messageTimeLabel(message:any,timeZone?:string):string{
 const stamp=messageTime(message),key=timeZone||'local';let format=formatters.get(key);if(!format){format=new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset',...(timeZone?{timeZone}:{})});formatters.set(key,format);}
 const parts=Object.fromEntries(format.formatToParts(new Date(stamp.timestamp)).map(part=>[part.type,part.value]));
 return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`+(stamp.timestampSource==='website'?'':stamp.timestampSource==='local'?' · local':' · seen');
}
