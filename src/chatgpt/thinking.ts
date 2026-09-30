export type ThinkingItem={id:string;title:string;text:string;expanded:boolean;status?:string};
export type ThinkingEvent={type:'thinking';items:ThinkingItem[];active:boolean}|{type:'thinking.delta';id:string;title:string;text:string;replace:boolean;expanded:boolean};

function checked(items:ThinkingItem[]){
 const ids=new Set<string>();
 return items.map(item=>{
  if(!item||typeof item.id!=='string'||!item.id||typeof item.title!=='string'||typeof item.text!=='string'||typeof item.expanded!=='boolean')throw new Error('Thinking snapshots require observed id, title, text and expanded fields.');
  if(ids.has(item.id))throw new Error('Thinking snapshot contains a duplicate id: '+item.id);ids.add(item.id);
  return {...item};
 });
}

/** Diffs site-visible thinking regions. IDs and text always come from the browser snapshot. */
export class ThinkingTracker {
 private previous:ThinkingItem[];
 private active:boolean;
 constructor(initial:ThinkingItem[]=[],active=false){this.previous=checked(initial);this.active=active;}
 update(next:ThinkingItem[],active:boolean,emit:(event:ThinkingEvent)=>void){
  const items=checked(next),before=new Map(this.previous.map(item=>[item.id,item]));
  const changed=active!==this.active||JSON.stringify(items)!==JSON.stringify(this.previous);
  if(!changed)return false;
  emit({type:'thinking',items,active});
  for(const item of items){const old=before.get(item.id);if(old&&old.title===item.title&&old.text===item.text&&old.expanded===item.expanded)continue;const append=!!old&&item.text.startsWith(old.text);emit({type:'thinking.delta',id:item.id,title:item.title,text:append?item.text.slice(old!.text.length):item.text,replace:!!old&&!append,expanded:item.expanded});}
  this.previous=items;this.active=active;return true;
 }
}
