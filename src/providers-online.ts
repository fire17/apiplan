import type {Provider,Built,CallOpts,Creds,Turn} from './providers.ts';
import type {StreamShape} from './stream-shape.ts';
import type {Model} from './registry.ts';
import {account} from './chatgpt/accounts.ts';
import {onlineFault} from './chatgpt/online-wire.ts';
import {fresh} from './chatgpt/fresh.ts';
import type {OnlineRequest} from './chatgpt/online-runtime.ts';

function configured(){const a=account();if(!a.userId||!a.cdpURL||a.transportMode==='managed')throw onlineFault('NOT_AUTHENTICATED','Run chatgpt browser attach and verify the signed-in website account before using online models.',401);const url=new URL(a.cdpURL);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw onlineFault('INVALID_BROWSER','Online website provider requires a loopback browser endpoint.');return a;}
function selection(model:Model,options:CallOpts):OnlineRequest['selection']{
 const effort=options.effort||'low';if(effort!=='low')throw onlineFault('UNSUPPORTED_EFFORT','The online provider currently accepts low effort only; additional levels require verified website mapping.');
 const native:Record<string,OnlineRequest['selection']>={
  'online-chat-latest':{mode:'Chat',model:'Latest',effort:'Instant'},
  'online-gpt-6-astra':{mode:'Work',model:'GPT-6 Astra',effort:'Light'},
 };
 const chosen=native[model.id];
 if(!chosen)throw onlineFault('MODEL_NOT_FOUND','Unknown online website model.');
 // An explicitly requested mode has to survive all the way down here, or `--chatmode` is
 // decoration. Each website model is offered in exactly ONE composer mode (observed), so a
 // request for the other one is a routing mistake upstream — refuse it by name. Never
 // resolve it by swapping in the model the other mode does offer: a silent Chat/Latest
 // answer wearing an Astra receipt is the single worst outcome this provider can produce.
 const wanted=options.mode==='chat'?'Chat':options.mode==='work'?'Work':undefined;
 if(wanted&&wanted!==chosen.mode)throw onlineFault('MODE_UNAVAILABLE',`The website offers '${chosen.model}' in ${chosen.mode} mode only, but ${wanted} mode was requested. chatgpt.com's picker decides this, not APIPlan.`);
 return chosen;
}
export const online:Provider & StreamShape={
 id:'online',label:'ChatGPT website',usageBasis:'exclusive',cache:{kind:'none',identity:'none'},framing:'ndjson',wantsStreamFlag:false,
 probe(){try{const a=configured();return {connected:true,detail:'Attached website account configured: '+a.id+' (verified again for every generation)',loginHint:'chatgpt browser attach'};}catch(error:any){return {connected:false,detail:error.message,loginHint:'chatgpt browser attach'};}},
 creds(){const a=configured();return {token:'',account:a.id,source:'signed-in website browser'};},
 efforts(){return ['low'];},
 build(model:Model,turns:Turn[],options:CallOpts,creds:Creds):Built{
  const a=account(creds.account);if(!a.userId)throw onlineFault('NOT_AUTHENTICATED','Website account has no verified identity.',401);
  // Validate before browser startup and bind this request to the captured account.
  return {url:'apiplan-online://website/generate',headers:{},body:{version:1,model:model.id,accountId:a.id,accountUserId:a.userId,accountWorkspace:a.workspace,turns,options,selection:selection(model,options)} satisfies OnlineRequest};
 },
 async open(built,signal){const {openOnlineRequest}=await fresh('online-runtime');return openOnlineRequest(built,signal);},
 delta(event:any){return event?.delta||{};},
 terminal(event:any){return event?.terminal===true;},
};
