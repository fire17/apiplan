import {graphemes,width,wrap} from './tui-terminal.ts';
export type ComposerDraft={text:string;files:string[];cursor:number};
type Point={row:number;column:number};
/** Cursor positions use grapheme indices and terminal cells, including soft wraps. */
export function composerPositions(text:string,columns:number):Point[]{
 const chars=graphemes(text),points:Point[]=[];columns=Math.max(1,columns);let row=0,column=0;
 for(let index=0;index<chars.length;index++){
  const char=chars[index],cells=char==='\t'?4:width(char);
  if(char!=='\n'&&column>0&&column+cells>columns){row++;column=0;}
  points[index]={row,column};
  if(char==='\n'){row++;column=0;}else column+=cells;
 }
 if(column>=columns){row++;column=0;}points[chars.length]={row,column};return points;
}
const copy=(draft:ComposerDraft):ComposerDraft=>({...draft,files:[...draft.files]});
export function sentPrompts(messages:any[]):ComposerDraft[]{return messages.filter(message=>message.role==='user'&&(['submitted','answered'].includes(message.delivery)||!message.delivery&&message.id)).map(message=>({text:message.text||'',files:[...(message.files||[])],cursor:graphemes(message.text||'').length}));}
export class ComposerNavigation {
 preferred:number|null=null;index:number|null=null;saved?:ComposerDraft;history:ComposerDraft[]=[];
 reset(){this.preferred=null;this.index=null;this.saved=undefined;this.history=[];}
 edited(){this.preferred=null;}
 snapshot(){return {preferred:this.preferred,index:this.index,saved:this.saved&&copy(this.saved),history:this.history.map(copy)};}
 restore(state:any){this.reset();if(!state||!Array.isArray(state.history))return;this.history=state.history.filter((item:any)=>typeof item?.text==='string'&&Array.isArray(item.files)&&Number.isInteger(item.cursor)).map(copy);if(Number.isInteger(state.index)&&state.index>=0&&state.index<this.history.length&&typeof state.saved?.text==='string'&&Array.isArray(state.saved.files)){this.index=state.index;this.saved=copy(state.saved);}this.preferred=typeof state.preferred==='number'?state.preferred:null;}
 move(draft:ComposerDraft,direction:-1|1,columns:number,messages:any[]):ComposerDraft{
  const points=composerPositions(draft.text,columns),cursor=Math.max(0,Math.min(points.length-1,draft.cursor)),current=points[cursor],target=current.row+direction;
  if(target>=0&&target<=points.at(-1)!.row){
   this.preferred??=current.column;let selected=-1,best=Infinity;
   points.forEach((point,index)=>{if(point.row!==target)return;const distance=Math.abs(point.column-this.preferred!);if(distance<best){best=distance;selected=index;}});
   if(selected>=0)return {...copy(draft),cursor:selected};return copy(draft);
  }
  this.preferred=null;
  if(direction<0){
   if(this.index===null){this.history=sentPrompts(messages);if(!this.history.length)return copy(draft);this.saved=copy(draft);this.index=this.history.length;}
   if(this.index>0)this.index--;return copy(this.history[this.index]);
  }
  if(this.index===null)return copy(draft);
  if(this.index<this.history.length-1)return copy(this.history[++this.index]);
  const restored=copy(this.saved!);this.reset();return restored;
 }
}

/** Render plain text unchanged; the native terminal caret occupies its measured cell separately. */
export function composerViewport(text:string,cursor:number,columns:number,height:number){
 const positions=composerPositions(text,columns),point=positions[Math.max(0,Math.min(positions.length-1,cursor))],rows=wrap(text,columns);
 while(rows.length<=positions.at(-1)!.row)rows.push('');
 const start=Math.max(0,point.row-Math.max(1,height)+1);
 return {rows:rows.slice(start,start+height),start,cursor:{row:point.row-start,column:point.column}};
}
