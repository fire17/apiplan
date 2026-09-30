import {shortcutModifier} from './tui-terminal.ts';
/** Observed website thinking summaries remain separate from the answer text. */
export type ThinkingItem={id:string;title:string;text:string;expanded?:boolean;status?:string};
export function mergeThinking(previous:ThinkingItem[],event:any):ThinkingItem[]{
 const next=previous.map(item=>({...item}));
 const incoming=Array.isArray(event.items)?event.items:event.type==='thinking.delta'?[{id:event.id||'thinking',title:event.title||'',text:event.text||'',expanded:event.expanded}]:[];
 for(const [index,item] of incoming.entries()){
  const id=String(item.id||'thinking-'+index),at=next.findIndex(value=>value.id===id),old=at>=0?next[at]:undefined;
  const text=typeof item.text==='string'?item.text:'';
  const updated:ThinkingItem={id,title:String(item.title||old?.title||'Thinking'),text:event.type==='thinking.delta'?(event.replace?text:(old?.text||'')+text):text||old?.text||'',expanded:item.expanded??old?.expanded,status:item.status??old?.status};
  if(at>=0)next[at]=updated;else next.push(updated);
 }
 return next;
}
export function thinkingLines(items:ThinkingItem[],expanded:boolean):string[]{
 if(!items.length)return [];
 const lines=['THINKING · website activity'+(expanded?` · ${shortcutModifier}+T collapse`:` · ${shortcutModifier}+T expand`)];
 for(const item of items){lines.push('  '+item.title+(item.status?' · '+item.status:''));if(expanded&&item.text)lines.push(...item.text.split('\n').map(line=>'  '+line));}
 return lines;
}
export function generationIndicator(started:number,now:number,thinking=false,phase='responding',observedLabel=''){
 const frames=['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
 const elapsed=Math.max(0,now-started);
 return frames[Math.floor(elapsed/100)%frames.length]+' '+(observedLabel|| (thinking?'Thinking':phase==='submitting'?'Submitting':phase==='submitted'?'Submitted · waiting':'Responding'))+' · '+Math.floor(elapsed/1000)+'s · Ctrl+C stops';
}

export function currentThinkingLabel(items:ThinkingItem[]=[]){return items.findLast(item=>/^(?:Pro thinking\b|Thinking(?:\.{0,3}|…)$)/i.test(item.title||''))?.title||'';}
