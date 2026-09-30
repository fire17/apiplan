import type {Snapshot} from './actions.ts';
export function workUsageLimit(snapshot:Snapshot){
 const selectedWork=snapshot.controls.some(c=>c.name==='Work'&&['radio','menuitemradio'].includes(c.role)&&(c.checked===true||c.checked==='true'));
 const notices=((snapshot as any).notices||[]).map((n:any)=>typeof n==='string'?n:n.text||'');
 const warning=notices.find((text:string)=>/you[’']re out of Work usage for now/i.test(text));
 const meter=snapshot.controls.find(c=>/Work usage|usage settings/i.test(c.name||'')&&/\b0% remaining\b/.test(c.name||''));
 if(!warning&&!(selectedWork&&meter))return null;
 return {code:'WORK_USAGE_EXHAUSTED',reason:warning||meter.name,source:warning?'website usage notice':'website Work usage meter'};
}
