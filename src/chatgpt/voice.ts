import {Actions} from './actions.ts';
import type {BrowserWorker} from './transport.ts';
import {adapter} from './adapters.ts';

/** Audio is carried by the website's own media session and local browser devices. */
export class WebsiteVoice {
 constructor(private browser:BrowserWorker,private actions:Actions){}
 async transcribe(path:string){
  if(!path)throw new Error('dictation transcribe requires --file AUDIO_PATH.');
  const before=await this.actions.snapshot(),composer=before.controls.find(c=>c.id==='prompt-textarea');
  if(composer?.value?.trim())throw new Error('The composer already contains a draft. Preserve or clear it before transcribing a file.');
  await this.browser.call('audio.input',{path});let recording=false;
  try{
   await this.start('dictation');recording=true;
   await this.actions.find(c=>c.name==='Submit dictation'&&!c.disabled);
   for(let i=0;i<40;i++){const state=await this.browser.call('audio.status');if(state.used)break;if(i===39)throw new Error('Website did not acquire the prepared audio stream. Reload the dedicated page before retrying.');await Bun.sleep(250);}
   const playback=await this.browser.call('audio.play');
   await Bun.sleep(Math.ceil(playback.duration*1000)+500);
   await this.stop('dictation');recording=false;
   for(let i=0;i<120;i++){const snapshot=await this.actions.snapshot(),draft=snapshot.controls.find(c=>c.id==='prompt-textarea')?.value;if(draft?.trim())return {text:draft,draftApplied:true,submittedToChat:false,source:'website dictation',ambientMicrophone:false};const state=await this.browser.call('audio.status');if(state.transcription?.status===200&&typeof state.transcription.body?.text==='string'&&state.transcription.body.text.trim())return {text:state.transcription.body.text,receipt:state.transcription.body,draftApplied:false,submittedToChat:false,source:'website dictation receipt',ambientMicrophone:false};await Bun.sleep(500);}
   throw new Error('Dictation outcome unknown: the website did not expose a transcript within 60 seconds. No chat message was sent.');
  }finally{
   if(recording){try{await this.actions.named('Cancel dictation');}catch{}}
   await this.browser.call('audio.clear').catch(()=>{});
  }
 }
 async start(kind:'voice'|'dictation'){
  const labels=adapter().labels[kind];
  const target=await this.actions.find(c=>labels.includes(c.name.trim())&&!c.disabled);
  // Only an explicit start operation asks the browser for microphone access.
  await this.browser.call('surface.activate',{surface:'main'});
  await this.browser.call('permission',{permissions:['audioCapture']});
  await this.browser.call('action',{kind:'click',ref:target.c.ref,epoch:target.s.epoch});
  for(let i=0;i<40;i++){
   const controls=await this.controls(),names=controls.controls.map((c:any)=>c.name?.trim());
   const connected=kind==='voice'?names.some((name:string)=>['End Voice','End voice chat','End voice conversation','Exit voice mode','Turn off microphone'].includes(name)):names.some((name:string)=>['Submit dictation','Cancel dictation','Stop dictation','Stop recording'].includes(name));
   if(connected)return {requested:true,kind,transport:'website browser audio devices',verification:'website session controls observed',controls};
   await Bun.sleep(250);
  }
  throw new Error('Website audio start was not confirmed; no audio was submitted.');
 }
 async controls(){const s=await this.actions.snapshot();return {url:s.url,epoch:s.epoch,controls:s.controls.filter(c=>/voice|dictat|microphone|mute|audio|camera|video|screen|caption|end|stop|leave/i.test(c.name+' '+c.context)),media:s.media};}
 async stop(kind:'voice'|'dictation'){
  const names=kind==='voice'?['End Voice','End voice chat','End voice conversation','End','Exit voice mode','Leave']:['Stop dictation','Stop recording','Submit dictation'];
  const {s,c}=await this.actions.find(c=>names.includes(c.name.trim())&&!c.disabled);
  await this.browser.call('action',{kind:'click',ref:c.ref,epoch:s.epoch});return {stopped:true,kind,control:c.name};
 }
}
