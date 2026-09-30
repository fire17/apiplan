import {parseSlash,serviceOperations} from './slash.ts';
import {readFreeze,setFreeze} from './freeze.ts';
import {messageTime,messageTimeLabel,localMessageTime,type MessageTime} from './message-time.ts';
import {ComposerNavigation,composerPositions,composerViewport} from './tui-composer.ts';
import {account,config,type Account} from './accounts.ts';
import {call} from './daemon.ts';
import {clean,clip,pad,wrap,width,graphemes,InputDecoder,shortcutModifier,composedShortcuts,type Key} from './tui-terminal.ts';
import {BrowserViewport} from './tui-viewport.ts';
import {groupPalette} from './tui-palette.ts';
import {mockClient} from './tui-mock.ts';
import {WebsiteSelection} from './tui-model.ts';
import {SharedQueue,queueContextLabel,queuePermissions,sharedQueueSummary,sharedQueueTranscript} from './tui-shared-queue.ts';
import {saveTuiSession} from './tui-session.ts';
import {LocalQueue,bindQueuedConversation,completedParentConversation,type QueuedDraft} from './tui-queue.ts';
import {attachmentPath,mediaReference} from './tui-files.ts';
import {recentFirst} from './tui-nav.ts';
import {uncertainDuplicate,reconcileMessages,needsReconciliation,recoverableConnectionError} from './tui-delivery.ts';
import {mergeThinking,thinkingLines,generationIndicator,currentThinkingLabel,type ThinkingItem} from './tui-thinking.ts';

const esc='\x1b[', color={blue:esc+'94m',green:esc+'92m',amber:esc+'93m',dim:esc+'2m',bold:esc+'1m',reset:esc+'0m'};
const paint=(s:string,c:keyof typeof color)=>color[c]+s+color.reset;
const id=(r:any)=>r.id||r.conversation_id||r.gizmo?.id||r.gizmo?.gizmo?.id||r.project?.id||r.slug||'';
const title=(r:any)=>r.title||r.name||r.display?.name||r.gizmo?.display?.name||r.gizmo?.gizmo?.display?.name||r.project?.title||id(r);
const rows=(r:any)=>Array.isArray(r)?r:r?.items||r?.models||r?.projects||r?.gpts||[];
type Message=Partial<MessageTime>&{role:string;text:string;id?:string;thinking?:ThinkingItem[];files?:string[];media?:any[];requestId?:string;delivery?:'submitting'|'submitted'|'answered'|'unconfirmed'};
type Choice={label:string;run:()=>void|Promise<void>};
export type TuiControl={requestReload:()=>void;notice:(message:string)=>void};
export type TuiOptions={mock?:boolean;sharedQueue?:boolean;model?:string;effort?:string;mode?:'Chat'|'Work';restore?:Record<string,any>;mockRpc?:ReturnType<typeof mockClient>;onReady?:(control:TuiControl)=>void;onCheckpoint?:(state:Record<string,any>)=>void;restoreFromDisk?:boolean};

