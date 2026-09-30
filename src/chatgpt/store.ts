import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {chmodSync} from 'node:fs';
import {accountDir,type Account} from './accounts.ts';

export type Coverage={scope:string;complete:boolean;pages:number;count:number;total?:number;reason?:string;at:string};
export function recordId(raw:any):string {return raw.id||raw.conversation_id||raw.gizmo?.id||raw.gizmo?.gizmo?.id||raw.project?.id||raw.gizmo_id||raw.slug||'';}
export function recordTitle(raw:any):string {return raw.title||raw.name||raw.display?.name||raw.gizmo?.display?.name||raw.gizmo?.gizmo?.display?.name||raw.project?.title||raw.slug||recordId(raw);}
export function messageText(message:any):string {const c=message?.content;if(!c)return '';if(typeof c==='string')return c;return (c.parts||[c.text||'']).map((p:any)=>typeof p==='string'?p:JSON.stringify(p)).join('\n');}
/** Every branch remains in raw.mapping; this returns just an explicitly chosen path. */
export function messagePath(raw:any,nodeId?:string):any[] {
 const map=raw.mapping||{}, seen=new Set<string>(),path:any[]=[];
 let id=nodeId||raw.current_node;
 if(!id)return [];
 while(id){if(seen.has(id))throw new Error('Conversation tree contains a cycle.');seen.add(id);const n=map[id];if(!n)throw new Error('Conversation tree references a missing node: '+id);if(n.message)path.push({...n.message,node_id:id,parent:n.parent,children:n.children});id=n.parent;}
 return path.reverse();
}

export async function paginateCursor(fetchPage:(cursor:string|undefined)=>Promise<any>,scope:string,opts:{field?:string;maxPages?:number;onPage?:(rows:any[],page:any)=>void}={}) {
 const items:any[]=[],seen=new Set<string>(),cursors=new Set<string>();let cursor:string|undefined,pages=0;
 const done=(complete:boolean,reason?:string)=>({items,coverage:{scope,complete,pages,count:items.length,reason,at:new Date().toISOString()} as Coverage});
 while(pages<(opts.maxPages||10000)){
  const page=await fetchPage(cursor);pages++;
  const rows=page[opts.field||'items'];if(!Array.isArray(rows))throw new Error('Unrecognized cursor page for '+scope);
  let added=0;for(const row of rows){const id=recordId(row);if(!id)throw new Error('Record identity missing in '+scope);if(!seen.has(id)){seen.add(id);items.push(row);added++;}}
  opts.onPage?.(rows,page);
  const next=page.next_cursor??page.cursor??page.nextCursor;
  if(next===null||next===undefined||next===''){if(page.has_more===true)return done(false,'Server says more data exists without a cursor.');return done(true);}
  if(cursors.has(String(next))||(!added&&rows.length))return done(false,'Cursor pagination stopped making progress.');
  cursors.add(String(next));cursor=String(next);
 }
 return done(false,'Page budget reached.');
}
export class Store {
 db:Database;
 constructor(a:Account){const path=join(accountDir(a),'index.sqlite');this.db=new Database(path);chmodSync(path,0o600);this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,raw TEXT NOT NULL,search_text TEXT NOT NULL,seen TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS coverage(scope TEXT PRIMARY KEY,raw TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);}
 bindIdentity(id:string){const old=this.db.query('SELECT value FROM meta WHERE key=?').get('userId') as any;if(old&&old.value!==id)throw new Error('This browser signed in to a different user. Create a separate account profile before indexing.');this.db.query('INSERT OR REPLACE INTO meta VALUES (?,?)').run('userId',id);}
 put(kind:string,raw:any){const id=recordId(raw);if(!id)throw new Error('Record has no identity; raw data was not silently discarded.');const text=kind==='conversation'?Object.values(raw.mapping||{}).map((n:any)=>messageText(n.message)).join('\n'):JSON.stringify(raw);this.db.query('INSERT OR REPLACE INTO records VALUES (?,?,?,?,?,?)').run(kind,id,recordTitle(raw),JSON.stringify(raw),text,new Date().toISOString());return raw;}
 get(kind:string,id:string){const r=this.db.query('SELECT raw FROM records WHERE kind=? AND id=?').get(kind,id) as any;return r?JSON.parse(r.raw):null;}
 list(kind:string,q=''){return (this.db.query('SELECT raw FROM records WHERE kind=? AND (title LIKE ? ESCAPE \'\\\' OR search_text LIKE ? ESCAPE \'\\\') ORDER BY seen DESC').all(kind,'%'+q.replace(/[\\%_]/g,'\\$&')+'%','%'+q.replace(/[\\%_]/g,'\\$&')+'%') as any[]).map(r=>JSON.parse(r.raw));}
 receipt(r:Coverage){this.db.query('INSERT OR REPLACE INTO coverage VALUES (?,?)').run(r.scope,JSON.stringify(r));return r;}
 receipts(){return (this.db.query('SELECT raw FROM coverage').all() as any[]).map(r=>JSON.parse(r.raw));}
 close(){this.db.close();}
}

/** A full walker must prove termination, including when a server ignores offset. */
export async function paginate(fetchPage:(offset:number,limit:number)=>Promise<any>,scope:string,opts:{limit?:number;maxPages?:number;onPage?:(items:any[],page:any)=>void}={}) {
 const limit=opts.limit||100,maxPages=opts.maxPages||10000,items:any[]=[],seen=new Set<string>();let offset=0,total:number|undefined,pages=0;
 const done=(complete:boolean,reason?:string)=>({items,coverage:{scope,complete,pages,count:items.length,total,reason,at:new Date().toISOString()} as Coverage});
 while(pages<maxPages){
  const page=await fetchPage(offset,limit);pages++;
  const rows=Array.isArray(page)?page:page.items??page.conversations??page.results??page.data;
  if(!Array.isArray(rows))throw new Error(`Unrecognized pagination response for ${scope}; refusing to claim completeness.`);
  if(typeof page.total==='number')total=page.total;
  let added=0;for(const row of rows){const id=recordId(row);if(!id)throw new Error('Page record missing id.');if(!seen.has(id)){seen.add(id);items.push(row);added++;}}
  opts.onPage?.(rows,page);
  if(rows.length&&!added)return done(false,'Server repeated a page without progress.');
  offset+=rows.length;
  if(page.has_more===false||page.hasMore===false)return done(total===undefined||items.length>=total,items.length<(total??0)?'Server ended before advertised total.':undefined);
  if(total!==undefined&&items.length>=total)return done(true);
  if(!rows.length)return done(total===undefined||items.length>=total,total&&items.length<total?'Empty page before advertised total.':undefined);
  if(rows.length<limit&&total===undefined&&page.has_more!==true&&page.hasMore!==true)return done(true);
 }
 return done(false,'Page budget reached.');
}

/** Raw website fields remain intact; local observation time is labeled separately. */
export function observedRecords(store:Store,kind:string){return (store.db.query('SELECT raw,seen FROM records WHERE kind=? ORDER BY seen DESC').all(kind) as any[]).map(row=>({...JSON.parse(row.raw),localObservation:{seenAt:row.seen}}));}
