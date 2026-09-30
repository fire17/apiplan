import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,chmodSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {BrowserWorker} from './transport.ts';
import {routeWorkerThroughGateway} from './gateway-registry.ts';
import {Actions} from './actions.ts';
import {OperationJournal} from './receipts.ts';
import {ALLOW_WHILE_FROZEN} from './freeze.ts';
import {atomicJSON,privateDir,type Account} from './accounts.ts';

export type HarnessWebsiteAgent={id:string;name:string;parentId?:string};
type Emit=(event:any)=>void;
export type WebsiteHarnessOptions={directory:string;emit?:Emit;mode?:'Chat'|'Work';model?:string;effort?:string;timeout?:number};
type Worker=Pick<BrowserWorker,'start'|'call'|'close'>;
type DriverActions=Pick<Actions,'idle'|'mode'|'choose'|'composer'|'snapshot'|'submit'|'waitReply'>;
type Dependencies={worker:(account:Account)=>Worker;actions:(worker:any,readReceipt:(path:string)=>Promise<any>)=>DriverActions};
type AgentState={schema:1;account:{id:string;userId:string;workspace?:string};agent:HarnessWebsiteAgent;conversation?:string;url?:string;selection?:any;requestId?:string;turn:number;phase?:string;submission?:any;updated:string};
const fault=(code:string,message:string)=>Object.assign(new Error(message),{code});
const accountKey=(a:Account)=>({id:a.id,userId:a.userId!,workspace:a.workspace});
const conversationId=(url:string)=>{try{const parsed=new URL(url);return parsed.origin==='https://chatgpt.com'?parsed.pathname.match(/^\/c\/([a-zA-Z0-9_-]+)\/?$/)?.[1]:undefined;}catch{return undefined;}};