/** Full-screen, keyboard-first website client. Mock mode never creates a browser or daemon. */
export async function runTui(accountId?:string,options:TuiOptions={}){
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('The ChatGPT workspace needs an interactive terminal. Use chatgpt help for scriptable commands.');
 let a:Account=options.mock?{id:'demo',label:'Demo workspace',baseURL:'https://chatgpt.com',created:''}:account(accountId);
 const mock=options.mockRpc||mockClient(),viewAbort=new AbortController();const rpc=(op:string,args:any={},event?:(e:any)=>void)=>{const emit=(value:any)=>{if(!viewAbort.signal.aborted)event?.(value);};return options.mock?mock(op,args,emit,viewAbort.signal):call(a,op,args,emit,viewAbort.signal);};
 let collection:'conversations'|'projects'|'gpts'='conversations',nav:any[]=[],selected=0,query='',focus:'nav'|'chat'|'compose'|'inspect'='compose';
 let conversation:string|undefined,project:string|undefined,gpt:string|undefined,heading='A place to think',messages:Message[]=[],draft='',cursor=0,scroll=0;
 let frozen=false;let composedNotice='';
 let model='',effort='',mode='',busy=false,cancelRequested=false,loading=false,status='Connecting…',error='',coverage='Index not loaded',inspector=false,inspection:any=null,control=0;
 let recoveryTimer:ReturnType<typeof setTimeout>|undefined,recoveryAttempt=0,recoveryActive=false,websiteActive=false,activityLabel='';
 let attachments:string[]=[],downloads:Record<string,string>={};
 const localQueue=new LocalQueue(),composerNavigation=new ComposerNavigation();const sharedEnabled=!options.mock||options.sharedQueue===true;let shared=new SharedQueue(rpc,a),sharedTimer:ReturnType<typeof setInterval>|undefined,sharedSyncs=0,queueView=false,sharedRunActive=false;let activeSendRequestId:string|undefined;let sendPhase='responding';
 const sharedPending=()=>sharedEnabled&&shared.state.items.some((item:any)=>item.phase!=='complete');
 const queueContext=()=>({conversation,new:!conversation,project:conversation?undefined:project,gpt:conversation?undefined:gpt,mode:!conversation?(mode||undefined):undefined,model:model||undefined,effort:effort||undefined});
 let showThinking=true,thinkingActive=false,generationStarted=0;let animationTimer:ReturnType<typeof setInterval>|undefined;
 let viewport:BrowserViewport|null=null;let navProject:string|undefined;let monitoring=false;let monitorTimer:ReturnType<typeof setTimeout>|undefined;
 let palette:Choice[]|null=null,paletteQuery='',paletteIndex=0,prompt:{label:string;value:string;submit:(s:string)=>Promise<void>}|null=null,ended=false,loadVersion=0;
 let freezeTimer:ReturnType<typeof setInterval>|undefined;
 let slashIndex=0,slashHidden=false,slashRunning=false;let allCommands:Choice[]=[],paletteRoot=false,paletteTitle='COMMANDS';
 let reloadPending=false,activeActions=0,reloadState:Record<string,any>|undefined;let reloadTimer:ReturnType<typeof setInterval>|undefined;let checkpointTimer:ReturnType<typeof setTimeout>|undefined;
 const selection=new WebsiteSelection(rpc,()=>({conversation,project,gpt,new:!conversation}),()=>busy||websiteActive||sharedEnabled&&(shared.pending||shared.state.running));
 const decoder=new InputDecoder();let escapeTimer:ReturnType<typeof setTimeout>;
 const view=()=>({w:Math.max(30,process.stdout.columns||80),h:Math.max(10,process.stdout.rows||24)});
 const filtered=()=>nav.filter(x=>title(x).toLowerCase().includes(query.toLowerCase()));
 const choices=()=>(paletteRoot&&paletteQuery?allCommands:palette)?.filter(x=>x.label.toLowerCase().includes(paletteQuery.toLowerCase()))||[];
 const fail=(e:any)=>{if(ended)return;if(recoverableConnectionError(e))scheduleRecovery();error=clean((e?.code?'['+e.code+'] ':'')+(e?.message||e));status='Action needs attention';messages.push({role:'system',text:'# '+(e?.code||'Action needs attention')+'\n\n'+clean(e?.message||e)+(e?.action?'\n\n**Recovery**\n'+clean(e.action):'')+(e?.retryAfterMs?'\n\nRetry after '+Math.ceil(e.retryAfterMs/1000)+' seconds.':'')});scroll=0;render();};
 async function action(fn:()=>Promise<any>){error='';activeActions++;try{return await fn();}catch(e){fail(e);}finally{activeActions--;}}
 function md(line:string){if(/^#{1,6} /.test(line))return paint(line.replace(/^#+ /,''),'bold');if(/^```/.test(line))return paint(line,'dim');if(/^>/.test(line))return paint(line,'dim');return line.replace(/\*\*(.*?)\*\*/g,(_,s)=>paint(s,'bold'));}
 function render(){if(ended||viewport)return;for(const message of messages)if(!message.timestamp)Object.assign(message,messageTime(message));if(options.onCheckpoint&&!checkpointTimer)checkpointTimer=setTimeout(()=>{checkpointTimer=undefined;options.onCheckpoint?.(snapshotState());},750);const {w,h}=view(),wide=w>=112,navW=w>=80?Math.min(30,Math.floor(w*.24)):0,sideW=inspector&&wide?Math.min(32,Math.floor(w*.25)):0;
 const composerH=Math.max(2,Math.min(6,Math.max(2,h-8),composerPositions(draft,w-4).at(-1)!.row+1)),bodyH=Math.max(2,h-6-composerH),chatW=w-navW-sideW-(navW?1:0)-(sideW?1:0),all:string[]=[];
 const header=pad(' ◈ CHATGPT'+(options.mock?'  /  DEMO':''),Math.min(24,w));all.push(paint(clip(header+(frozen?'  ❄ FROZEN':'')+'  '+a.label+' · '+a.id+'  |  '+(mode?mode+' · ':'')+(model||'Website model')+(effort?' · '+effort:''),w),'bold'));
 all.push(paint(clip(' '+(project?'PROJECT '+project:gpt?'GPT '+gpt:'WORKSPACE')+'  /  '+(queueView?'Shared queue responses · Esc returns':heading)+'  '+(!queueView&&conversation?'· '+conversation:''),w),'blue'));
 all.push(paint('─'.repeat(w),'dim'));
 const displayMessages=queueView?sharedQueueTranscript(shared.state,shared.details):messages;const transcript:string[]=[];if(!displayMessages.length){transcript.push('','  What would you like to work on?','','  Continue a conversation or start with a thought.','','  /help   slash commands · Tab completes · Enter runs','  Tab     change pane  Ctrl+N  new conversation','','  Enter sends · Ctrl+J adds a line','  Paste keeps multiple lines together.');}else for(const m of displayMessages){if(m.thinking?.length){for(const line of thinkingLines(m.thinking,showThinking))for(const wrapped of wrap(line,chatW-4))transcript.push(paint(' '+wrapped,'dim'));transcript.push('');}for(const line of wrap((m.role==='user'?'YOU'+(m.delivery?' · '+m.delivery.toUpperCase():''):m.role==='draft'?'LOCAL DRAFT · UNCONFIRMED':m.role==='system'?'WORKSPACE':'CHATGPT')+' · '+messageTimeLabel(m),chatW-2))transcript.push(paint(' '+line,'blue'));for(const file of m.files||[])for(const line of wrap('Attached · '+file,chatW-4))transcript.push(paint(' '+line,'dim'));for(const line of wrap(m.text,chatW-4))transcript.push(' '+md(line));for(const item of m.media||[]){const ref=mediaReference(item);for(const line of wrap('Media · '+(item.alt||item.kind||item.tag||'attachment')+' · '+(downloads[ref]||ref||'inspect website')+` · ${shortcutModifier}+R actions`,chatW-4))transcript.push(paint(' '+line,'blue'));}transcript.push('');}
 const start=Math.max(0,transcript.length-bodyH-scroll),visible=transcript.slice(start,start+bodyH);
 const ns=filtered(),navStart=Math.max(0,selected-bodyH+4);
 const listW=navW||w;
 const navLines=[paint(clip(' '+(focus==='nav'?'▸ ':'')+(navProject?'PROJECT CHATS':collection.toUpperCase()),listW),'blue'),paint(clip(' / '+(query||'search · Ctrl+F'),listW),'dim'),...ns.slice(navStart).map((x,i)=>{const s=pad(' '+(i+navStart===selected?'› ':'  ')+title(x),listW);return i+navStart===selected?paint(s,'blue'):s;})];
 const controls=inspection?.controls||[];const side=[paint(' CONTEXT','blue'),' '+(model||'Website model'),' '+(effort||'Website effort'),' '+(busy?'● Generating':'○ Ready'),'',paint(' BROWSER CONTROLS','blue'),...controls.slice(Math.max(0,control-bodyH+9)).map((c:any,i:number)=>(i+Math.max(0,control-bodyH+9)===control?' › ':'   ')+(c.name||c.role||c.ref))];
 for(let i=0;i<bodyH;i++){if(w<80&&focus==='nav')all.push(fit(navLines[i]||'',w));else if(inspector&&!wide&&focus==='inspect')all.push(fit(side[i]||'',w));else all.push((navW?fit(navLines[i]||'',navW)+paint('│','dim'):'')+fit(visible[i]||'',chatW)+(sideW?paint('│','dim')+fit(side[i]||'',sideW):''));}
 all.push(paint('─'.repeat(w),'dim'));
 const composer= composerViewport(draft,cursor,w-4,composerH);for(let row=0;row<composerH;row++)all.push((row===0?paint(' '+(focus==='compose'?'›':'·')+' ','blue'):'   ')+clip(composer.rows[row]||(!draft&&row===0?((busy||websiteActive)?'Queue a message locally…':'Message ChatGPT…'):''),w-4));
 all.push(paint(clip(' '+(error?'! '+error:(busy||websiteActive)?generationIndicator(generationStarted,Date.now(),thinkingActive,sendPhase,activityLabel):status)+(attachments.length?' · '+attachments.length+' attached (pending)':'')+(localQueue.items.length?' · '+localQueue.items.length+(sharedEnabled?' pending outbox':' local queued')+(localQueue.paused?' (paused)':''):'')+(sharedEnabled?' · '+sharedQueueSummary(shared.state):'')+(reloadPending?' · update pending':'')+(composedNotice?' · '+composedNotice:'')+'  ·  '+coverage,w),error?'amber':(busy||websiteActive)?'green':'dim'));
 all.push(paint(clip(` /help  /model  /effort  /queue  /attach  /media  · ${shortcutModifier}+M model  ${shortcutModifier}+E effort  ${shortcutModifier}+T thinking  ${shortcutModifier}+Q queue  ${shortcutModifier}+A attach  ${shortcutModifier}+R media  ^K commands  ^Q quit`,w),'dim'));
 if(focus==='compose'&&draft.startsWith('/')&&!draft.startsWith('//')&&!palette&&!prompt&&!slashHidden){const suggestions=slashSuggestions(),count=Math.min(5,bodyH,suggestions.length),offset=Math.max(0,slashIndex-count+1);for(let row=0;row<count;row++)all[3+bodyH-count+row]=paint(clip(' '+(row+offset===slashIndex?'› ':'  ')+suggestions[row+offset]+'  · Tab complete · Enter run',w),'blue');}
 if(palette||prompt){const list=choices(),boxW=Math.min(76,w-4),box:string[]=[paint(' '+(prompt?.label||paletteTitle),'blue'), ' '+(prompt?.value??paletteQuery)+'▏',paint('─'.repeat(boxW),'dim')];if(palette){const count=Math.max(1,Math.min(8,h-7)),offset=Math.max(0,paletteIndex-count+1);for(let i=offset;i<Math.min(list.length,offset+count);i++)box.push((i===paletteIndex?paint(' › '+list[i].label,'blue'):'   '+list[i].label));if(!list.length)box.push(' No matching commands.');}box.push(paint(palette?' '+list.length+' choices · Enter select · Esc '+(paletteRoot?'close':'back'):' Enter submit · Esc close','dim'));const top=Math.max(1,Math.floor((h-box.length)/2)),left=Math.floor((w-boxW)/2);for(let i=0;i<box.length&&top+i<all.length;i++)all[top+i]=' '.repeat(left)+fit(box[i],boxW)+' '.repeat(w-left-boxW);}
 process.stdout.write(esc+'H'+all.slice(0,h).map(x=>x+esc+'K').join('\r\n')+esc+'J'+(focus==='compose'&&!palette&&!prompt?esc+'?25h'+esc+(bodyH+5+composer.cursor.row)+';'+(4+composer.cursor.column)+'H':esc+'?25l'));
 }
 function fit(s:string,n:number){const plain=clean(s);return width(plain)>n?clip(plain,n):s+' '.repeat(Math.max(0,n-width(plain)));}
 async function load(force=false){const version=++loadVersion;loading=true;status='Loading '+collection+'…';render();await action(async()=>{if(!force&&!navProject&&collection==='conversations'&&!options.mock){const cached=await rpc('conversations.cached');if(version!==loadVersion)return;if(rows(cached).length){nav=recentFirst(rows(cached));selected=0;coverage='Cached index · '+nav.length;status='Ready · Refresh current list to update';return;}}const r=await rpc(navProject?'projects.chats':collection+'.list',navProject?{id:navProject}:collection==='conversations'?{archived:'all'}:{});if(version!==loadVersion)return;nav=collection==='conversations'?recentFirst(rows(r)):rows(r);selected=0;coverage=r.complete===true?'Complete · '+nav.length:r.complete===false?'Partial index · '+nav.length:nav.length+' entries · coverage unknown';status='Ready';});loading=false;render();}
 async function open(){if(localQueue.items.length){status='Send or remove locally queued messages before changing conversation';return;}if(selection.pending){status='Wait for the model or effort operation before changing conversation';return;}if(busy||websiteActive){status='Stop generation before changing conversation';return;}const item=filtered()[selected];if(!item)return;if(collection!=='conversations'){composerNavigation.reset();model='';effort='';mode='';project=collection==='projects'?id(item):undefined;gpt=collection==='gpts'?id(item):undefined;conversation=undefined;messages=[];heading=title(item);if(collection==='projects'){navProject=project;collection='conversations';query='';focus='nav';await load();status='Project conversations · Ctrl+N starts a new chat here · Esc goes back';}else{focus='compose';status='GPT selected for next message';}return;}
 const version=++loadVersion;status='Opening conversation…';render();await action(async()=>{const result=await rpc('conversations.path',{id:id(item),cached:true});if(version!==loadVersion)return;if(conversation!==id(item)||project!==navProject||gpt){model='';effort='';mode='';}composerNavigation.reset();conversation=id(item);heading=title(item);project=navProject;gpt=undefined;messages=rows(result).filter((m:any)=>['user','assistant','tool'].includes(m.author?.role||m.role)).map((m:any)=>({...messageTime(m),id:m.id||m.message_id,role:m.author?.role||m.role,text:typeof m.content==='string'?m.content:(m.content?.parts||[m.text||'']).map((p:any)=>typeof p==='string'?p:JSON.stringify(p)).join('\n')}));scroll=0;focus='compose';status='Ready';});}
 function fresh(){if(localQueue.items.length){status='Send or remove locally queued messages before starting a conversation';return;}if(selection.pending){status='Wait for the model or effort operation before starting a conversation';return;}if(busy||websiteActive){status='Stop generation before starting a new conversation';return;}++loadVersion;composerNavigation.reset();conversation=undefined;websiteActive=false;model='';effort='';mode='';messages=[];heading='New conversation';draft='';attachments=[];cursor=0;scroll=0;focus='compose';error='';}
 async function send(queued?:QueuedDraft){if(selection.pending){status='Wait for the model or effort operation before sending';render();return;}if(!queued&&!draft.trim()&&!attachments.length)return;if(uncertainDuplicate(messages,queued?.text??draft,queued?.files??attachments)){if(queued)localQueue.items.unshift(queued);localQueue.paused=true;error='';status='Identical submission is unconfirmed · reconcile with website before retrying';render();return;}if(busy||websiteActive||sharedEnabled&&(!shared.loaded||shared.pending||shared.state.running||sharedPending())||(!queued&&localQueue.items.length)){if(queued)return;if(websiteActive)localQueue.paused=true;try{const item=localQueue.add(draft,attachments,sharedEnabled?queueContext():undefined);if(sharedEnabled&&!conversation&&(busy||websiteActive)){item.awaitingConversation=true;if(activeSendRequestId)item.parentRequestId=activeSendRequestId;}}catch(error){fail(error);return;}composerNavigation.reset();draft='';attachments=[];cursor=0;status='Queued locally · not submitted to website';render();if(sharedEnabled){localQueue.paused=true;options.onCheckpoint?.(snapshotState());void syncSharedQueue();}return;}composerNavigation.reset();const text=queued?.text??draft,files=[...(queued?.files??attachments)];if(!queued){draft='';attachments=[];cursor=0;}let completed=false,notSubmitted=false;busy=true;activeSendRequestId=undefined;sendPhase='submitting';thinkingActive=false;generationStarted=Date.now();animationTimer=setInterval(render,100);cancelRequested=false;error='';scroll=0;const sent:Message={...localMessageTime(),role:'user',text,files,delivery:'submitting'};messages.push(sent);const reply:Message={...localMessageTime(),role:'assistant',text:''};messages.push(reply);render();try{const r=await rpc('chat.send',{text,files,new:!conversation,conversation,project,gpt,mode:!conversation?(mode||undefined):undefined,model:model||undefined,effort:effort||undefined},event=>{if(event.type==='operation.receipt'){sent.requestId=event.requestId;activeSendRequestId=event.requestId;for(const item of localQueue.items)if(item.awaitingConversation&&!item.parentRequestId)item.parentRequestId=event.requestId;if(sharedEnabled&&localQueue.items.length)checkpointOutbox();}if(event.type==='submission.failed'&&event.submissionState==='not-submitted')notSubmitted=true;if(event.type==='submitted'){if(!conversation&&event.verified===true){const observed=String(event.url||'').match(/^https:\/\/chatgpt\.com\/c\/([A-Za-z0-9_-]+)(?:[/?#]|$)/)?.[1];if(observed){conversation=observed;bindQueuedConversation(localQueue.items,observed);if(sharedEnabled)checkpointOutbox();}}sendPhase='submitted';sent.delivery='submitted';sent.id=event.messages?.at(-1)?.id;Object.assign(sent,messageTime(event.messages?.at(-1),sent));}if(event.type==='mode.fallback'){messages.push({role:'system',text:'Mode fallback · '+clean(event.reason||'Work unavailable')+(event.verified===true?' · website verified '+clean(event.to||'Chat'):' · awaiting website verification')});if(event.verified===true){mode=event.to||'Chat';model=event.model||'';effort=event.effort||'';}}if(event.type==='thinking'){reply.thinking=mergeThinking(reply.thinking||[],event);thinkingActive=event.active!==false;}if(event.type==='text'){thinkingActive=false;sendPhase='responding';reply.text+=clean(event.text);}if(event.type==='replace'){thinkingActive=false;sendPhase='responding';reply.text=clean(event.text);}if(event.type==='media'){reply.media=event.items||[];inspection={...inspection,media:event.items};status=(event.items?.length||0)+' media items · inspect browser';}render();});if(ended)return;completed=true;sent.delivery='answered';if(r?.text)reply.text=clean(r.text);const received=r?.messages?.filter((message:any)=>(message.role||message.author?.role)==='assistant').at(-1)||r?.message;reply.id=r?.messageId||received?.id;Object.assign(reply,messageTime(received,reply));conversation=r?.conversation||conversation;if(conversation)bindQueuedConversation(localQueue.items,conversation);if(conversation&&collection==='conversations'){const existing=nav.find(item=>id(item)===conversation);nav=recentFirst([{...existing,id:conversation,title:existing?title(existing):text.slice(0,70)||'Attachments',update_time:Date.now()/1000},...nav.filter(item=>id(item)!==conversation)]);}if(heading==='New conversation'||heading==='A place to think')heading=text.slice(0,70);status=cancelRequested?'Response stopped · partial text retained':'Response complete';}catch(e){if(ended)return;
  if(notSubmitted||(e as any)?.submissionState==='not-submitted'||(e as any)?.code==='NOT_SUBMITTED'){
   messages=messages.filter(message=>message!==sent&&message!==reply);
   if(!draft&&!attachments.length){draft=text;attachments=files;cursor=graphemes(draft).length;}
   else if(draft!==text||JSON.stringify(attachments)!==JSON.stringify(files)){const restored=queued||{id:crypto.randomUUID(),text,files};localQueue.items.unshift(restored);}
   fail(e);status='Not submitted · original draft retained';error='Not submitted · draft retained · '+clean((e as any)?.message||e);
  }else{sent.delivery='unconfirmed';sent.requestId=(e as any)?.requestId||sent.requestId;if(!reply.text)reply.text='Submission or response is unconfirmed. Reconcile the current conversation with the website before sending this message again.';fail(e);}
 }finally{busy=false;thinkingActive=false;clearInterval(animationTimer);animationTimer=undefined;if(!completed||cancelRequested)localQueue.paused=true;render();if(completed&&!cancelRequested&&!reloadPending)void drainQueue();}}
 async function drainQueue(){if(sharedEnabled){await syncSharedQueue();return;}if(ended||busy||websiteActive||selection.pending||reloadPending)return;const next=localQueue.next();if(next)await send(next);}
 function checkpointOutbox(){const state=snapshotState();if(!options.mock)saveTuiSession(a.id,state);options.onCheckpoint?.(state);}
 async function syncSharedQueue(pause=false){
  if(!sharedEnabled||ended||sharedSyncs&&!pause)return;activeActions++;sharedSyncs++;
  if(shared.pending){try{if(pause)await shared.mutate('pause');else await shared.refresh();}catch(e){if(!ended)status='Shared queue read failed · '+clean((e as any)?.message||e);}finally{activeActions--;sharedSyncs--;render();}return;}
  try{
   if(pause)await shared.mutate('pause');
   if(localQueue.items.length){
    if(!busy){for(const requestId of new Set(localQueue.items.filter(item=>item.awaitingConversation&&item.parentRequestId).map(item=>item.parentRequestId!))){const evidence=await rpc('receipts.get',{id:requestId});const resolved=completedParentConversation(evidence,a,requestId);if(resolved){bindQueuedConversation(localQueue.items.filter(item=>item.parentRequestId===requestId),resolved);for(const message of messages)if(message.requestId===requestId&&['user','draft'].includes(message.role)){message.role='user';message.delivery='answered';}if(!conversation){conversation=resolved;websiteActive=false;clearInterval(animationTimer);animationTimer=undefined;}scheduleRecovery();}}}
    localQueue.paused=true;for(const item of localQueue.items)item.context??=queueContext();
    checkpointOutbox();
    const ready=localQueue.items.filter(item=>!item.awaitingConversation);
    if(ready.length)await shared.migrate(ready.map(item=>({...item,files:[...(item.files||[])]})),id=>{if(ended)return;localQueue.remove(id);checkpointOutbox();});
    if(!ended)status=localQueue.items.some(item=>item.awaitingConversation)?'Follow-up retained locally · waiting for a verified conversation ID':'Saved to shared queue · paused · not submitted';
   }else await shared.refresh();
  }catch(e){if(!ended)status='Shared queue unavailable · outbox retained · '+clean((e as any)?.message||e);}
  finally{activeActions--;sharedSyncs--;render();}
 }
 async function runSharedQueue(){
  if(busy||websiteActive)throw new Error('Stop or wait for the active website response before running the shared queue.');
  if(localQueue.items.length)throw new Error('Publish the pending local outbox before running the shared queue.');
  busy=true;sharedRunActive=true;queueView=true;focus='chat';scroll=0;generationStarted=Date.now();animationTimer=setInterval(render,100);sendPhase='submitting';activityLabel='Shared queue running';
  try{const result=await shared.run(event=>{if(ended)return;status='Shared queue · '+event.type+' · '+(event.id||'');if(event.type==='queue.event')sendPhase=event.event?.type==='submitted'?'submitted':'responding';render();},state=>{if(conversation&&messages.some(message=>['unconfirmed','submitting'].includes(message.delivery||''))&&state.items.some((item:any)=>item.phase==='queued'&&item.draft.conversation===conversation))throw new Error('Reconcile the uncertain current-conversation send before running its dependent queued follow-ups.');});if(ended)return;status='Shared queue · '+(result.completedThisRun||0)+' completed · '+(result.paused?'paused':'idle');const last=result.items.filter((item:any)=>item.phase==='complete').at(-1);if(conversation&&last?.draft.conversation===conversation)scheduleRecovery();}
  finally{busy=false;sharedRunActive=false;activityLabel='';clearInterval(animationTimer);animationTimer=undefined;render();}
 }
 async function queueMenu(){
  if(!sharedEnabled)return legacyQueueMenu();
  await syncSharedQueue(true);
  const items=shared.state.items;
  menu([
   {label:'Refresh shared queue · same store as CLI',run:()=>queueMenu()},
   {label:'View shared queue responses · live text, thinking and media',run:()=>{queueView=true;focus='chat';scroll=0;render();}},
   {label:'Return to current conversation',run:()=>{queueView=false;render();}},
   {label:'Pause shared queue · current response continues',run:async()=>{await shared.mutate('pause');await queueMenu();}},
   {label:'Run shared account queue · explicit send in order',run:runSharedQueue},
   ...(localQueue.items.length?[{label:'Publish '+localQueue.items.length+' pending outbox drafts · never send',run:()=>queueMenu()},...localQueue.items.map(item=>({label:'OUTBOX · '+(item.text||'Attachments').slice(0,40),run:()=>menu([{label:'Inspect retained outbox draft',run:()=>report('Retained outbox draft',item)},...(item.awaitingConversation?[{label:'Assign an explicit conversation ID · remains paused',run:()=>ask('Destination conversation ID for this unsent follow-up',async target=>{bindQueuedConversation([item],target.trim());checkpointOutbox();await queueMenu();})}]:[]),...(item.awaitingConversation&&conversation?[{label:'Assign follow-up to current conversation · '+conversation,run:async()=>{bindQueuedConversation([item],conversation!);checkpointOutbox();await queueMenu();}}]:[]),{label:'Discard this local outbox copy',run:async()=>{localQueue.remove(item.id);options.onCheckpoint?.(snapshotState());await queueMenu();}}],'LOCAL OUTBOX · publication unconfirmed')}))]:[]),
   ...items.map((item:any,index:number)=>({label:item.phase.toUpperCase()+' · '+queueContextLabel(item.draft)+' · '+(item.draft.text||'Attachments').replace(/\s+/g,' ').slice(0,42),run:()=>{
    const permissions=queuePermissions(item.phase),target=item.websiteConversation||item.result?.conversation;
    menu([
     {label:'Receipt / request '+item.requestId,run:()=>report('Shared queue item',item)},
     ...(item.phase==='complete'&&target?[{label:'Open completed result conversation · '+target,run:async()=>{if(busy||websiteActive||shared.state.running)throw new Error('Wait for the queue runner before opening another conversation.');await rpc('conversations.open',{conversation:target});conversation=target;project=undefined;gpt=undefined;composerNavigation.reset();heading=item.draft.text?.slice(0,70)||'Queue result';messages=[];queueView=false;model='';effort='';mode='';await reconcileCurrent();}}]:[]),
     ...(permissions.edit?[{label:'Edit unsent shared draft',run:()=>{ask('Edit shared queued draft',async text=>{await shared.mutate('edit',{id:item.id,text});await queueMenu();});if(prompt)prompt.value=item.draft.text;}}]:[]),
     ...(permissions.remove?[{label:'Remove shared item',run:async()=>{await shared.mutate('remove',{id:item.id});await queueMenu();}}]:[]),
     ...(permissions.reorder?[{label:'Move earlier in shared account queue',run:async()=>{await shared.mutate('reorder',{id:item.id,index:Math.max(0,index-1)});await queueMenu();}},{label:'Move later in shared account queue',run:async()=>{await shared.mutate('reorder',{id:item.id,index:Math.min(items.length-1,index+1)});await queueMenu();}}]:[]),
     ...(permissions.retry?[{label:'Retry proven non-submission · new request ID · remains paused',run:async()=>{await shared.mutate('retry',{id:item.id});await queueMenu();}}]:[]),
     ...(permissions.reconcile?[{label:'Reconcile matching durable receipt · never resend',run:async()=>{await shared.mutate('reconcile',{id:item.id});await queueMenu();}}]:[]),
    ],'SHARED ITEM · '+item.phase.toUpperCase());
   }})),
  ],'SHARED CLI / TUI QUEUE · '+(shared.state.paused?'PAUSED':'RUNNING'));
  status='Durable shared queue · phases reflect submission evidence · native website steering unverified';render();
 }
 function legacyQueueMenu(){
  localQueue.paused=true;
  menu([{label:'Resume local queue · send in order',run:()=>{localQueue.paused=false;status='Local queue resumed';void drainQueue();}},...localQueue.items.map((item,index)=>({label:(index+1)+'. '+(item.text||'Attachments').replace(/\s+/g,' ').slice(0,55)+(item.files?.length?' · '+item.files.length+' files':''),run:()=>menu([
   {label:'Edit queued message',run:()=>{ask('Edit local draft · not submitted',async text=>{localQueue.edit(item.id,text);queueMenu();});if(prompt)prompt.value=item.text;}},
   {label:'Remove queued message',run:()=>{localQueue.remove(item.id);queueMenu();}},
   {label:'Move earlier',run:()=>{localQueue.move(item.id,-1);queueMenu();}},
   {label:'Move later',run:()=>{localQueue.move(item.id,1);queueMenu();}},
  ],'LOCAL QUEUED MESSAGE')}))],'LOCAL QUEUE · paused for editing');
  status='Local drafts only · resume sends in order';
 }
 function attachFile(){ask('Attach local image, audio or document · file path',async value=>{const path=await attachmentPath(value);if(!attachments.includes(path))attachments.push(path);status='Attached locally · uploaded with your next message';});}
 function attachmentMenu(){menu([{label:'Attach another local file',run:attachFile},...attachments.map(path=>({label:'Remove · '+path,run:()=>{attachments=attachments.filter(value=>value!==path);attachmentMenu();}}))],'PENDING ATTACHMENTS');}
 async function previewFile(path:string){const file=await attachmentPath(path),binary=Bun.which(process.platform==='darwin'?'open':'xdg-open');if(!binary)throw new Error('No local file viewer launcher is installed. Saved file: '+file);Bun.spawn([binary,file],{stdin:'ignore',stdout:'ignore',stderr:'ignore'}).unref();status='Opened local file · '+file;}
 function receivedMedia(){
  const values=[...(queueView?sharedQueueTranscript(shared.state,shared.details):messages).flatMap(message=>message.media||[]),...(inspection?.media||[])],unique=[...new Map(values.map(item=>[mediaReference(item),item])).values()];
  if(!unique.length)throw new Error('No media has been reported in this conversation. Inspect the browser or browse the media library.');
  menu(unique.map(item=>{const reference=mediaReference(item);return {label:(item.alt||item.name||item.kind||item.tag||'Media')+' · '+(downloads[reference]?'downloaded':reference||'website only'),run:()=>menu([
   {label:'Show observed media details',run:()=>report('Website media',{...item,localPath:downloads[reference]})},
   ...(reference?[{label:'Download to a local file',run:()=>ask('Save media to absolute file path',async output=>{const result=await rpc('media.download',{id:reference,output});if(!result?.path)throw new Error('Download did not return a saved file.');downloads[reference]=result.path;report('Media downloaded',result.path);})}]:[]),
   ...(downloads[reference]?[{label:'Open downloaded file in local viewer',run:()=>previewFile(downloads[reference])}]:[]),
  ],'MEDIA ACTIONS')};}),'RECEIVED MEDIA');
 }
 function scheduleRecovery(){
  if(ended||!conversation||recoveryTimer||recoveryAttempt>=8)return;
  localQueue.paused=true;
  recoveryTimer=setTimeout(()=>{recoveryTimer=undefined;void recoverReadOnly();},Math.min(30000,1000*2**recoveryAttempt));
 }
 async function recoverReadOnly(){
  if(ended||!conversation)return;
  if(busy||loading||activeActions||selection.pending||viewport||recoveryActive){scheduleRecovery();return;}
  recoveryAttempt++;recoveryActive=true;activeActions++;
  try{const result=await reconcileCurrent(true);if(result){recoveryAttempt=0;if(result.active){recoveryAttempt=1;scheduleRecovery();}}}
  catch(e){if(!ended){status='Read-only recovery pending · '+clean((e as any)?.message||e)+' · Ctrl+K to reconcile';render();scheduleRecovery();}}
  finally{activeActions--;recoveryActive=false;}
 }
 async function reconcileCurrent(background=false){
  if(busy)throw new Error('Wait for this response to finish or stop it before replacing the local transcript.');
  const expected=conversation,accountId=a.id,version=loadVersion;
  if(!background){status='Reading current website conversation…';render();}
  const result=await rpc('chat.reconcile',{conversation:expected});
  if(ended||busy||expected!==conversation||accountId!==a.id||version!==loadVersion)return;
  if(result.verified!==true||!Array.isArray(result.messages)||expected&&result.conversation!==expected)throw new Error('Website reconciliation did not return the requested conversation. Local drafts were preserved.');
  const wasWebsiteActive=websiteActive;websiteActive=result.active===true;
  if(websiteActive){if(!wasWebsiteActive)cancelRequested=false;if(!animationTimer){generationStarted=generationStarted||Date.now();animationTimer=setInterval(render,100);}sendPhase='responding';activityLabel=currentThinkingLabel(result.thinking||[]);thinkingActive=/thinking/i.test(activityLabel);}
  else if(!busy){clearInterval(animationTimer);animationTimer=undefined;thinkingActive=false;activityLabel='';}
  messages=reconcileMessages(messages,result.messages) as Message[];
  if(Array.isArray(result.thinking)&&result.thinking.length){const reply=messages.findLast(message=>message.role==='assistant');if(reply)reply.thinking=result.thinking;}
  conversation=result.conversation||conversation;heading=result.title||heading;inspection={...inspection,media:result.media||[],thinking:result.thinking||[]};localQueue.paused=true;error='';
  if(result.historyCoverage)coverage='Partial observed history · '+(result.historyCoverage.retainedPrefix||0)+' earlier messages restored';
  status=result.active?'Website reconciled · a response is active · local queue paused':'Website reconciled · '+messages.filter(message=>message.role==='draft').length+' unresolved local drafts · local queue paused';render();if(!background&&websiteActive)scheduleRecovery();return result;
 }
 async function snapshot(){await action(async()=>{inspection=await rpc('ui.snapshot');control=0;inspector=true;focus='inspect';status='Browser snapshot · '+(inspection.controls?.length||0)+' controls';});}
 function ask(label:string,submit:(s:string)=>Promise<void>){prompt={label,value:'',submit};}
 function report(label:string,value:any){messages.push({role:'system',text:'# '+label+'\n\n'+(typeof value==='string'?value:JSON.stringify(value,null,2))});focus='chat';scroll=0;status=label;}
 function menu(items:Choice[],label='CHOOSE'){palette=items;paletteRoot=false;paletteTitle=label;paletteQuery='';paletteIndex=0;}
 async function applyMode(value:'Chat'|'Work'){status='Switching to '+value+'…';render();const result=await selection.mode(value);mode=result.mode;model='';effort='';status='Website verified '+mode+' mode';render();}
 async function applySetting(kind:'model'|'effort',label:string){
  status='Applying '+kind+' · '+label+'…';render();
  const result=await selection.change(kind,label);
  if(kind==='model')model=result.label;else effort=result.label;
  status='Website verified '+kind+' · '+result.label;render();
 }
 async function selectSetting(kind:'model'|'effort'){
  status='Reading website '+kind+' options…';render();
  const result=await selection.options();
  const values=kind==='model'?result.models:result.efforts;
  if(!Array.isArray(values)||!values.length)throw new Error('No '+kind+' options were observed in this website context. Inspect the browser and retry.');
  menu([...(kind==='model'&&Array.isArray(result.modes)?result.modes.filter((value:string)=>value!==result.mode).map((value:'Chat'|'Work')=>({label:'Switch to '+value+' models',run:async()=>{await applyMode(value);await selectSetting('model');}})):[]),...values.map((value:any)=>{const label=typeof value==='string'?value:value.label;return {label:label+(value?.selected?' · current':''),run:()=>applySetting(kind,label)};})],kind==='model'?'MODEL · applies immediately':'THINKING EFFORT · applies immediately');
 }
 async function monitor(){if(!monitoring||ended)return;try{const r=await rpc('monitor.events',{limit:6});inspection={...inspection,events:r.items};const last=r.items?.at(-1);if(last)status='Monitor · '+last.type+' · '+(last.operation||'');render();}catch(e){fail(e);}finally{if(monitoring&&!ended)monitorTimer=setTimeout(()=>void monitor(),3000);}}
 async function task(op:string,args:any,label:string){status=label+'…';render();const result=await rpc(op,args,event=>{status=label+' · '+(event.type||event.phase||'working')+(event.count?' · '+event.count:'');render();});report(label,result);}
 async function messageAction(op:string,message:Message,text?:string){
  if(busy||!conversation||!message.id)throw new Error('Open a saved message and stop generation before changing a branch.');
  await rpc('conversations.open',{id:conversation});const state=await rpc('ui.snapshot');
  if(!state.url?.split('?')[0].endsWith('/c/'+conversation)||![...(state.messages||[]),...(state.controls||[])].some((x:any)=>(x.id===message.id||x.messageId===message.id)))throw new Error('The selected message is not verified in the website. Refresh its transcript and inspect the browser before retrying.');
  await task(op,{message:message.id,...(text!==undefined?{text}:{})},op==='chat.edit'?'Edited message':op==='chat.branch'?'New branch':'Regenerated response');
 }
 function selectMessage(){const saved=messages.filter(m=>m.id&&['user','assistant'].includes(m.role));if(!saved.length)throw new Error('No saved message IDs are available. Open a conversation from the library first.');menu(saved.map(m=>({label:(m.role==='user'?'You':'ChatGPT')+' · '+m.text.replace(/\s+/g,' ').slice(0,60),run:()=>menu([{label:'View message',run:()=>report('Selected message',m)},...(m.role==='user'?[{label:'Edit and send as a new branch',run:()=>ask('Replacement message · Enter submits edit',async text=>messageAction('chat.edit',m,text))}]:[{label:'Regenerate this response',run:()=>messageAction('chat.regenerate',m)}]),{label:'Branch into a new conversation',run:()=>messageAction('chat.branch',m)}],'MESSAGE ACTIONS')})),'SAVED MESSAGES');}
 function operations():Choice[]{return [
  {label:'Saved message · view, edit, branch or regenerate',run:selectMessage},
  {label:'Invoices · watcher status',run:()=>task('invoices.watcher',{},'Invoice watcher')},
  {label:'Invoices · start watching',run:()=>task('invoices.watch',{},'Watch invoices')},
  {label:'Invoices · stop watching',run:()=>task('invoices.unwatch',{},'Stop invoice watcher')},
  {label:'Takeout · status',run:()=>task('takeout.status',{},'Archive status')},
  {label:'Takeout · pause reads',run:()=>task('takeout.pause',{},'Archive paused')},
  {label:'Takeout · resume reads',run:()=>task('takeout.resume',{},'Archive resumed')},
  {label:'Media · export library',run:()=>ask('Media export directory · absolute path',async output=>task('media.export',{output},'Media export'))},
  {label:'Media · audit export',run:()=>ask('Media export directory to audit',async output=>task('media.audit',{output},'Media audit'))},
  ...(['voice','dictation'] as const).flatMap(mode=>[{label:(mode==='voice'?'Voice':'Dictation')+' · start microphone',run:()=>task(mode+'.start',{},mode+' started')},{label:(mode==='voice'?'Voice':'Dictation')+' · stop microphone',run:()=>task(mode+'.stop',{},mode+' stopped')},{label:(mode==='voice'?'Voice':'Dictation')+' · inspect controls',run:()=>task(mode+'.controls',{},mode+' controls')}]),
  {label:'Flow · validate file',run:()=>ask('Flow JSON file · absolute path',async path=>task('flow.validate',{path},'Flow validation'))},
  {label:'Flow · preview execution plan',run:()=>ask('Flow JSON file · absolute path',async path=>task('flow.run',{path,dryRun:true},'Flow plan'))},
  {label:'Flow · run file',run:()=>ask('Flow JSON file · Enter runs its steps',async path=>task('flow.run',{path},'Flow execution'))},
  {label:'Flow · resume run',run:()=>ask('Flow JSON file',async path=>{ask('Existing run ID · reconcile before resuming',async runId=>task('flow.run',{path,runId,resume:true},'Resume flow'));})},
  {label:'Flow · run status',run:()=>ask('Run ID',async runId=>task('flow.status',{runId},'Flow status'))},
  {label:'Runtime · status',run:()=>task('status',{},'Runtime status')},
  {label:'Runtime · reload adapters',run:()=>task('runtime.reload',{},'Reload runtime')},
  {label:'Settings · change one observed setting',run:()=>ask('Settings section · exact tab name',async section=>{ask('Setting · exact control name',async name=>{ask('New value · switches use true / false',async value=>task('settings.set',{section,name,value},'Setting change · UI receipt and persistence status'));});})},
  {label:'GPTs · explore public catalog',run:async()=>{const r=await rpc('gpts.catalog',{scope:'explore'});report('Public GPT catalog · observed pages',r);}},
  {label:'GPTs · owned catalog',run:async()=>{const r=await rpc('gpts.catalog',{scope:'owned'});report('Owned GPTs · observed page',r);}},
  {label:'Invoices · browse billing history',run:async()=>{const r=await rpc('invoices.list');menu(rows(r).map(x=>({label:(x.description||x.number||x.id)+' · '+(x.amount_paid??x.amount??'')+' '+(x.currency||''),run:()=>menu([{label:'Invoice details',run:()=>report('Invoice',x)},{label:'Download invoice PDF',run:async()=>task('invoices.download',{id:x.id},'Invoice download')}])})));status=r.complete?'Complete billing history':'Partial billing history';}},
  {label:'Invoices · download all',run:()=>task('invoices.download',{all:true},'Download all invoices')},
  {label:'Invoices · sync and file',run:()=>task('invoices.sync',{},'File invoices')},
  {label:'Takeout · resume lossless local archive',run:()=>ask('Archive directory · absolute path',async output=>task('takeout.run',{output},'Local archive'))},
  {label:'Takeout · audit existing archive',run:()=>ask('Archive directory to audit',async archive=>task('takeout.audit',{archive},'Archive audit'))},
  {label:'Takeout · request original website export',run:()=>task('takeout.run',{original:true},'Original export request')},
  {label:'Monitor · recent events',run:async()=>report('Recent events',await rpc('monitor.events',{limit:30}))},
  {label:monitoring?'Monitor · stop following':'Monitor · follow events',run:()=>{monitoring=!monitoring;clearTimeout(monitorTimer);if(monitoring)void monitor();else status='Monitor paused';}},
  {label:'Media · browse library',run:async()=>{const r=await rpc('media.list');status=r.complete?'Complete media library':'Partial media library · '+JSON.stringify(r.counts||{});menu([{label:'Library coverage',run:()=>report('Media coverage',r.coverage||r)},...rows(r).map(x=>({label:x.title||x.kind+' · '+x.id,run:()=>ask('Download media to absolute path',async output=>task('media.download',{id:x.reference||x.id,output},'Media download'))}))]);}},
  {label:'Media · play a local audio/video file',run:()=>ask('Local media path · ffplay opens a player',async path=>{const binary=Bun.which('ffplay');if(!binary)throw new Error('ffplay is not installed. Open the downloaded media with your preferred player.');if(!await Bun.file(path).exists())throw new Error('Local media file does not exist.');Bun.spawn([binary,'-autoexit','-loglevel','error',path],{stdin:'ignore',stdout:'ignore',stderr:'ignore'}).unref();status='Media player opened';})},
 ];}
 function commands(buildOnly=false){if(!buildOnly){paletteQuery='';paletteIndex=0;}allCommands=[{label:'New conversation',run:fresh},...(['conversations','projects','gpts'] as const).map(c=>({label:'Browse '+c,run:async()=>{collection=c;navProject=undefined;query='';focus='nav';await load();}})),{label:'Search conversations',run:()=>{collection='conversations';ask('Search indexed conversations',async q=>{const r=await rpc('conversations.search',{query:q,fullText:true});nav=collection==='conversations'?recentFirst(rows(r)):rows(r);query='';selected=0;focus='nav';coverage='Local index · coverage may be partial';});}},{label:'Reconcile current conversation with website',run:reconcileCurrent},{label:'Refresh current list',run:()=>load(true)},{label:'Live browser viewport · keyboard and mouse',run:async()=>{if(options.mock)throw new Error('Live browser viewport requires a connected account; mock mode stays offline.');viewport=new BrowserViewport(rpc,(image,hint)=>{if(ended)return;const {w,h}=view();process.stdout.write(esc+'H'+paint(clip(' '+hint,w),'blue')+esc+'K\r\n'+image.trimEnd()+esc+'0m'+esc+'J'+esc+h+';1H'+paint(clip(' '+a.label+' · '+a.id+'  |  Escape to workspace',w),'dim'));},e=>{viewport?.stop();viewport=null;fail(e);});try{await viewport.start();}catch(e){viewport.stop();viewport=null;throw e;}}},{label:'Inspect browser controls',run:snapshot},{label:'Open current context in browser',run:async()=>{await rpc('browser.open',{conversation,project,gpt});status='Opened in account browser';}},{label:'Show browser window',run:async()=>{await rpc('browser.mode',{mode:'headed'});status='Browser is visible';}},{label:`Select model · ${shortcutModifier}+M · apply immediately`,run:()=>selectSetting('model')},{label:`Select thinking effort · ${shortcutModifier}+E · apply immediately`,run:()=>selectSetting('effort')},{label:'Switch account',run:()=>{if(options.mock)throw new Error('Account switching is unavailable in offline demo mode.');menu(config().accounts.map(next=>({label:next.label+' · '+next.id,run:async()=>{if(localQueue.items.length)throw new Error('Send or remove locally queued messages before switching accounts.');if(selection.pending)throw new Error('Wait for the model or effort operation before switching accounts.');if(busy||websiteActive||sharedEnabled&&(shared.pending||sharedSyncs))throw new Error('Wait for current generation or shared queue operation before switching accounts.');a=next;shared=new SharedQueue(rpc,a);model='';effort='';mode='';project=undefined;gpt=undefined;inspection=null;fresh();await load();if(sharedEnabled)await syncSharedQueue(true);}})),'ACCOUNT');}},{label:'Stop generation',run:requestGenerationStop},{label:'Freeze account · /freeze · blocks all website traffic',run:()=>applyFreeze(true)},{label:'Thaw account · /thaw · allows website traffic again',run:()=>applyFreeze(false)},{label:'Browser: press key',run:()=>ask('Browser key · e.g. Escape, Enter, TAB',async key=>{await rpc('ui.key',{key});await snapshot();})},{label:`Attach local file · image, audio or document · ${shortcutModifier}+A`,run:attachFile},{label:'Pending attachments · review or remove',run:attachmentMenu},{label:`Received media · download or preview · ${shortcutModifier}+R`,run:receivedMedia},{label:'Browser: save screenshot',run:()=>ask('Screenshot output path',async output=>{await rpc('ui.screenshot',{output});status='Screenshot saved: '+output;})},{label:'Inspect media in current browser',run:async()=>{const r=await rpc('ui.snapshot');inspection=r;messages.push({role:'assistant',text:'# Browser media\n\n'+(r.media?.length?JSON.stringify(r.media,null,2):'No media reported in this viewport. Use the live browser view to interact with website media.')});scroll=0;}},{label:'Discover account capabilities',run:async()=>{const r=await rpc('capabilities.list');messages.push({role:'assistant',text:'# Account capabilities\n\n'+JSON.stringify(r,null,2)});focus='chat';scroll=0;}},{label:'Map website settings',run:async()=>{const r=await rpc('settings.map');messages.push({role:'assistant',text:'# Website settings\n\n'+JSON.stringify(r,null,2)});scroll=0;}},{label:`Queue · shared CLI/TUI drafts and receipts · ${shortcutModifier}+Q`,run:queueMenu},{label:`Toggle thinking details · ${shortcutModifier}+T`,run:()=>{showThinking=!showThinking;status='Thinking details '+(showThinking?'expanded':'collapsed');}},{label:'Keyboard help',run:()=>{messages.push({role:'assistant',text:`# Keyboard guide\n\nTab / Shift+Tab · cycle panes\nCtrl+F · filter navigation\nCtrl+K · all commands\n${shortcutModifier}+M · choose and apply model now\n${shortcutModifier}+E · choose and apply thinking effort now\n${shortcutModifier}+T · expand / collapse observed thinking details\n${shortcutModifier}+Q · shared CLI/TUI queue · paused for review; run explicitly\n${shortcutModifier}+A · attach a local file to the next message\n${shortcutModifier}+R · received media download / local preview\nCtrl+N · new conversation\nCtrl+B · browser inspector\nEnter · send or activate\nUp on first composer row · recall sent prompts\nUp / Down · move through multiline draft\nDown after newest prompt · restore draft\nShift+Enter / Ctrl+J · insert newline\nCtrl+C · stop generation / close overlay\nCtrl+Q · quit\nPage Up / Down · scroll transcript\nHome / End · composer cursor\nCtrl+U · clear composer\nCtrl+V · quoted insert · the next character is literal text (µ å † ® œ ´)\n\n${shortcutModifier} shortcuts need no terminal reconfiguration: ESC-prefixed Meta (iTerm2 Esc+, Terminal.app Use Option as Meta Key, WezTerm left Alt), kitty CSI-u / modifyOtherKeys, and the plain composed character macOS types by default — ${shortcutModifier}+M is µ, +T is †, +R is ®, +Q is œ, +A is å, +E is ´ (press Space after the dead key, or use Shift). A composed character fires its shortcut only when typed alone; inside prose, inside a paste, or after Ctrl+V it stays text. Every shortcut also has a slash command: /model /effort /thinking /queue /attach /media.\n\nInspector: ↑ ↓ select · Enter click · f fill · r refresh. Browser controls use a fresh snapshot identity.\n\nModel and effort changes apply immediately to the current website context. The header changes only after website verification. Stop active generation before changing either selection.`});scroll=0;}},...operations(),{label:'Quit workspace',run:stop}];if(buildOnly)return;paletteRoot=true;paletteTitle='COMMANDS · type to search all';palette=groupPalette(allCommands).map(g=>({label:g.label+' ›',run:()=>menu(g.items,g.label.toUpperCase())}));}

 const localSlashNames=['freeze','thaw','help','commands','model','effort','mode','queue','new','send','stop','quit','attach','attachments','media','thinking','search','conversations','projects','gpts','account','accounts','browser','inspect','refresh','reconcile','message','action','monitor'];
 function localSlashActions(){commands(true);return new Map(allCommands.map(choice=>['action-'+choice.label.replace(/ · (?:Option|Alt)\+.*/, '').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),choice]));}
 function slashSuggestions(){if(/\s/.test(draft))return [];const aliases=localSlashActions();const names=[...localSlashNames,...serviceOperations,...aliases.keys()].map(name=>'/'+name);const prefix=draft.split(/\s/,1)[0].toLowerCase();return [...new Set(names)].filter(name=>name.startsWith(prefix)).sort((left,right)=>left.length-right.length||left.localeCompare(right));}
 async function slashOperation(operation:string,args:any){
  if(['chat.stop','queue.run','queue.pause'].includes(operation)&&Object.keys(args).length)throw new Error('/'+operation+' uses the active TUI account and takes no extra options here.');
  if(['chat.model','chat.effort','chat.mode'].includes(operation)&&((args.conversation&&args.conversation!==conversation)||(args.project&&args.project!==project)||(args.gpt&&args.gpt!==gpt)||(args.new&&conversation)))throw new Error('Select the requested conversation or creation context before changing its model, effort or mode.');
  if(operation==='chat.model')return applySetting('model',String(args.model||args.label||''));
  if(operation==='chat.effort')return applySetting('effort',String(args.effort||args.label||''));
  if(operation==='chat.mode')return applyMode(args.mode);
  if(operation==='chat.stop')return requestGenerationStop();
  if(operation==='queue.run')return runSharedQueue();
  if(operation==='queue.pause'&&sharedEnabled){await shared.mutate('pause');status='Shared queue paused · current response continues';return;}
  if(operation==='chat.send'||operation==='chat.new'){
   const allowed=new Set(['text','files','conversation','new','project','gpt']);if(Object.keys(args).some(key=>!allowed.has(key)))throw new Error('Apply model, effort and mode with their slash controls before sending; unsupported send options were not ignored.');
   if((args.conversation&&args.conversation!==conversation)||(args.project&&args.project!==project)||(args.gpt&&args.gpt!==gpt))throw new Error('Open the requested target first, or use /queue.add with an explicit destination.');
   if(operation==='chat.new'||args.new){if(busy||websiteActive||localQueue.items.length||selection.pending)throw new Error('Wait for current activity before starting a new conversation.');const pendingFiles=attachments;fresh();attachments=pendingFiles;}
   if(!String(args.text||'').trim()&&!attachments.length&&!args.files?.length)throw new Error('Supply message text or an attachment.');
   const files=await Promise.all((args.files||[]).map((path:string)=>attachmentPath(path)));draft=String(args.text||'');attachments=[...attachments,...files];cursor=graphemes(draft).length;void send();return;
  }
  if((busy||websiteActive)&&! /^(?:status$|receipts\.get$|queue\.(?:list|status)$|monitor\.events$)/.test(operation))throw new Error('Wait for or stop the active generation before this operation.');
  queueView=false;focus='chat';scroll=0;const resultMessage:Message={...localMessageTime(),role:'system',text:'/'+operation+'\n'};messages.push(resultMessage);render();
  const result=await rpc(operation,args,event=>{if(event.type==='text')resultMessage.text+=clean(event.text);else if(event.type==='replace')resultMessage.text=clean(event.text);else if(event.type==='thinking')resultMessage.thinking=mergeThinking(resultMessage.thinking||[],event);else if(event.type==='media')resultMessage.media=event.items||[];else{status='/'+operation+' · '+(event.type||'working');resultMessage.text+='\n'+JSON.stringify(event);}render();});
  resultMessage.text+='\n'+JSON.stringify(result,null,2);status='/'+operation+' complete';if(operation.startsWith('queue.')&&sharedEnabled)await shared.refresh();
 }
 async function executeSlash(){
  if(slashRunning){status='Wait for the current slash command';return;}
  const original=draft,originalCursor=cursor,aliases=localSlashActions();
  try{
   if(original.trim()==='/'){draft='';cursor=0;commands();render();return true;}const parsed=parseSlash(original,[...localSlashNames,...aliases.keys()]);if(!parsed)return false;
   if(parsed.kind==='message'){draft=parsed.text;cursor=graphemes(draft).length;void send();return true;}
   slashRunning=true;draft='';cursor=0;slashHidden=false;slashIndex=0;
   if(parsed.kind==='operation')await slashOperation(parsed.operation,parsed.args);
   else{
    const name=parsed.command,words=parsed.positionals||[],value=words.join(' '),args=parsed.args||{};
    if(Object.keys(args).length)throw new Error('Local /'+name+' takes plain or quoted words; use the explicit dotted operation for named flags.');
    if(name==='model'||name==='effort'){if(value)await applySetting(name,value);else await selectSetting(name);}
    else if(name==='mode'){if(value&&!['Chat','Work'].includes(value))throw new Error('Mode must be Chat or Work');if(value)await applyMode(value as 'Chat'|'Work');else menu(['Chat','Work'].map(value=>({label:value,run:()=>applyMode(value as 'Chat'|'Work')})),'MODE');}
    else if(name==='send'){if(!value&&!attachments.length)throw new Error('Usage: /send TEXT (attachments remain attached)');draft=value;cursor=graphemes(draft).length;void send();}
    else if(name==='new')fresh();else if(name==='stop')await requestGenerationStop();else if(name==='quit')stop();
    else if(name==='freeze')await applyFreeze(true,value||undefined);
    else if(name==='thaw')await applyFreeze(false);
    else if(name==='queue')await queueMenu();else if(name==='commands')commands();
    else if(name==='help'){report('Slash commands','Type / to discover commands. Tab completes without executing; Enter runs an exact command. Unknown commands remain drafts. Use // to send a message beginning with /.\n\n'+[...localSlashNames,...serviceOperations].map(name=>'/'+name).join('  ')+'\n\nRegistered operations accept --named flags; --body takes quoted JSON. /action searches every workspace action. Every keyboard shortcut has a slash equivalent, so nothing depends on the '+shortcutModifier+' key: '+shortcutModifier+' shortcuts are accepted as ESC-prefixed Meta, kitty CSI-u, and as the composed character macOS types by default (µ † ® œ å ´) when that character is typed alone. Ctrl+V inserts the next character literally.');}
    else if(name==='attach'){if(value){attachments.push(await attachmentPath(value));status='File attached to next message';}else attachFile();}
    else if(name==='attachments')attachmentMenu();else if(name==='media')await receivedMedia();else if(name==='thinking'){showThinking=!showThinking;status='Thinking details '+(showThinking?'expanded':'collapsed');}
    else if(name==='search'&&value){collection='conversations';const result=await rpc('conversations.search',{query:value,fullText:true});nav=recentFirst(rows(result));query='';selected=0;focus='nav';coverage='Local index · coverage may be partial';}
    else if(name==='reconcile')await reconcileCurrent();else if(name==='inspect')await snapshot();else if(name==='refresh')await load(true);
    else if(['conversations','projects','gpts'].includes(name)){collection=name as typeof collection;navProject=undefined;query='';focus='nav';await load();}
    else if(name==='action'){const found=allCommands.find(choice=>choice.label.toLowerCase()===value.toLowerCase());if(found)await found.run();else{commands();paletteQuery=value;}}
    else if(aliases.has(name))await aliases.get(name)!.run();
    else{const prefix:Record<string,string>={search:'Search conversations',account:'Switch account',accounts:'Switch account',browser:'Live browser viewport',message:'Saved message',monitor:'Monitor · recent events'};const choice=allCommands.find(choice=>choice.label.startsWith(prefix[name]||'\0'));if(!choice)throw new Error('Unknown local command /'+name);await choice.run();}
   }
   return true;
  }catch(e){if(!draft){draft=original;cursor=originalCursor;}error=clean((e as any)?.message||e);status='Slash command not completed · command retained';return true;}
  finally{slashRunning=false;render();}
 }
 async function applyFreeze(on:boolean,reason?:string){
  if(!options.mock)setFreeze(a,on,{by:'tui',...(on&&reason?{reason}:{})});
  frozen=on;status=on?'❄ Frozen: no site traffic until /thaw':'Thawed: site traffic allowed again';
  if(on&&(busy||websiteActive))await rpc('chat.stop').catch(()=>{});
 }
 async function requestGenerationStop(){if(cancelRequested){status='Stop already requested · waiting for website';render();return;}cancelRequested=true;localQueue.paused=true;try{if(sharedEnabled&&(sharedRunActive||shared.state.running))await shared.mutate('pause');await rpc('chat.stop');status='Stop requested';if(websiteActive)scheduleRecovery();render();}catch(e){cancelRequested=false;throw e;}}
 async function handle(k:Key){
  if(k.text&&composedShortcuts[k.text]===k.key)composedNotice=shortcutModifier+' shortcut from '+k.text+' · Ctrl+V then '+k.text+' inserts the character';
  else if(['text','enter','newline','backspace'].includes(k.key))composedNotice='';
  if(viewport){if(k.key==='escape'||k.key==='ctrl-c'){viewport.stop();viewport=null;render();}else if(k.key==='ctrl-q')stop();else viewport.input(k);return;}if(k.key==='ctrl-q'){stop();return;}if(k.key==='escape'&&queueView&&!palette&&!prompt){queueView=false;render();return;}if(k.key==='ctrl-c'){if(palette||prompt){palette=null;prompt=null;}else if(busy||websiteActive||queueView&&shared.state.running){void action(requestGenerationStop);}else stop();return;}
 if(k.key==='attach'){if(!prompt){palette=null;attachFile();}render();return;}
 if(k.key==='received-media'){if(!prompt){palette=null;await action(async()=>receivedMedia());}render();return;}
 if(k.key==='queue'){if(prompt){status='Close the current prompt before opening the queue';render();return;}await queueMenu();render();return;}
 if(k.key==='thinking'){showThinking=!showThinking;status='Thinking details '+(showThinking?'expanded':'collapsed');render();return;}
 if(k.key==='model'||k.key==='effort'){if(prompt){status='Close the current prompt before choosing model or effort';render();return;}palette=null;await action(()=>selectSetting(k.key as 'model'|'effort'));render();return;}
 if(prompt){if(k.key==='escape')prompt=null;else if(k.key==='backspace')prompt.value=graphemes(prompt.value).slice(0,-1).join('');else if(k.key==='text')prompt.value+=k.text;else if(k.key==='enter'){const p=prompt;prompt=null;await action(()=>p.submit(p.value));}render();return;}
 if(palette){if(k.key==='escape'){if(paletteRoot)palette=null;else commands();}else if(k.key==='text'){paletteQuery+=k.text;paletteIndex=0;}else if(k.key==='backspace'){paletteQuery=graphemes(paletteQuery).slice(0,-1).join('');paletteIndex=0;}else if(k.key==='up')paletteIndex=Math.max(0,paletteIndex-1);else if(k.key==='down')paletteIndex=Math.min(choices().length-1,paletteIndex+1);else if(k.key==='enter'){const chosen=choices()[paletteIndex];palette=null;if(chosen)await action(async()=>chosen.run());}render();return;}
 if(focus==='chat'&&!draft&&k.key==='text'&&k.text?.startsWith('/'))focus='compose';
 if(focus==='compose'&&draft.startsWith('/')&&!draft.startsWith('//')){
  if(k.key==='escape'){slashHidden=true;render();return;}
  if(k.key==='tab'){const found=slashSuggestions()[slashIndex];if(found){draft=found+' ';cursor=graphemes(draft).length;}slashHidden=false;render();return;}
  if((k.key==='up'||k.key==='down')&&!slashHidden){slashIndex=Math.max(0,Math.min(slashSuggestions().length-1,slashIndex+(k.key==='up'?-1:1)));render();return;}
  if(k.key==='enter'){void action(executeSlash);return;}
  if(k.key==='text'||k.key==='backspace'){slashHidden=false;slashIndex=0;}
 }
 if(k.key==='palette')commands();else if(k.key==='new')fresh();else if(k.key==='search'){focus='nav';query='';status='Type to filter · Enter opens · Escape clears';}else if(k.key==='browser')await snapshot();else if(k.key==='refresh')await load(true);else if(k.key==='tab'||k.key==='backtab'){const panes:typeof focus[]=['nav','chat','compose',...(inspector?['inspect' as const]:[])];focus=panes[(panes.indexOf(focus)+(k.key==='tab'?1:panes.length-1))%panes.length];}else if(k.key==='pageup')scroll+=Math.max(3,view().h-12);else if(k.key==='pagedown')scroll=Math.max(0,scroll-Math.max(3,view().h-12));
 else if(focus==='nav'){if(k.key==='up')selected=Math.max(0,selected-1);if(k.key==='down')selected=Math.min(filtered().length-1,selected+1);if(k.key==='text'){query+=k.text;selected=0;}if(k.key==='backspace'){query=graphemes(query).slice(0,-1).join('');selected=0;}if(k.key==='escape'){if(query)query='';else if(navProject){navProject=undefined;collection='projects';await load();}}if(k.key==='enter')await open();}
 else if(focus==='inspect'){const controls=inspection?.controls||[];if(k.key==='up')control=Math.max(0,control-1);if(k.key==='down')control=Math.min(controls.length-1,control+1);if(k.text==='r')await snapshot();if(k.key==='enter'&&controls[control])await action(async()=>{await rpc('ui.click',{epoch:inspection.epoch,ref:controls[control].ref});await snapshot();});if(k.text==='f'&&controls[control]){const ref=controls[control].ref,epoch=inspection.epoch;ask('Fill '+(controls[control].name||ref),async text=>{await rpc('ui.fill',{ref,epoch,text});await snapshot();});}}
 else if(focus==='chat'){if(k.key==='up')scroll++;if(k.key==='down')scroll=Math.max(0,scroll-1);if(k.key==='end')scroll=0;}
 else {if(k.key==='up'||k.key==='down'){const next=composerNavigation.move({text:draft,files:attachments,cursor},k.key==='up'?-1:1,view().w-4,messages);draft=next.text;attachments=next.files;cursor=next.cursor;render();return;}composerNavigation.edited();let gs=graphemes(draft);cursor=Math.min(cursor,gs.length);if(k.key==='text'||k.key==='newline'){const add=graphemes(k.key==='newline'?'\n':k.text||'');gs.splice(cursor,0,...add);cursor+=add.length;}else if(k.key==='left')cursor=Math.max(0,cursor-1);else if(k.key==='right')cursor=Math.min(gs.length,cursor+1);else if(k.key==='home')cursor=0;else if(k.key==='end')cursor=gs.length;else if(k.key==='backspace'&&cursor>0)gs.splice(--cursor,1);else if(k.key==='delete')gs.splice(cursor,1);else if(k.key==='clear'){gs=[];cursor=0;}else if(k.key==='wordback'){while(cursor>0&&/\s/.test(gs[cursor-1]))gs.splice(--cursor,1);while(cursor>0&&!/\s/.test(gs[cursor-1]))gs.splice(--cursor,1);}draft=gs.join('');if(k.key==='enter'){if(draft.startsWith('/'))void action(executeSlash);else void send();}}
 render();}
 function palettePortable(){return !palette||paletteRoot||paletteTitle.startsWith('MODEL')||paletteTitle.startsWith('THINKING EFFORT')||groupPalette(allCommands).some(group=>group.label.toUpperCase()===paletteTitle);}
 function snapshotState(){return {a,inFlight:busy&&!sharedRunActive||websiteActive,generationStarted,sharedQueueView:{account:a.id,visible:queueView,details:shared.details},composerNavigation:composerNavigation.snapshot(),collection,nav,selected,query,focus,conversation,project,gpt,heading,messages,draft,cursor,scroll,model,effort,mode,status,error,coverage,inspector,inspection,control,navProject,monitoring,showThinking,attachments,downloads,queue:localQueue.snapshot(),palette:palette?{root:paletteRoot,title:paletteTitle,query:paletteQuery,index:paletteIndex,labels:palette.map(choice=>choice.label)}:null};}
 function reloadWhenReady(){
  if(!reloadPending||ended||busy||loading||activeActions||selection.pending||prompt||viewport||!palettePortable())return;
  reloadState=snapshotState();stop();
 }
 function restoreState(state:Record<string,any>){
  state={...snapshotState(),...state};composerNavigation.restore(state.composerNavigation);if(state.sharedQueueView?.account===a.id){queueView=state.sharedQueueView.visible===true;shared.details=state.sharedQueueView.details||{};}websiteActive=state.inFlight===true;generationStarted=state.generationStarted||Date.now();if(websiteActive&&!animationTimer)animationTimer=setInterval(render,100);
  ({a,collection,nav,selected,query,focus,conversation,project,gpt,heading,messages,draft,cursor,scroll,model,effort,mode,status,error,coverage,inspector,inspection,control,navProject,monitoring,showThinking}=state);localQueue.restore(state.queue);attachments=state.attachments||[];downloads=state.downloads||{};
  if(state.palette){const saved=state.palette;commands();if(!saved.root){
   if(saved.title.startsWith('MODEL')||saved.title.startsWith('THINKING EFFORT')){
    const kind=saved.title.startsWith('MODEL')?'model':'effort';
    menu(saved.labels.map((label:string)=>({label,run:label.startsWith('Switch to ')?async()=>{await applyMode(label.includes('Work')?'Work':'Chat');await selectSetting('model');}:()=>applySetting(kind,label.replace(/ · current$/,''))})),saved.title);
   }else{const group=groupPalette(allCommands).find(group=>group.label.toUpperCase()===saved.title);if(group)menu(group.items,saved.title);}
  }paletteQuery=saved.query;paletteIndex=saved.index;}
 }
 let resolveDone:()=>void;const done=new Promise<void>(resolve=>{resolveDone=resolve;});
 function stop(){if(ended)return;clearTimeout(checkpointTimer);options.onCheckpoint?.(snapshotState());ended=true;viewAbort.abort();clearInterval(reloadTimer);clearInterval(sharedTimer);clearInterval(freezeTimer);clearInterval(animationTimer);clearTimeout(monitorTimer);clearTimeout(recoveryTimer);viewport?.stop();clearTimeout(escapeTimer);process.stdin.off('data',input);process.stdout.off('resize',onResize);process.off('SIGTERM',stop);process.off('SIGINT',stop);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write(esc+'?2004l'+esc+'?25h'+esc+'?1049l');resolveDone();}
 function onResize(){if(viewport)void viewport.resize().catch(fail);else render();}
 function input(data:string){for(const key of decoder.feed(data))void handle(key).catch(fail);clearTimeout(escapeTimer);escapeTimer=setTimeout(()=>{for(let pending=decoder.flushEscape();pending>0;pending--)void handle({key:'escape'}).catch(fail);},30);}
 process.stdout.write(esc+'?1049h'+esc+'?25l'+esc+'?2004h');process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();process.stdin.on('data',input);process.stdout.on('resize',onResize);process.on('SIGTERM',stop);process.on('SIGINT',stop);
 try{
  if(options.restore){restoreState(options.restore);if(!options.mock){void (async()=>{try{const selectedId=nav[selected]&&id(nav[selected]),cached=await rpc('conversations.cached');if(ended||collection!=='conversations'||navProject)return;nav=recentFirst(rows(cached));selected=Math.max(0,nav.findIndex(item=>id(item)===selectedId));coverage='Cached index · '+nav.length;render();}catch{/* Preserve the checkpoint when the local index is unavailable. */}})();}status=options.restoreFromDisk?(options.restore.status||'Restored previous session · local queue paused'):'Update loaded · session preserved';render();if(monitoring)void monitor();}
  else{render();await load();if(options.mock){await open();render();}else{status='Ready · choose a conversation or write a message';render();}if(options.mode)await action(()=>applyMode(options.mode!));if(options.model)await action(()=>applySetting('model',options.model!));if(options.effort)await action(()=>applySetting('effort',options.effort!));}
  if(ended)return reloadState;
  options.onReady?.({requestReload:()=>{reloadPending=true;status='Update ready · waiting for current activity to finish';render();reloadWhenReady();},notice:message=>{status=message;render();}});
  reloadTimer=setInterval(reloadWhenReady,100);
  function refreshFreeze(){if(options.mock)return;try{const state=readFreeze(a);if(state.frozen!==frozen){frozen=state.frozen;render();}}catch{}}
  refreshFreeze();freezeTimer=setInterval(refreshFreeze,5000);freezeTimer.unref?.();
  if(sharedEnabled){void syncSharedQueue(!!options.restoreFromDisk);sharedTimer=setInterval(()=>void syncSharedQueue(),5000);}
  if(options.restore&&!reloadPending){if(needsReconciliation(messages)||options.restore.inFlight){localQueue.paused=true;scheduleRecovery();}else void drainQueue();}
  await done;return reloadState;
 }finally{stop();}
}
