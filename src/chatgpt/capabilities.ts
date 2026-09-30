import {createHash} from 'node:crypto';
import {adapter} from './adapters.ts';

/** An open-ended site cannot be certified complete from its sidebar alone. */
export const surfaces:Record<string,string[]>={
 harness:['run','test','status','list'],
 online:['list','status'],
 conversations:['list','search','get','path','create','resume','send','stop','edit','branch','regenerate','rename','archive','unarchive','delete','pin','unpin','share','unshare','move','report','read-aloud','feedback','reconcile','export'],
 models:['list','options','mode','select','effort','thinking-expand'],
 queue:['add','list','status','edit','remove','reorder','pause','resume','run','retry','reconcile','native-queue','native-steer'],
 projects:['list','get','chats','create','rename','delete','instructions','files','sharing','memory','move-chat'],
 health:['open','data','files','apps','settings'],
 sites:['open','list','create','edit','publish'],
 work:['open','tasks','files','settings'],
 apps:['open','list','connect','disconnect','permissions'],
 library:['open','list','folders','archived','trash','versions','download'],
 images:['open','list','create','edit','download','archived'],
 gpts:['owned-list','bootstrap','list','get','discover','search','create','edit','publish','delete','knowledge','actions','version-history'],
 media:['upload','download','images','library','image-edit','image-create','video','audio','dictation','voice','live','camera','screen-share','canvas','canvas-export','export','audit','audio-input','audio-play','audio-status','audio-clear','audio-output-arm','audio-output-read','audio-output-status','audio-output-stop','audio-output-capture','dictation-transcribe','voice-stop','voice-controls','voices'],
 tools:['search','deep-research','agent','study','apps','connectors','plugins','scheduled-tasks'],
 settings:['general','notifications','personalization','plugins','voice','billing','usage','analytics','data-controls','cloud-browser','storage','safety','security','parental-controls','trusted-contact','account','keyboard'],
 account:['switch','workspaces','subscription','invoices','invoice-download','invoice-sync','takeout','takeout-original','invoice-watch','invoice-watcher','invoice-unwatch','takeout-status','takeout-pause','takeout-resume','takeout-watch','takeout-watch-status','takeout-unwatch'],
 browser:['discover','attach','managed','headed','headless','passthrough','snapshot','controls','upload','screenshot'],
 reliability:['events','health','coverage','drift','adapter-validate','adapter-promote','adapter-rollback','archive-audit','runtime-reload','receipts-list','receipts-get','flow-validate','flow-run','flow-status'],
};
const operations:Record<string,string>={
 ...Object.fromEntries(['run','test','status','list'].map(action=>['harness.'+action,'harness.'+action])),
 ...Object.fromEntries(['list','status'].map(action=>['online.'+action,'online.'+action])),
 'conversations.rename':'conversations.rename','conversations.pin':'conversations.pin','conversations.unpin':'conversations.unpin','conversations.archive':'conversations.archive','conversations.unarchive':'conversations.unarchive','conversations.share':'conversations.share','conversations.reconcile':'chat.reconcile','conversations.export':'conversations.export',
 'models.list':'models.list','models.options':'models.options','models.mode':'chat.mode','models.select':'chat.model','models.effort':'chat.effort','models.thinking-expand':'thinking.expand',
 ...Object.fromEntries(['add','list','status','edit','remove','reorder','pause','resume','run','retry','reconcile'].map(action=>['queue.'+action,'queue.'+action])),
 'media.export':'media.export','media.audit':'media.audit','media.audio-input':'audio.input','media.audio-play':'audio.play','media.audio-status':'audio.status','media.audio-clear':'audio.clear',
 ...Object.fromEntries(['arm','read','status','stop','capture'].map(action=>['media.audio-output-'+action,'audio.output.'+action])),
 'media.dictation-transcribe':'dictation.transcribe','media.voice-stop':'voice.stop','media.voice-controls':'voice.controls','media.voices':'voices.list',
 'account.invoice-watch':'invoices.watch','account.invoice-watcher':'invoices.watcher','account.invoice-unwatch':'invoices.unwatch',
 ...Object.fromEntries(['status','pause','resume','watch','watch-status','unwatch'].map(action=>['account.takeout-'+action,'takeout.'+action])),
 'reliability.runtime-reload':'runtime.reload','reliability.receipts-list':'receipts.list','reliability.receipts-get':'receipts.get',
 ...Object.fromEntries(['validate','run','status'].map(action=>['reliability.flow-'+action,'flow.'+action])),
 'conversations.list':'conversations.list','conversations.search':'conversations.search','conversations.get':'conversations.get','conversations.path':'conversations.path','conversations.create':'chat.new','conversations.resume':'conversations.open','conversations.send':'chat.send','conversations.stop':'chat.stop','conversations.edit':'chat.edit','conversations.branch':'chat.branch','conversations.regenerate':'chat.regenerate',
 'projects.list':'projects.list','projects.get':'projects.get','projects.chats':'projects.chats','gpts.bootstrap':'gpts.bootstrap','gpts.owned-list':'gpts.owned','gpts.discover':'gpts.catalog','gpts.list':'gpts.list','gpts.get':'gpts.get',
 'library.list':'media.list','library.download':'media.download','images.list':'media.list','images.download':'media.download',
 'media.upload':'ui.upload','media.download':'media.download','media.library':'media.list','media.voice':'voice.start','media.dictation':'dictation.start','media.live':'voice.start',
 'tools.connectors':'connectors.list','tools.plugins':'plugins.list','tools.scheduled-tasks':'tasks.list',
 'account.invoices':'invoices.list','account.invoice-download':'invoices.download','account.invoice-sync':'invoices.sync','account.takeout':'takeout.run','account.takeout-original':'takeout.run --original',
 'browser.snapshot':'ui.snapshot','browser.controls':'ui.snapshot','browser.upload':'ui.upload','browser.screenshot':'ui.screenshot','browser.attach':'browser.start','browser.managed':'browser.start','browser.headed':'browser.mode','browser.headless':'browser.mode','browser.passthrough':'tui browser viewport',
 'reliability.events':'monitor.watch','reliability.health':'status','reliability.coverage':'capabilities.list','reliability.drift':'map.scan','reliability.adapter-validate':'adapter.validate','reliability.adapter-promote':'adapter.promote','reliability.adapter-rollback':'adapter.rollback','reliability.archive-audit':'takeout.audit',
};
export function capabilityReport(discovery:any,receipts:any[]=[],evidence:Record<string,any>={},mapped:any={}){
 const revision=adapter().version;
 const capabilities=Object.entries(surfaces).flatMap(([surface,actions])=>actions.map(action=>{
  const id=`${surface}.${action}`,operation=operations[id],proof=operation?evidence[operation]:undefined;
  const observed=proof?.observedSuccess===true&&proof.operation===operation;
  const current=observed&&proof.adapter===revision;
  const status=current?(proof.complete===false?'observed-partial':'operation-completed'):observed?'historical-operation':operation?'implemented-unverified':'unmapped';
  return {id,surface,action,operation,status,access:operation?'operation':'browser-controls',parityVerified:false,semanticStatus:'unverified',evidence:observed?[proof]:[],...(surface==='queue'?{scope:action.startsWith('native-')?'website-native':'local-durable-cli',limitation:'The durable CLI queue and TUI draft queue are local. Neither proves website-native queue or steering behavior.'}:{}),...(id==='conversations.share'?{limitation:'Opens the website share launcher; publishing a shared link is unverified.'}:{}),...(id==='gpts.bootstrap'?{scope:'bootstrap-gizmos',limitation:'Bootstrap pagination does not enumerate all owned My GPTs.'}:{}),...(id==='account.takeout-original'?{scope:'official-export-request',limitation:'A local takeout receipt is not evidence of an official export request.'}:{})};
 }));
 const sections=Array.isArray(discovery?.sections)?discovery.sections:[];
 const controls:any[]=[],nestedCoverage:any[]=[];
 for(const section of sections){
  const visit=(node:any,path:any[])=>{
   for(const [index,c] of (Array.isArray(node.controls)?node.controls:[]).entries())controls.push({id:'settings.'+createHash('sha256').update(JSON.stringify([section.name,path,index,c.name,c.role,c.testId,c.context])).digest('hex').slice(0,16),section:section.name,path,name:c.name,role:c.role||c.tag,value:c.value,checked:c.checked,disabled:c.disabled,context:c.context,options:c.options||[],access:{open:'settings.open',section:section.name,triggers:path,inspect:'ui.snapshot',action:(c.role||c.tag)==='textbox'?'ui.fill':'ui.click'},status:'discovered',requiresFreshReference:true,mutationVerified:false});
   for(const child of Array.isArray(node.nested)?node.nested:[]){const trigger=typeof child.trigger==='string'?child.trigger:child.trigger?.name||'unidentified-trigger';const next=[...path,trigger];nestedCoverage.push({section:section.name,path:next,controlCount:Array.isArray(child.controls)?child.controls.length:0,evidence:child.evidence,confirmed:child.confirmed===true,complete:child.complete===true});visit(child,next);}
  };visit(section,[]);
 }
 const settingsCoverage={navigationComplete:discovery?.navigationComplete===true,complete:false,nested:nestedCoverage,unexplored:sections.flatMap((s:any)=>(s.unexplored||[]).map((control:any)=>({section:s.name,control}))),receipts:discovery?.coverage||[],limitation:'Tab navigation and opened menus do not prove exhaustive conditional settings or successful mutations.'};
 const discoveredSurfaceControls=Object.entries(mapped.surfaces||{}).flatMap(([surface,value]:[string,any])=>(Array.isArray(value?.controls)?value.controls:[]).map((control:any,index:number)=>({id:'surface.'+createHash('sha256').update(JSON.stringify([surface,index,control.name,control.role,control.testId])).digest('hex').slice(0,16),surface,observedAt:value.at,control,status:'discovered',requiresFreshReference:true,mutationVerified:false})));
 // A non-throwing dispatcher is still a semantic verification gap.
 const gaps=capabilities.map(c=>({id:c.id,status:c.status==='operation-completed'?'semantic-unverified':c.status}));
 gaps.push({id:'gpts.owned-catalog',status:'unverified-scope'},{id:'settings.conditional-and-nested',status:'unverified-scope'});
 return {schema:4,adapter:revision,at:new Date().toISOString(),complete:false,summary:{catalogued:capabilities.length,implemented:capabilities.filter(c=>c.operation).length,currentOperationCompletions:capabilities.filter(c=>c.status==='operation-completed').length,semanticParityVerified:0,semanticVerificationGaps:capabilities.length,discoveredSettingControls:controls.length,discoveredSurfaceControls:discoveredSurfaceControls.length},capabilities,discoveredSurfaceControls,discoveredControls:controls,discoveredSettings:sections,settingsCoverage,observedSurfaces:mapped.surfaces||{},coverage:receipts,gaps,verification:'Operation completion records one non-throwing dispatch, not semantic success or full parity. Partial results and historical adapter evidence remain distinct.',limitation:'Unknown, conditional and untested surfaces stay explicit. Generic browser controls do not establish tested parity for every feature.'};
}
