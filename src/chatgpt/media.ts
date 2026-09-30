import {createHash} from 'node:crypto';
import type {MediaReference} from './takeout.ts';
import {paginateCursor} from './store.ts';
import {join,resolve} from 'node:path';
import {existsSync,readFileSync,writeFileSync,renameSync,chmodSync,lstatSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {atomicJSON,privateDir} from './accounts.ts';
export type MediaRequest=(path:string,method?:string,body?:any,binary?:boolean)=>Promise<any>;
export type MediaObservation={reference:string;url:string};
export type MediaDownload={bytes:Uint8Array;contentType:string;extension:string;metadata:{source:'observed-chatgpt-estuary';referenceId:string;sha256:string;bytes:number}};
const BOOTSTRAP='/backend-api/images/bootstrap';
const THUMBNAIL='chatgpt-images-bootstrap:thumbnail';
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
/** The only currently verified asset host/route; extend after observing a real response. */
function assetURL(value:string){let u:URL;try{u=new URL(value);}catch{throw new Error('Unsupported media reference; capture the website download request.');}
 if(u.protocol!=='https:'||u.hostname!=='chatgpt.com'||u.port||u.username||u.password||u.pathname!=='/backend-api/estuary/content'||u.hash)throw new Error('Unsupported media destination; only the observed ChatGPT estuary content route is enabled.');
 return u;
}
export async function imageBootstrap(request:MediaRequest){const raw=await request(BOOTSTRAP);if(typeof raw?.images_count!=='number'||typeof raw?.archived_images_count!=='number')throw new Error('Unrecognized image bootstrap response; image library completeness is unknown.');
 const items:MediaReference[]=[];if(raw.thumbnail_url){assetURL(raw.thumbnail_url);items.push({id:'bootstrap-thumbnail',reference:THUMBNAIL,conversationId:'',kind:'image-thumbnail'});}
 return {items,counts:{active:raw.images_count,archived:raw.archived_images_count},complete:false,coverage:{scope:'media:library',complete:false,count:items.length,total:raw.images_count+raw.archived_images_count,reason:'Observed bootstrap exposes counts and one thumbnail. Full image library enumeration remains unverified.'}};
}
const LIBRARY_NODES='/backend-api/files/library/nodes?hydrate_folder_thumbnails=true&include_onedrive=true&include_folder_counts=true&include_saved_entities=true';
/** Observed account catalogs. External provider nodes stay metadata-only. */
export async function listMedia(request:MediaRequest,options:{includeRaw?:boolean;maxPages?:number}={}){
 const startedAt=new Date().toISOString();let bootstrapRaw:any;const bootstrapRequestStartedAt=new Date().toISOString();
 const bootstrap=await imageBootstrap(async(...args)=>{bootstrapRaw=await request(...args);return bootstrapRaw;});const bootstrapAt=new Date().toISOString();
 const rootPages:any[]=[];
 const library=await paginateCursor(async cursor=>{const requestStartedAt=new Date().toISOString(),response=await request(LIBRARY_NODES+(cursor?'&cursor='+encodeURIComponent(cursor):''));rootPages.push({scope:'library-root',cursorIn:cursor??null,requestStartedAt,capturedAt:new Date().toISOString(),response});return response;},'media:library-root',{maxPages:options.maxPages});
 const imagePages:any[]=[],generationPages:any[]=[];
 const imageLibrary=await paginateCursor(async cursor=>{const requestStartedAt=new Date().toISOString(),response=await request('/backend-api/files/library','POST',{limit:20,cursor:cursor||null,categories:['image'],include_saved_entities:true});imagePages.push({scope:'image-library',cursorIn:cursor??null,requestStartedAt,capturedAt:new Date().toISOString(),response});return response;},'media:image-library',{maxPages:options.maxPages});
 const generated=await paginateCursor(async cursor=>{const requestStartedAt=new Date().toISOString(),response=await request('/backend-api/my/recent/image_gen?limit=25'+(cursor?'&after='+encodeURIComponent(cursor):''));generationPages.push({scope:'generated-images',cursorIn:cursor??null,requestStartedAt,capturedAt:new Date().toISOString(),response});return response;},'media:generated-images',{maxPages:options.maxPages});
 const uploadsRequestStartedAt=new Date().toISOString();const uploadedRaw=await request('/backend-api/my/recent/uploaded_images?limit=25&images_app_only=true');const uploadsCapturedAt=new Date().toISOString();
 if(!Array.isArray(uploadedRaw?.items))throw new Error('Unexpected images-app uploaded catalog.');
 const uploaded=uploadedRaw.items;
 const byId=new Map<string,any>();
 for(const raw of [...library.items,...imageLibrary.items]){const owned=(raw.kind===undefined||raw.kind==='file')&&raw.access_kind==='owned'&&(raw.app_id==null||raw.app_id==='chatgpt-web')&&typeof raw.file_id==='string'&&/^file[_-][A-Za-z0-9_-]+$/.test(raw.file_id);const reference=owned?'sediment://'+raw.file_id:undefined;byId.set(reference||raw.id,{id:raw.id,reference,conversationId:raw.origination_thread_id||'',kind:raw.kind||'file',name:raw.name||raw.file_name,mimeType:raw.mime_type,extension:raw.file_extension,bytes:raw.file_size_bytes,origin:{appId:raw.app_id,access:raw.access_kind,parentDirectoryId:raw.parent_directory_id||raw.directory_id,threadId:raw.origination_thread_id,messageId:raw.origination_message_id},downloadable:owned,...(!owned?{reason:'Metadata only: external, directory or unverified ownership.'}:{})});}
 for(const raw of generated.items){const owned=raw.source==='chatgpt'&&raw.generation_type==='image_gen'&&/^(?:sediment|file-service):\/\/file[_-][A-Za-z0-9_-]+$/.test(raw.asset_pointer||'');const reference=owned?raw.asset_pointer:undefined;const old=byId.get(reference);byId.set(reference||raw.id,{...old,id:old?.id||raw.id,reference,conversationId:raw.conversation_id||'',kind:'generated-image',name:raw.title,origin:{...old?.origin,source:raw.source,threadId:raw.conversation_id,messageId:raw.message_id,generationId:raw.generation_id},downloadable:owned,isArchived:raw.is_archived,...(!owned?{reason:'Metadata only: generated image ownership or reference is unverified.'}:{})});}
 for(const raw of uploaded){const owned=/^file[_-][A-Za-z0-9_-]+$/.test(raw.file_id||'');const reference=owned?'sediment://'+raw.file_id:undefined;const old=byId.get(reference);byId.set(reference||raw.file_id,{...old,id:old?.id||raw.file_id,reference,conversationId:old?.conversationId||'',kind:old?.kind||'uploaded-image',name:old?.name||'Uploaded image',origin:{...old?.origin,imagesAppUpload:true,uploadTimestamp:raw.timestamp},downloadable:owned,...(!owned?{reason:'Unrecognized images-app upload file ID.'}:{})});}
 const items=[...byId.values()],folders=library.items.filter((x:any)=>x.kind!=='file').length;
 const imageRefs=new Set<string>();for(const raw of generated.items)if(raw.is_archived!==true&&typeof raw.asset_pointer==='string')imageRefs.add(raw.asset_pointer.replace(/^(?:sediment|file-service):\/\//,''));for(const raw of [...library.items,...imageLibrary.items])if(raw.access_kind==='owned'&&(raw.library_file_category==='image'||String(raw.mime_type||'').startsWith('image/'))&&typeof raw.file_id==='string')imageRefs.add(raw.file_id);
 for(const raw of uploaded)if(typeof raw.file_id==='string')imageRefs.add(raw.file_id);
 const galleryRows=generated.items.filter((x:any)=>x.is_archived!==true).length+uploaded.length;
 const countsMatch=galleryRows===bootstrap.counts.active;
 const uploadedBounded=uploaded.length<25&&!uploadedRaw.cursor;
 const uploadedCoverage={scope:'media:images-app-uploads',complete:uploadedBounded,count:uploaded.length,pages:1,limit:25,reason:uploadedBounded?undefined:'Full uploaded page or unexpected cursor; continuation is not yet observed. No pagination parameter was guessed.'};
 const coverage=[library.coverage,{scope:'media:library-folders',complete:folders===0,count:folders,reason:folders?'Nested directory enumeration is not yet verified.':undefined},imageLibrary.coverage,generated.coverage,uploadedCoverage,{scope:'media:image-count-reconciliation',complete:countsMatch&&uploadedBounded,count:galleryRows,basis:'generated rows plus images-app uploaded rows; includes cross-catalog duplicates',uniqueBinaryCount:imageRefs.size,total:bootstrap.counts.active,reason:countsMatch?undefined:'Images-app row count differs from bootstrap; snapshot changes or unobserved pagination remain unresolved.'},{scope:'media:archived-images',complete:bootstrap.counts.archived===0,count:bootstrap.counts.archived,reason:bootstrap.counts.archived?'Archived image enumeration is not yet observed.':undefined}];
 return {items,startedAt,bootstrapAt,finishedAt:new Date().toISOString(),counts:{...bootstrap.counts,enumeratedGenerated:generated.items.length,enumeratedImagesAppUploaded:uploaded.length,enumeratedGalleryRows:galleryRows,enumeratedImageUnion:imageRefs.size},complete:coverage.every(c=>c.complete),globalComplete:false,scope:'exposed-library-and-generated-images',coverage,...(options.includeRaw?{rawPages:[{scope:'images-bootstrap',cursorIn:null,requestStartedAt:bootstrapRequestStartedAt,capturedAt:bootstrapAt,response:bootstrapRaw},...rootPages,...imagePages,...generationPages,{scope:'images-app-uploads',cursorIn:null,requestStartedAt:uploadsRequestStartedAt,capturedAt:uploadsCapturedAt,response:uploadedRaw}]}:{})};
}
function detect(bytes:Uint8Array,contentType:string,expectedContentType?:string){const b=Buffer.from(bytes);const mime=contentType.split(';')[0].trim().toLowerCase();
 if(mime==='text/html'&&expectedContentType==='text/html')return {contentType:mime,extension:'html'};
 if(mime==='application/json'&&expectedContentType==='application/json'){try{JSON.parse(b.toString());return {contentType:mime,extension:'json'};}catch{throw new Error('Media JSON payload was invalid.');}}
 const signatures:[boolean,string,string][]=[
  [b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'image/png','png'],
  [b[0]===255&&b[1]===216&&b[2]===255,'image/jpeg','jpg'],
  [b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP','image/webp','webp'],
  [/^GIF8[79]a/.test(b.subarray(0,6).toString()),'image/gif','gif'],
  [b.subarray(0,5).toString()==='%PDF-','application/pdf','pdf'],
  [b.subarray(0,4).toString()==='OggS','audio/ogg','ogg'],
  [b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WAVE','audio/wav','wav'],
 ];for(const [match,type,extension]of signatures)if(match)return {contentType:type,extension};
 if(mime==='text/html'||/^\s*(?:<!doctype html|<html)/i.test(b.subarray(0,300).toString()))throw new Error('Media download returned an HTML page, not asset bytes.');
 const known:Record<string,string>={'audio/mpeg':'mp3','audio/mp4':'m4a','video/mp4':'mp4','video/webm':'webm','audio/webm':'webm','image/avif':'avif','text/plain':'txt','application/zip':'zip'};
 if(mime==='application/json')throw new Error('Media endpoint returned JSON instead of asset bytes.');
 return {contentType:mime||'application/octet-stream',extension:known[mime]||'bin'};
}
/** Resolve only a server-supplied signed URL or an explicit observed pointer→URL mapping.
 * File IDs use the observed /files/download/{id}?inline=true resolver, verified against archived sediment references.
 * Downloads use the browser-authenticated request adapter; no separate network client is used.
 */
export async function downloadMedia(ref:MediaReference|string,request:MediaRequest,options:{observations?:MediaObservation[];maxBytes?:number;expectedContentType?:string}={}):Promise<MediaDownload>{
 const reference=typeof ref==='string'?ref:ref.reference;let url:string;
 if(reference===THUMBNAIL||reference==='bootstrap-thumbnail'){const raw=await request(BOOTSTRAP);if(typeof raw.thumbnail_url!=='string'||!raw.thumbnail_url)throw new Error('No image thumbnail is exposed by this account.');url=raw.thumbnail_url;}
 else if(/^https:\/\//.test(reference))url=reference;
 else if(/^(?:(?:sediment|file-service):\/\/)?file[_-][A-Za-z0-9_-]+$/.test(reference)){const id=reference.replace(/^(?:sediment|file-service):\/\//,'');const resolved=await request('/backend-api/files/download/'+encodeURIComponent(id)+'?inline=true');if(resolved.status!=='success'||typeof resolved.download_url!=='string')throw new Error('File download URL was not exposed by the observed resolver.');url=resolved.download_url;}
 else{const found=options.observations?.find(x=>x.reference===reference);if(!found)throw new Error('Unsupported media pointer: no observed download URL mapping. Open the attachment or image and use its website download control to discover the request.');url=found.url;}
 const target=assetURL(url);const response=await request(target.pathname+target.search,'GET',undefined,true);
 if(response.status!==undefined&&(response.status<200||response.status>=300))throw new Error('Media download was inaccessible (HTTP '+response.status+').');
 if(!(response.bytes instanceof Uint8Array)&&(typeof response.base64!=='string'||!response.base64))throw new Error('Media download returned no binary payload.');
 const bytes=response.bytes instanceof Uint8Array?Buffer.from(response.bytes):Buffer.from(response.base64,'base64');if(!bytes.length||bytes.length>(options.maxBytes??512*1024*1024))throw new Error('Media payload is empty or exceeds the configured download limit.');
 const type=detect(bytes,response.contentType||'',options.expectedContentType);return {bytes,...type,metadata:{source:'observed-chatgpt-estuary',referenceId:typeof ref==='string'?sha(reference).slice(0,40):ref.id,sha256:sha(bytes),bytes:bytes.length}};
}

/** Reclassify a previously captured private catalog without fetching it again. */
export function refreshMediaCatalog(catalog:any){
 const rawById=new Map<string,any>();for(const page of catalog.rawPages||[])if(['library-root','image-library'].includes(page.scope))for(const item of page.response?.items||[])rawById.set(item.id,item);
 return {...catalog,items:(catalog.items||[]).map((item:any)=>{const raw=rawById.get(item.id);if(item.downloadable||!raw)return item;const owned=(raw.kind===undefined||raw.kind==='file')&&raw.access_kind==='owned'&&(raw.app_id==null||raw.app_id==='chatgpt-web')&&/^file[_-][A-Za-z0-9_-]+$/.test(raw.file_id||'');return owned?{...item,downloadable:true,reference:'sediment://'+raw.file_id,reason:undefined}:item;})};
}
type ExportEntry={file:string;bytes:number;sha256:string;contentType:string;referenceId:string};
type ExportManifest={version:1;accountId:string;userId?:string;updated:string;complete:boolean;downloadComplete:boolean;entries:Record<string,ExportEntry>;failures:Record<string,{status:string;reason:string;code?:string;httpStatus?:number}>;targets:string[];coverage:any;catalogComplete:boolean};
function exportFile(root:string,file:string){if(!/^[a-f0-9]{40}\.[a-z0-9]{1,8}$/.test(file))throw new Error('Unsafe media manifest filename.');const path=join(root,file);if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('Media export contains a symbolic link.');return path;}
function validExport(root:string,e:ExportEntry){try{const bytes=readFileSync(exportFile(root,e.file));return bytes.length===e.bytes&&sha(bytes)===e.sha256;}catch{return false;}}
export function auditMedia(output:string){const root=resolve(output),m=JSON.parse(readFileSync(join(root,'media-manifest.json'),'utf8')) as ExportManifest;const damaged=Object.entries(m.entries).filter(([,e])=>!validExport(root,e)).map(([id,e])=>({id,file:e.file}));return {path:root,integrity:damaged.length===0,complete:m.complete&&damaged.length===0,downloadComplete:m.downloadComplete&&damaged.length===0,files:Object.keys(m.entries).length,targets:m.targets.length,failed:Object.keys(m.failures).length,damaged,coverage:m.coverage};}
/** Export an already captured catalog; never re-enumerate or crawl external providers.
 * A rate limit stops this run, retaining a checkpoint for an explicit later resume. */
export async function exportMedia(catalog:any,request:MediaRequest,options:{output:string;accountId:string;userId?:string;signal?:AbortSignal;maxBytes?:number},emit:(event:any)=>void=()=>{}){
 if(!options.accountId||!Array.isArray(catalog?.items))throw new Error('Media export needs an account identity and captured catalog.');
 catalog=refreshMediaCatalog(catalog);
 const root=resolve(options.output);if(existsSync(root)&&lstatSync(root).isSymbolicLink())throw new Error('Media export root cannot be a symbolic link.');privateDir(root);
 const lock=join(root,'.writer.lock');if(existsSync(lock)){if(lstatSync(lock).isSymbolicLink())throw new Error('Unsafe media export lock.');const pid=Number(readFileSync(lock,'utf8'));let alive=true;try{process.kill(pid,0);}catch(e){if((e as any).code==='ESRCH')alive=false;}if(alive||!Number.isSafeInteger(pid)||pid<=0)throw new Error('Media export already has an active writer.');unlinkSync(lock);}
 const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);
 try{
  const path=join(root,'media-manifest.json');let m:ExportManifest={version:1,accountId:options.accountId,userId:options.userId,updated:new Date().toISOString(),complete:false,downloadComplete:false,entries:{},failures:{},targets:[],coverage:catalog.coverage,catalogComplete:catalog.complete===true};
  if(existsSync(path)){m=JSON.parse(readFileSync(path,'utf8'));if(m.version!==1||m.accountId!==options.accountId||m.userId!==options.userId)throw new Error('Media export account identity does not match.');}
  const refs=new Map<string,MediaReference>();for(const item of catalog.items){if(item.downloadable!==true||typeof item.reference!=='string')continue;const id=sha(item.reference).slice(0,40);refs.set(id,{id,reference:item.reference,conversationId:item.conversationId||'',kind:item.kind||'file'});}
  m.targets=[...refs.keys()];m.coverage=catalog.coverage;m.catalogComplete=catalog.complete===true;
  const save=()=>{m.updated=new Date().toISOString();m.complete=false;m.downloadComplete=false;atomicJSON(path,m);};save();atomicJSON(join(root,'catalog.json'),catalog);
  let completed=0,paused=false;
  for(const [id,ref] of refs){if(options.signal?.aborted){paused=true;break;}
   if(m.entries[id]&&validExport(root,m.entries[id])){delete m.failures[id];completed++;continue;}
   try{const item=catalog.items.find((item:any)=>item.reference===ref.reference);const result=await downloadMedia(ref,request,{maxBytes:options.maxBytes,expectedContentType:item?.mimeType});const file=id+'.'+result.extension,destination=exportFile(root,file),tmp=destination+'.tmp';if(existsSync(tmp)&&lstatSync(tmp).isSymbolicLink())throw new Error('Unsafe media temporary file.');writeFileSync(tmp,result.bytes,{mode:0o600});chmodSync(tmp,0o600);renameSync(tmp,destination);m.entries[id]={file,bytes:result.bytes.length,sha256:result.metadata.sha256,contentType:result.contentType,referenceId:ref.id};delete m.failures[id];completed++;}
   catch(error){const status=(error as any)?.status;const rateLimited=status===429||/\b429\b|rate.limit/i.test(String((error as any)?.message||error));const message=String((error as any)?.message||'');const code=rateLimited?'RATE_LIMIT':/HTML page/.test(message)?'UNEXPECTED_HTML':/JSON instead/.test(message)?'UNEXPECTED_JSON':/download limit/.test(message)?'PAYLOAD_LIMIT':/no binary payload/.test(message)?'EMPTY_PAYLOAD':/not exposed/.test(message)?'RESOLVER_UNAVAILABLE':'DOWNLOAD_FAILED';const reasons:Record<string,string>={RATE_LIMIT:'Resume after the account cooldown.',UNEXPECTED_HTML:'Unexpected HTML response; verify catalog MIME or website authentication.',UNEXPECTED_JSON:'Unexpected JSON response; verify catalog MIME or resolver response.',PAYLOAD_LIMIT:'Payload is empty or exceeds the configured byte limit.',EMPTY_PAYLOAD:'Browser transport returned no binary payload.',RESOLVER_UNAVAILABLE:'Observed resolver did not expose a successful download URL.',DOWNLOAD_FAILED:'Transport or payload verification failed; retry this asset after checking browser status.'};m.failures[id]={status:rateLimited?'rate-limited':status===401||status===403||status===404?'inaccessible':'failed',code,...(Number.isInteger(status)?{httpStatus:status}:{}),reason:reasons[code]};if(rateLimited){paused=true;save();emit({type:'media.export.paused',reason:'rate-limit',completed,total:refs.size});break;}}
   save();emit({type:'media.export.progress',completed,total:refs.size,failed:Object.keys(m.failures).length});
  }
  m.downloadComplete=!paused&&m.targets.every(id=>!!m.entries[id]&&validExport(root,m.entries[id]));m.complete=m.downloadComplete&&m.catalogComplete;m.updated=new Date().toISOString();atomicJSON(path,m);const result={...auditMedia(root),paused};emit({type:'media.export.finished',files:result.files,downloadComplete:result.downloadComplete,complete:result.complete,paused});return result;
 }finally{unlinkSync(lock);}
}
/** Reuse a verified standalone export in a later takeout pass. */
export function readExportedMedia(output:string,ref:MediaReference|string,identity:{accountId:string;userId?:string}):MediaDownload|undefined{
 try{const root=resolve(output);if(lstatSync(root).isSymbolicLink())return;const m=JSON.parse(readFileSync(join(root,'media-manifest.json'),'utf8')) as ExportManifest;if(m.version!==1||m.accountId!==identity.accountId||m.userId!==identity.userId)return;const reference=typeof ref==='string'?ref:ref.reference,id=sha(reference).slice(0,40),entry=m.entries[id];if(!entry||!validExport(root,entry))return;const bytes=readFileSync(exportFile(root,entry.file));return {bytes,contentType:entry.contentType,extension:entry.file.split('.').pop()!,metadata:{source:'observed-chatgpt-estuary',referenceId:id,sha256:entry.sha256,bytes:bytes.length}};}catch{return;}
}