/** DOM semantic text for protocol use; excluded regions never become executable prose. */
export function extractHarnessProtocolText(root:any):string{
 const excluded=new Set(['PRE','CODE','BLOCKQUOTE','SCRIPT','STYLE','NOSCRIPT','BUTTON','SVG','DETAILS','SUMMARY']);
 const blocks=new Set(['DIV','P','LI','UL','OL','H1','H2','H3','H4','H5','H6','SECTION','ARTICLE','TABLE','TR','TD']);
 function walk(node:any):string{
  if(node.nodeType===3)return node.nodeValue||'';
  if(node.nodeType!==1)return '';
  const tag=String(node.tagName||'').toUpperCase(),testId=node.getAttribute?.('data-testid')||'';
  if(excluded.has(tag)||node.hidden||node.getAttribute?.('aria-hidden')==='true'||node.getAttribute?.('role')==='button'||/thinking/i.test(testId))return '\n';
  if(typeof getComputedStyle==='function'){const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden')return '\n';}
  if(tag==='BR')return '\n';
  const text=Array.from(node.childNodes||[]).map(walk).join('');return blocks.has(tag)?'\n'+text+'\n':text;
 }
 if(root.closest?.('pre,code,blockquote'))return '';
 return walk(root).replace(/\n{3,}/g,'\n\n').trim();
}
export function harnessProtocolMetadata(root:any,turn:any){
 const length=(node:any)=>String(node?.innerText||node?.textContent||'').length;
 const frames=(node:any)=>(String(node?.innerText||node?.textContent||'').match(/<tool_call\b[\s\S]*?<\/tool_call>/g)||[]).length;
 const prose=turn?[...turn.querySelectorAll('.markdown,.prose,[class*="markdown"]')]:[];
 return {explicitNodeTextLength:length(root),turnTextLength:length(turn),explicitAuthorCount:turn?.querySelectorAll('[data-message-author-role]').length||0,explicitRootFrames:frames(root),wholeTurnFrames:frames(turn),proseRegions:prose.map((node:any)=>({tag:node.tagName,characters:length(node),insideExplicitRoot:!!root&&(node===root||root.contains(node))})),turnChildren:turn?[...turn.children].map((node:any)=>({tag:node.tagName,role:node.getAttribute('role'),authorRole:node.getAttribute('data-message-author-role'),children:node.childElementCount})):[]};
}
// This comparison is only a completion gate. Raw Markdown never becomes protocol input.
// The page-side extractor. The worker calls it as `(extractor)(spec)` inside one
// surface-lock hold, with the identity of the snapshot it must pin itself to.
export const HARNESS_PROTOCOL_EXTRACTOR=`spec=>{if(window.__apiplanRefs?.epoch!==spec.epoch||location.href!==spec.url)throw new Error('Harness protocol snapshot changed before semantic extraction.');const targets=(spec.messages||[]).filter(message=>message.role==='assistant').map(message=>({id:message.id,domTurnId:message.domTurnId}));const extract=${extractHarnessProtocolText.toString()},metadata=${harnessProtocolMetadata.toString()};const explicit=[...document.querySelectorAll('[data-message-author-role="assistant"]')],turns=[...document.querySelectorAll('[data-testid^="conversation-turn-"]')];return {url:location.href,visibilityState:document.visibilityState,hidden:document.hidden,messages:targets.map(target=>{let roots=target.id?explicit.filter(node=>node.getAttribute('data-message-id')===target.id):[];if(!roots.length&&target.domTurnId){const turn=turns.find(node=>node.getAttribute('data-testid')===target.domTurnId);if(turn){const direct=[...turn.querySelectorAll('[data-message-author-role="assistant"]')];if(direct.length===1)roots=direct;else if(!turn.querySelector('[data-message-author-role]')){const previous=turns[turns.indexOf(turn)-1];if(previous?.querySelector('[data-message-author-role="user"]'))roots=[turn];}}}const associatedTurn=(target.domTurnId&&turns.find(node=>node.getAttribute('data-testid')===target.domTurnId))||roots[0]?.closest('[data-testid^="conversation-turn-"]');return {...target,diagnostic:metadata(roots.length===1?roots[0]:null,associatedTurn),protocolText:roots.length===1?extract(roots[0]):'',protocolSource:roots.length===1?'semantic-dom':'unresolved-dom'};})};}`;
export function passiveDisplayText(snapshot:any,receipt:any):string|undefined{
 const completed=receipt.messages||[];
 if(!completed.length)return;
 const visible:string[]=[];
 const normalize=(text:string)=>text.replace(/^\s*(```|~~~)[^\n]*$/gm,'').replace(/[\s*_`#>~]/g,'');
 for(const expected of completed){
  const actual=(snapshot.messages||[]).find((item:any)=>item.role==='assistant'&&item.id===expected.id);
  if(!actual||actual.protocolSource!=='semantic-dom'||typeof actual.text!=='string')return;
  const raw=String(expected.text||'');
  if(normalize(raw)!==normalize(actual.text))return;
  const frames=raw.match(/<tool_call\b[\s\S]*?<\/tool_call>/g)||[];
  const displayed=actual.text.replace(/\s/g,'');
  if(frames.some(frame=>!displayed.includes(frame.replace(/\s/g,''))))return;
  visible.push(actual.text);
 }
 return visible.join('\n\n');
}
/**
 * Metadata that makes a preparation timeout explain itself.
 *
 * The 2026-09-15 failures recorded only `controlCount:2` against a loaded page's 61, which proved the app
 * never rendered but not what was served instead. These fields name the page and the controls that DID
 * exist, and flag known interstitials by marker name. Page text is never stored, only its length and which
 * markers matched, so the receipt keeps its "selector metadata and character counts only" guarantee.
 */
const PAGE_MARKERS:[string,RegExp][]=[
 ['unusual-activity',/unusual activity/i],
 ['human-verification',/verify (you are|you're) human|are you a robot|checking your browser/i],
 ['rate-limited',/too many requests|rate limit|try again later/i],
 ['signed-out',/log in|sign up|create an account/i],
 ['site-error',/something went wrong|unable to load|an error occurred/i],
 ['offline',/no internet|you are offline/i],
];
export function preparationEvidence(page:any,controls:any[]){
 const text=typeof page?.text==='string'?page.text:'';
 const markers=PAGE_MARKERS.filter(([,pattern])=>pattern.test(text)).map(([name])=>name);
 return {
  url:typeof page?.url==='string'?page.url.split('?')[0]:undefined,
  title:typeof page?.title==='string'?page.title.slice(0,120):undefined,
  textLength:text.length,
  ...(markers.length?{pageMarkers:markers}:{}),
  controlNames:controls.slice(0,8).map((c:any)=>[c?.testId||c?.id,c?.role,c?.name].filter(Boolean).join('|').slice(0,80)),
 };
}
export async function waitHarnessSurfaceReady(read:()=>Promise<any>,mode:string,existing:boolean,options:{now?:()=>number;sleep?:(ms:number)=>Promise<any>;cancelled?:()=>boolean;timeout?:number}={}){
 const now=options.now||Date.now,sleep=options.sleep||Bun.sleep,until=now()+(options.timeout??45000);
 let observed:any;
 for(;;){
  if(options.cancelled?.())throw fault('HARNESS_CLOSED','Harness driver was cancelled during preparation.');
  const page=await read(),controls=page.controls||[];
  const composer=controls.some((c:any)=>!c.disabled&&(c.id==='prompt-textarea'||c.id==='mobile-composer-prompt'||c.role==='textbox'&&c.name==='Chat with ChatGPT'));
  const requestedMode=controls.some((c:any)=>c.role==='radio'&&c.name===mode&&!c.disabled);
  observed={composerReady:composer,requestedModeReady:requestedMode,requestedMode:mode,existingConversation:existing,controlCount:controls.length,visibilityState:page.harnessDOM?.visibilityState,hidden:page.harnessDOM?.hidden,...preparationEvidence(page,controls)};
  if(composer&&(existing||requestedMode))return observed;
  if(now()>=until)throw Object.assign(fault('HARNESS_PREPARATION_TIMEOUT','Harness surface composer and requested mode controls did not become ready within 45 seconds.'),{preparation:observed});
  await sleep(150);
 }
}
type ProtocolCapture={before:Map<string,string>;text:string;emit:Emit;submittedIds?:string[]};

/** Isolated, attached-browser experiment driver. No daemon, settings, API generation, or write replay. */
export class WebsiteHarnessDriver {
 readonly directory:string;
 readonly protocolChannel=true;
 private browser:Worker;
 private journal:OperationJournal;
 private startup?:Promise<void>;
 private closed=false;
 private cancelled=false;
 private cancelling?:Promise<any>;
 private identity:any;
 private surfaces=new Map<string,{surface:string;actions:DriverActions;state:AgentState;capture?:ProtocolCapture}>();
 private active=new Set<string>();
 private diagnostics=new Map<string,any>();
 private lastDOM=new Map<string,string>();
 private surfaceNames=new Map<string,string>();// agent -> its tab, kept across recycles so the warm tab is reused
 private dependencies:Dependencies;
 private injectedActions:boolean;
 private runtimeEvidence:any;
 constructor(private account:Account,private options:WebsiteHarnessOptions,dependencies:Partial<Dependencies>={}){
  if(options.mode!==undefined&&!['Chat','Work'].includes(options.mode))throw new Error('Harness mode must be Chat or Work.');
  if(!account.userId)throw fault('ACCOUNT_MISMATCH','Harness requires a previously verified account userId.');
  if(!account.cdpURL||account.transportMode==='managed')throw fault('ATTACHED_BROWSER_REQUIRED','Harness requires an existing attached browser endpoint; it never launches or restarts the browser.');
  const endpoint=new URL(account.cdpURL);if(!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname))throw fault('ATTACHED_BROWSER_REQUIRED','Harness browser endpoint must be loopback.');
  if(new URL(account.baseURL).origin!=='https://chatgpt.com')throw fault('ACCOUNT_MISMATCH','Harness website must be https://chatgpt.com.');
  this.directory=resolve(options.directory);if(existsSync(this.directory)&&lstatSync(this.directory).isSymbolicLink())throw new Error('Unsafe harness directory.');privateDir(this.directory);chmodSync(this.directory,0o700);
  this.injectedActions=typeof dependencies.actions==='function';
  // F1: this path builds its OWN worker, so before the shared registry it was a second, entirely
  // unpaced access point onto /backend-api/conversation/{id} — the endpoint whose five 429s caused
  // the 2026-09-15 19:51 stop. It now shares the account's one limiter; a test double is left alone.
  this.dependencies={worker:a=>{const worker=new BrowserWorker(a);routeWorkerThroughGateway(a,worker as any);return worker;},actions:(worker,readReceipt)=>new Actions(worker,readReceipt),...dependencies};
  this.browser=this.dependencies.worker({...account,transportMode:'attached'});
  this.journal=new OperationJournal(account,{directory:join(this.directory,'receipts')});
 }
 private notify(event:any,emit?:Emit){for(const sink of new Set([this.options.emit,emit]))if(sink){try{sink(event);}catch{/* Observers cannot turn a positively observed write into a retry. */}}}
 private async start(){
  if(this.closed||this.cancelled)throw fault('HARNESS_CLOSED','Harness driver is closed.');
  if(!this.startup)this.startup=(async()=>{
   if(!this.injectedActions){
    const loaderPath=join(import.meta.dir,'fresh.ts'),loader=await import(loaderPath+'?revision='+statSync(loaderPath).mtimeMs),module=await loader.fresh('actions'),CurrentActions=module.Actions;
    if(typeof CurrentActions!=='function'||typeof CurrentActions.prototype.waitReply!=='function')throw new Error('Fresh Actions module does not expose waitReply.');
    const hash=(fn:any)=>createHash('sha256').update(Function.prototype.toString.call(fn)).digest('hex');
    const oldHash=hash(Actions.prototype.waitReply),freshHash=hash(CurrentActions.prototype.waitReply);
    this.runtimeEvidence={actionsSource:'fresh(actions)',staticWaitReplySHA256:oldHash,freshWaitReplySHA256:freshHash,waitReplyMatches:oldHash===freshHash,actionsMtimeMs:statSync(join(import.meta.dir,'actions.ts')).mtimeMs,at:new Date().toISOString()};
    this.dependencies.actions=(worker,readReceipt)=>new CurrentActions(worker,readReceipt);
    atomicJSON(join(this.directory,'runtime.json'),this.runtimeEvidence);this.notify({type:'harness.runtime',...this.runtimeEvidence});
   }
   await this.browser.start(false);
   const session=await this.browser.call('session');
   if(!session?.authenticated||session.user?.id!==this.account.userId)throw fault('ACCOUNT_MISMATCH','Attached website identity does not match the harness account.');
   this.identity={verified:true,userId:session.user.id,account:this.account.id,at:new Date().toISOString(),source:'website session'};
   atomicJSON(join(this.directory,'identity.json'),this.identity);
   this.notify({type:'harness.identity',...this.identity});
  })().catch(async error=>{await this.browser.close().catch(()=>{});throw error;});
  await this.startup;
 }
 private statePath(agent:HarnessWebsiteAgent){if(!agent.id||typeof agent.id!=='string')throw new Error('Agent id is required.');return join(this.directory,'agent-'+createHash('sha256').update(agent.id).digest('hex')+'.json');}
 private save(state:AgentState){state.updated=new Date().toISOString();atomicJSON(this.statePath(state.agent),state);}
 private load(agent:HarnessWebsiteAgent):AgentState{
  const path=this.statePath(agent);if(!existsSync(path))return {schema:1,account:accountKey(this.account),agent:{...agent},turn:0,updated:new Date().toISOString()};
  if(lstatSync(path).isSymbolicLink())throw new Error('Unsafe harness agent state.');
  const state=JSON.parse(readFileSync(path,'utf8')) as AgentState;
  if(state.schema!==1||state.agent?.id!==agent.id||state.agent?.parentId!==agent.parentId||JSON.stringify(state.account)!==JSON.stringify(accountKey(this.account)))throw fault('ACCOUNT_MISMATCH','Harness agent state belongs to another account or parent.');
  if(state.conversation&&!/^[a-zA-Z0-9_-]+$/.test(state.conversation))throw fault('RECEIPT_CORRUPT','Invalid saved harness conversation.');
  if(state.requestId){const evidence=this.journal.get(state.requestId);if(!['complete','not-submitted'].includes(evidence.receipt.status))throw Object.assign(fault('NEEDS_RECONCILIATION','Previous agent submission is uncertain. Automatic replay is blocked.'),{requestId:state.requestId});if(evidence.receipt.status==='complete'){state.conversation=evidence.result?.conversation;state.url=evidence.result?.url;state.phase='complete';}}
  return state;
 }
 private protocolSnapshot(snapshot:any,extraction:any){
  if(!snapshot||typeof snapshot!=='object')throw new Error('Harness protocol extraction returned no snapshot.');
  if(extraction?.url!==snapshot.url||!Array.isArray(extraction.messages))throw new Error('Harness protocol extraction returned an inconsistent surface.');
  snapshot.harnessDOM={visibilityState:extraction.visibilityState,hidden:extraction.hidden,targets:extraction.messages.map((message:any)=>({id:message.id,domTurnId:message.domTurnId,...message.diagnostic}))};
  for(const message of snapshot.messages||[]){if(message.role!=='assistant')continue;const extracted=extraction.messages.find((item:any)=>item.id===message.id&&item.domTurnId===message.domTurnId);message.protocolText=typeof extracted?.protocolText==='string'?extracted.protocolText:'';message.protocolSource=extracted?.protocolSource||'unresolved-dom';}
  return snapshot;
 }
 // One worker call: the snapshot and the extraction pinned to it share a single
 // surface-lock hold, so no other operation can republish window.__apiplanRefs.epoch
 // between them. Retries stay for the changes only the page itself can make — the
 // SPA's /c/WEB:<draft> to /c/<id> rewrite right after a first submit — and a
 // genuinely changed surface still fails the turn once the budget is spent.
 private async readProtocolSnapshot(surface:string,args:any={},timeout?:number){
  for(let attempt=0;attempt<4;attempt++){
   try{const result=await this.browser.call('snapshot.evaluate',{...args,surface,expression:HARNESS_PROTOCOL_EXTRACTOR},timeout);return this.protocolSnapshot(result?.snapshot,result?.value);}
   catch(error:any){
    if(!String(error?.message||'').includes('Harness protocol snapshot changed before semantic extraction.')||attempt===3)throw error;
    this.notify({type:'harness.snapshot.retry',surface,attempt:attempt+1,reason:'snapshot-to-extraction race',readOnly:true});
    await Bun.sleep(25*(attempt+1));
   }
  }
  throw new Error('Harness snapshot retry budget exhausted.');
 }
 /**
  * Start a fresh conversation for this agent WITHOUT opening a new tab.
  *
  * Every API request currently opens a brand-new tab and cold-boots the whole ChatGPT app; measured
  * receipts show a chain of such requests eventually landing on a page that never rendered
  * (controlCount 2 against a loaded page's 61). Recycling keeps the warm tab and its renderer, and only
  * the conversation identity is reset, so a reused surface can never leak the previous request's context.
  *
  * Refuses while a turn is active, and never clears an uncertain submission: `load()` must keep blocking
  * replay after an unknown outcome, so that state is quarantined rather than recycled.
  */
 async recycle(agent:HarnessWebsiteAgent){
  if(this.closed||this.cancelled)throw fault('HARNESS_CLOSED','Harness driver is closed.');
  if(this.active.has(agent.id))throw fault('AGENT_BUSY','A turn is already active for this agent.');
  const state=this.load(agent);// throws NEEDS_RECONCILIATION when the previous outcome is uncertain
  const entry=this.surfaces.get(agent.id);
  const surface=entry?.surface||this.surfaceNames.get(agent.id);
  this.surfaces.delete(agent.id);
  this.lastDOM.delete(agent.id);
  if(surface)this.diagnostics.delete(surface);
  const previous=state.conversation;
  state.conversation=undefined;state.url=undefined;state.turn=0;state.phase='idle';state.requestId=undefined;state.submission=undefined;state.selection=undefined as any;
  this.save(state);
  this.notify({type:'harness.recycled',agent:agent.id,surface,previousConversation:previous});
  return {agent:agent.id,surface,previousConversation:previous,reusedTab:!!surface};
 }
 private async surface(agent:HarnessWebsiteAgent,state:AgentState){
  const existing=this.surfaces.get(agent.id);if(existing)return existing;
  const surface=this.surfaceNames.get(agent.id)||'harness-'+randomUUID();
  this.surfaceNames.set(agent.id,surface);
  const captureHolder:{capture?:ProtocolCapture}={};
  const actions=this.dependencies.actions({account:this.account,call:async(operation:string,args:any={},timeout?:number)=>{
   if(operation!=='snapshot')return this.browser.call(operation,{...args,surface},timeout);
   const result=await this.readProtocolSnapshot(surface,args,timeout);
   this.diagnostics.set(surface,{at:new Date().toISOString(),url:result.url,epoch:result.epoch,messageMetadata:(result.messages||[]).map((message:any)=>({id:message.id,domTurnId:message.domTurnId,role:message.role,characters:String(message.text||'').length})),controlCount:result.controls?.length||0,generationControls:(result.controls||[]).filter((control:any)=>control.testId==='stop-button'||control.testId==='send-button'||/^(Stop answering|Stop generating|Stop streaming|Stop response|Cancel loading|Send prompt|Send message)$/.test(control.name||'')).map((control:any)=>({name:control.name,testId:control.testId,disabled:control.disabled,visible:control.visible}))});
   let snapshot=result;const capture=captureHolder.capture;
   const diagnostic=JSON.stringify(snapshot.harnessDOM);if(this.lastDOM.get(surface)!==diagnostic){this.lastDOM.set(surface,diagnostic);this.notify({type:'harness.dom',agentId:agent.id,agent:agent.id,surface,...snapshot.harnessDOM});}const cached=this.diagnostics.get(surface);if(cached)cached.dom=snapshot.harnessDOM;
   if(capture){const text=(snapshot.messages||[]).filter((message:any)=>message.role==='assistant'&&capture.before.get(message.id||message.domTurnId)!==message.protocolText).map((message:any)=>message.protocolText||'').filter(Boolean).join('\n\n');if(text!==capture.text){capture.text=text;capture.emit({type:'protocol.replace',text});}}
   if(capture?.submittedIds?.length){
    const passive=await this.browser.call('generation.receipt',{surface,userIds:capture.submittedIds,conversation:conversationId(snapshot.url)});
    if(passive?.authoritative===true&&typeof passive.text==='string'&&passive.conversation===conversationId(snapshot.url)){
     let displayText=passiveDisplayText(snapshot,passive);
     const until=Date.now()+10000;
     while(displayText===undefined&&Date.now()<until&&!this.closed&&!this.cancelled){
      await Bun.sleep(100);snapshot=await this.readProtocolSnapshot(surface,args,timeout);
      if(conversationId(snapshot.url)!==passive.conversation)throw fault('CONTEXT_MISMATCH','Passive completion DOM changed conversation.');
      displayText=passiveDisplayText(snapshot,passive);
     }
     if(displayText===undefined)throw fault('HARNESS_PROTOCOL_INCOMPLETE','The completed generation did not synchronize with its matching semantic DOM message; no final tool calls were inferred from raw Markdown.');
     const finalProtocol=(snapshot.messages||[]).filter((message:any)=>message.role==='assistant'&&capture.before.get(message.id||message.domTurnId)!==message.protocolText).map((message:any)=>message.protocolText||'').filter(Boolean).join('\n\n');
     if(finalProtocol!==capture.text){capture.text=finalProtocol;capture.emit({type:'protocol.replace',text:finalProtocol});}
     this.notify({type:'harness.generation.receipt',agentId:agent.id,surface,sequence:passive.sequence,source:passive.source,additionalRequests:passive.additionalRequests,characters:passive.text.length,assistantMessages:passive.messages?.length||0,protocolSource:'semantic DOM only'});
     throw Object.assign(new Error('Owned generation response positively completed.'),{code:'HARNESS_PASSIVE_COMPLETE',result:{text:displayText,displayText,authoritativeText:passive.text,url:snapshot.url,conversation:passive.conversation,messages:passive.messages,media:snapshot.media,source:'observed page generation response',generationReceipt:{sequence:passive.sequence,source:passive.source,additionalRequests:passive.additionalRequests,authoritative:true},protocolSource:'semantic DOM only'}});
    }
   }
   return snapshot;
  }},async()=>{throw Object.assign(new Error('429 rate limited: harness bulk conversation receipt reads are deferred.'),{code:'RATE_LIMITED',status:429});});
  const entry={surface,actions,state,get capture(){return captureHolder.capture;},set capture(value:ProtocolCapture|undefined){captureHolder.capture=value;}};this.surfaces.set(agent.id,entry);
  try{
   const opened=await this.browser.call('surface.open',{surface,url:state.conversation?'https://chatgpt.com/c/'+state.conversation:'https://chatgpt.com/',keepRendering:true});
   if(opened?.rendering?.enabled!==true||opened.rendering.visibilityState!=='visible'||opened.rendering.hidden!==false)throw new Error('Harness surface did not verify visible rendering.');
   await waitHarnessSurfaceReady(()=>actions.snapshot(),this.options.mode||'Chat',!!state.conversation,{cancelled:()=>this.closed||this.cancelled});
   await actions.idle();
   if(state.conversation){
    const observed=await actions.snapshot();if(conversationId(observed.url)!==state.conversation)throw fault('CONTEXT_MISMATCH','Agent surface did not open its saved conversation.');
    if(state.selection?.mode?.verified!==true||state.selection.mode.selected!==(this.options.mode||'Chat'))throw fault('RECEIPT_CORRUPT','Saved agent lacks verified requested-mode creation evidence.');
   }
   const mode=state.conversation?state.selection.mode:await actions.mode(this.options.mode||'Chat');
   const model=await actions.choose('model',this.options.model||'Latest');
   const effort=await actions.choose('effort',this.options.effort||'Instant');
   if(mode?.verified!==true||mode.selected!==(this.options.mode||'Chat')||model?.verified!==true||effort?.verified!==true)throw fault('SELECTION_UNVERIFIED','Website did not verify requested harness mode, model and effort.');
   state.selection={mode,model,effort,rendering:opened.rendering,observedAt:new Date().toISOString(),modeSource:state.conversation?'verified creation receipt':'current website controls'};this.save(state);
   this.notify({type:'harness.selection',agent:agent.id,surface,...state.selection});return entry;
  }catch(error:any){
   const diagnostic=this.diagnostics.get(surface);
   if(state.requestId&&diagnostic){try{const path=join(this.directory,state.requestId+'.diagnostic.json');atomicJSON(path,{requestId:state.requestId,phase:'not-submitted',code:error.code||'OPERATION_FAILED',preparation:error.preparation,lastObserved:diagnostic,coverage:'Cached selector metadata and character counts only; no conversation text or HTML.'});error.diagnosticPath=path;}catch{}}
   this.surfaces.delete(agent.id);this.surfaceNames.delete(agent.id);await this.browser.call('surface.close',{surface}).catch(()=>{});throw error;
  }
 }
 async send(agent:HarnessWebsiteAgent,text:string,emit?:Emit):Promise<any>{
  if(this.closed||this.cancelled)throw fault('HARNESS_CLOSED','Harness driver is closed.');
  if(this.active.has(agent.id))throw fault('AGENT_BUSY','A turn is already active for this agent.');
  if(typeof text!=='string'||!text.trim())throw fault('NOT_SUBMITTED','Harness turn text must not be empty.');
  this.active.add(agent.id);let attempted=false,requestId:string|undefined,state:AgentState|undefined;
  try{
   state=this.load(agent);
   const attempt=this.journal.start('chat.send',{agent,text,conversation:state.conversation,turn:state.turn+1});requestId=attempt.id;
   state.requestId=requestId;state.phase='preparing';state.submission=undefined;this.save(state);
   this.notify({type:'operation.receipt',agent:agent.id,requestId},emit);
   await this.start();if(this.cancelled)throw fault('HARNESS_CLOSED','Harness driver was cancelled.');const entry=await this.surface(agent,state);entry.state=state;
   await entry.actions.idle();const current=await entry.actions.snapshot();
   if(state.conversation&&conversationId(current.url)!==state.conversation)throw fault('CONTEXT_MISMATCH','Agent conversation changed outside this harness.');
   await entry.actions.composer(text);const before=await entry.actions.snapshot();
   entry.capture={before:new Map((before.messages||[]).filter((message:any)=>message.role==='assistant').map((message:any)=>[message.id||message.domTurnId,message.protocolText||''])),text:'',emit:event=>this.notify({...event,agent:agent.id,requestId},emit)};
   if(this.cancelled||this.closed)throw fault('HARNESS_CLOSED','Harness driver was cancelled before submission.');
   state.phase='submitting';this.save(state);attempted=true;
   await entry.actions.submit();
   this.notify({type:'submission.pending',agent:agent.id,requestId,url:before.url,source:'website submit control activated'},emit);
   let result:any;try{result=await entry.actions.waitReply(before,event=>{
    if(event.type==='submitted'&&event.verified===true){if(entry.capture)entry.capture.submittedIds=(event.messages||[]).map((message:any)=>message.id).filter((id:any)=>typeof id==='string'&&!!id);state!.phase='submitted';state!.submission={...event,at:new Date().toISOString()};const observed=conversationId(event.url);if(observed){state!.conversation=observed;state!.url=event.url;}this.save(state!);}
    this.notify({...event,agent:agent.id,requestId},emit);
   },this.options.timeout||600000,()=>this.closed||this.cancelled);}catch(error:any){if(error?.code!=='HARNESS_PASSIVE_COMPLETE')throw error;result=error.result;this.notify({type:'replace',text:result.text,agent:agent.id,requestId},emit);}
   const observed=conversationId(result.url);if(!observed||result.conversation!==observed)throw fault('OUTCOME_UNKNOWN','Reply lacks a verified website conversation URL.');
   if(state.conversation&&observed!==state.conversation)throw fault('CONTEXT_MISMATCH','Response belongs to another conversation.');
   const complete={...result,displayText:result.displayText??result.text,protocolText:entry.capture?.text||'',requestId,driver:{kind:'website',agent:{...agent},surface:entry.surface,identity:this.identity,runtime:this.runtimeEvidence,selection:state.selection,submission:state.submission||null,bulkReceiptReads:'disabled',browserOwned:false}};
   this.journal.finish(requestId,complete);state.conversation=observed;state.url=result.url;state.turn++;state.phase='complete';this.save(state);return complete;
  }catch(error:any){
   if(attempted){if(!error.code||['OPERATION_FAILED','NOT_SUBMITTED'].includes(error.code))error.code='OUTCOME_UNKNOWN';error.action='Submission was attempted. Inspect this agent conversation and its private receipt; do not automatically resend.';}
   if(requestId){const entry=this.surfaces.get(agent.id),diagnostic=entry&&this.diagnostics.get(entry.surface);if(diagnostic){try{const diagnosticPath=join(this.directory,requestId+'.diagnostic.json');atomicJSON(diagnosticPath,{requestId,phase:attempted?'unknown':'not-submitted',code:error.code||'OPERATION_FAILED',lastObserved:diagnostic,coverage:'Cached selector metadata and character counts only; no conversation text or HTML.'});error.diagnosticPath=diagnosticPath;}catch{}}}
   if(!attempted&&!['NEEDS_RECONCILIATION','ACCOUNT_MISMATCH','RECEIPT_CORRUPT'].includes(error?.code))Object.assign(error,{causeCode:error.code,code:'NOT_SUBMITTED',submissionState:'not-submitted'});
   if(requestId){this.journal.fail(requestId,{code:attempted?'OUTCOME_UNKNOWN':'NOT_SUBMITTED'});if(state){state.phase=attempted?'unknown':'not-submitted';try{this.save(state);}catch{}}Object.assign(error,{requestId,submissionState:attempted?'unknown':'not-submitted'});}
   this.notify({type:'submission.failed',agent:agent.id,requestId,submissionState:attempted?'unknown':'not-submitted',message:error.message},emit);throw error;
  }finally{const entry=this.surfaces.get(agent.id);if(entry)entry.capture=undefined;this.active.delete(agent.id);}
 }
 async cancel(){
  this.cancelled=true;
  if(this.cancelling)return this.cancelling;
  this.cancelling=(async()=>{const results=await Promise.all([...this.surfaces.entries()].filter(([id,entry])=>this.active.has(id)||['submitting','submitted','unknown'].includes(entry.state.phase||'')).map(async([agentId,entry])=>{
   try{const snapshot=await this.browser.call('snapshot',{surface:entry.surface});const control=snapshot.controls.find((control:any)=>control.testId==='stop-button'||/^(Stop answering|Stop generating|Stop streaming|Stop response|Cancel loading)$/.test(control.name||''));
    if(!control)return {agentId,requested:false,confirmed:false,reason:'no stop control observed'};
    // A freeze must still be able to stop a generation that is already streaming.
    // The capability is a Symbol on this literal only: it is never spread from
    // caller-supplied args, never rebuilt from a string, and JSON drops it before
    // the args reach the worker. It marks the website's own Stop control, nothing else.
    await this.browser.call('action',{surface:entry.surface,epoch:snapshot.epoch,ref:control.ref,kind:'click',[ALLOW_WHILE_FROZEN]:true});
    let confirmed=false;for(let attempt=0;attempt<4;attempt++){await Bun.sleep(150);const next=await this.browser.call('snapshot',{surface:entry.surface});if(!next.controls.some((control:any)=>control.testId==='stop-button'||/^(Stop answering|Stop generating|Stop streaming|Stop response|Cancel loading)$/.test(control.name||''))){confirmed=true;break;}}
    return {agentId,requested:true,confirmed,source:'owned website stop control'};
   }catch(error:any){return {agentId,requested:false,confirmed:false,error:error.message};}
  }));const result={type:'harness.cancel',results};this.notify(result);return result;})();return this.cancelling;
 }
 async close(){if(this.closed)return;await this.cancel();this.closed=true;await Promise.allSettled([...this.surfaces.values()].map(entry=>this.browser.call('surface.close',{surface:entry.surface})));this.surfaces.clear();this.surfaceNames.clear();await this.browser.close();}
}
