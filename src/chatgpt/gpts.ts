/** Only routes observed through the ChatGPT UI are executable here. */
export const GPT_ROUTES = ['discovery','discovery_anon','discovery/recent','discovery/mine','discovery/trending'] as const;
export type GPTCatalogArgs = {scope?:'explore'|'anonymous'|'recent'|'owned'|'trending';cursor?:string;limit?:number;locale?:string;maxPages?:number;includeRaw?:boolean};
const routes = {explore:'discovery',anonymous:'discovery_anon',recent:'discovery/recent',owned:'discovery/mine',trending:'discovery/trending'} as const;
export function gptCatalogPath(args:GPTCatalogArgs={}) {
 const scope=args.scope??'explore',route=routes[scope];if(!route)throw new Error('Unknown GPT catalog scope.');
 if(['explore','anonymous'].includes(scope)&&(args.cursor!==undefined||args.limit!==undefined||args.locale!==undefined))throw new Error('Discovery landing pages do not have an observed pagination contract.');
 const q=new URLSearchParams();
 if(args.limit!==undefined){if(!Number.isInteger(args.limit)||args.limit<1||args.limit>20)throw new Error('GPT page limit must be 1–20.');q.set('limit',String(args.limit));}
 else if(scope==='owned')q.set('limit','20');else if(scope==='recent')q.set('limit','3');else if(scope==='trending')q.set('limit','6');
 if(args.cursor!==undefined){if(!/^\d{1,10}$/.test(args.cursor))throw new Error('Unsupported GPT cursor.');q.set('cursor',args.cursor);}
 if(args.locale!==undefined){if(!/^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(args.locale))throw new Error('Invalid GPT locale.');q.set('locale',args.locale);}
 return '/public-api/gizmos/'+route+(q.size?'?'+q:'');
}
export function normalizeGPTCatalog(raw:any,scope:GPTCatalogArgs['scope']='explore') {
 const sourceCuts=Array.isArray(raw?.cuts)?raw.cuts:raw?.info&&raw?.list?[raw]:null;
 if(!sourceCuts)throw new Error('Unexpected GPT catalog response shape.');
 const cuts=sourceCuts.map((cut:any)=>{
  if(!cut.info?.id||!Array.isArray(cut.list?.items))throw new Error('Unexpected GPT catalog cut.');
  const items=cut.list.items.map((item:any)=>{const g=item?.resource?.gizmo;if(!g?.id||!g.display?.name)throw new Error('Unexpected GPT catalog item.');return {id:g.id,title:g.display.name,description:g.display.description??'',slug:g.short_url??null,author:g.author?.display_name??null,categories:g.display.categories??[],scope};});
  const cursor=cut.list.cursor??null;
  return {id:cut.info.id,title:cut.info.title,description:cut.info.description??null,locale:cut.info.locale??null,items,nextCursor:cursor,pageComplete:cursor===null,paginationSupported:['mine','recent','trending'].includes(cut.info.id)};
 });
 return {scope,cuts,items:[...new Map(cuts.flatMap((c:any)=>c.items).map((x:any)=>[x.id,x])).values()],complete:false,coverage:{reason:'Observed catalog pages only; unobserved categories, hidden GPTs and workspace-conditional features are not asserted complete.',ownedPageComplete:scope==='owned'?cuts.every((c:any)=>c.pageComplete):undefined}};
}
export async function fetchGPTCatalog(request:(path:string)=>Promise<any>,args:GPTCatalogArgs={}) {
 const scope=args.scope??'explore',paginated=['owned','recent','trending'].includes(scope),maxPages=args.maxPages??100;
 if(!Number.isInteger(maxPages)||maxPages<1||maxPages>1000)throw new Error('GPT maxPages must be 1–1000.');
 const rawPages:any[]=[],pages:any[]=[],seen=new Set<string>();let cursor=args.cursor,ended=false,reason='Page limit reached.';
 for(let i=0;i<maxPages;i++){
  const path=gptCatalogPath({...args,cursor});if(seen.has(path)){reason='Repeated cursor; pagination stopped.';break;}seen.add(path);
  const raw=await request(path),page=normalizeGPTCatalog(raw,scope);pages.push({...page,source:path});if(args.includeRaw)rawPages.push({path,body:raw});
  if(!paginated){reason=page.coverage.reason;break;}
  const cut=page.cuts.find((c:any)=>c.id===(scope==='owned'?'mine':scope));if(!cut)throw new Error('Expected GPT catalog scope is absent.');
  if(cut.nextCursor===null){ended=true;reason='All observed pages in this scope reached the final cursor.';break;}
  cursor=String(cut.nextCursor);
 }
 const cuts=[...new Map(pages.flatMap(p=>p.cuts).map(c=>[c.id,c])).values()].map((c:any)=>({...c,items:[...new Map(pages.flatMap(p=>p.cuts.filter((x:any)=>x.id===c.id).flatMap((x:any)=>x.items)).map(x=>[x.id,x])).values()]}));
 return {scope,cuts,items:[...new Map(cuts.flatMap(c=>c.items).map(x=>[x.id,x])).values()],complete:paginated&&ended,globalComplete:false,pageCount:pages.length,nextCursor:cuts.find(c=>c.id===(scope==='owned'?'mine':scope))?.nextCursor??null,coverage:{reason,scopeComplete:paginated&&ended,globalComplete:false},...(args.includeRaw?{rawPages}:{})};
}
