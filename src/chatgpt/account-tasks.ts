/** Website task records use task_id. Retain every page and field, including interrupted work. */
export async function listTasks(request:(path:string)=>Promise<any>,path:string,args:{maxPages?:number}={}) {
 const max=args.maxPages??10000;
 if(!Number.isSafeInteger(max)||max<1||max>10000)throw new Error('Task page budget must be 1–10000.');
 const items:any[]=[],rawPages:any[]=[],ids=new Set<string>(),cursors=new Set<string>();let cursor:string|undefined;
 const finish=(complete:boolean,reason?:string)=>({items,tasks:items,rawPages,complete,coverage:{scope:'tasks',complete,count:items.length,pages:rawPages.length,at:new Date().toISOString(),...(reason?{reason}:{})}});
 for(let page=0;page<max;page++){
  const raw=await request(path+(cursor!==undefined?(path.includes('?')?'&':'?')+'cursor='+encodeURIComponent(cursor):''));rawPages.push(raw);
  if(!raw||!Array.isArray(raw.tasks))return finish(false,'Task response no longer contains a tasks array; raw page retained.');
  let added=0;
  for(const task of raw.tasks){const id=task?.task_id??task?.id;if(typeof id!=='string'||!id)return finish(false,'Task identity missing; raw page retained.');if(!ids.has(id)){ids.add(id);items.push(task);added++;}}
  const keys=['next_cursor','cursor','nextCursor'].filter(k=>Object.hasOwn(raw,k)),values=keys.map(k=>raw[k]),next=values.find(v=>v!==null&&v!==undefined&&v!=='');
  if(values.some(v=>v!==null&&v!==undefined&&typeof v!=='string'))return finish(false,'Task cursor has an unrecognized type.');
  if(new Set(values.filter(v=>v!==null&&v!==undefined&&v!=='')).size>1)return finish(false,'Task response contains conflicting cursors.');
  const total=raw.total??raw.total_count;
  if(total!==undefined&&(!Number.isSafeInteger(total)||total<items.length))return finish(false,'Task count disagrees with the advertised total.');
  if(next===undefined){
   if(raw.has_more===true||raw.hasMore===true)return finish(false,'Server reports more tasks without a continuation cursor.');
   if(total!==undefined&&items.length!==total)return finish(false,'Task list ended before its advertised total.');
   if(!keys.length&&raw.has_more!==false&&raw.hasMore!==false)return finish(false,'Task pagination has no explicit termination signal.');
   return finish(true);
  }
  if(raw.has_more===false||raw.hasMore===false)return finish(false,'Server termination flag conflicts with its task cursor.');
  if(cursors.has(next)||(!added&&raw.tasks.length))return finish(false,'Task pagination stopped making progress.');
  cursors.add(next);cursor=next;
 }
 return finish(false,'Task page budget reached.');
}
