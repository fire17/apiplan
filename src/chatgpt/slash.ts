import {resolve} from 'node:path';
export const serviceOperations:string[]=["freeze.set", "freeze.status", "harness.run", "harness.test", "harness.status", "harness.list", "online.list", "online.status", "account.get", "adapter.get", "adapter.promote", "adapter.rollback", "adapter.validate", "api.request", "audio.clear", "audio.input", "audio.output.arm", "audio.output.capture", "audio.output.read", "audio.output.status", "audio.output.stop", "audio.outputs", "audio.play", "audio.status", "browser.mode", "browser.open", "browser.start", "browser.stop", "capabilities.list", "chat.branch", "chat.edit", "chat.effort", "chat.mode", "chat.model", "chat.new", "chat.reconcile", "chat.regenerate", "chat.send", "chat.stop", "connectors.list", "conversations.archive", "conversations.cached", "conversations.export", "conversations.get", "conversations.list", "conversations.open", "conversations.path", "conversations.pin", "conversations.rename", "conversations.search", "conversations.share", "conversations.unarchive", "conversations.unpin", "conversations.unshare", "dictation.controls", "dictation.start", "dictation.stop", "dictation.transcribe", "features.list", "flow.run", "flow.status", "flow.validate", "gpts.bootstrap", "gpts.catalog", "gpts.get", "gpts.list", "gpts.owned", "invoices.download", "invoices.list", "invoices.sync", "invoices.unwatch", "invoices.watch", "invoices.watcher", "map.capabilities", "map.network", "map.request", "map.response", "map.scan", "media.audit", "media.download", "media.export", "media.list", "models.list", "models.options", "monitor.events", "monitor.watch", "pins.list", "plugins.list", "projects.chats", "projects.get", "projects.list", "queue.add", "queue.edit", "queue.list", "queue.pause", "queue.reconcile", "queue.remove", "queue.reorder", "queue.resume", "queue.retry", "queue.run", "queue.status", "receipts.get", "receipts.list", "runtime.reload", "settings.get", "settings.instructions", "settings.map", "settings.open", "settings.set", "status", "surface.activate", "surface.close", "surface.open", "takeout.audit", "takeout.pause", "takeout.resume", "takeout.run", "takeout.status", "takeout.unwatch", "takeout.watch", "takeout.watch-status", "tasks.list", "thinking.expand", "ui.click", "ui.fill", "ui.focus", "ui.hover", "ui.inspect", "ui.key", "ui.mouse", "ui.screenshot", "ui.scroll", "ui.snapshot", "ui.text", "ui.upload", "ui.viewport", "voice.controls", "voice.start", "voice.stop", "voices.list"];
export const localCommands:string[]=["freeze", "thaw", "help", "commands", "model", "effort", "mode", "queue", "new", "send", "stop", "quit", "attach", "attachments", "media", "thinking", "search", "conversations", "projects", "gpts", "account", "accounts", "browser", "inspect", "refresh", "reconcile", "message", "action", "monitor"];
const valued=new Set<string>(['turns','index','maxItems','duration','maxChunks','maxBytes','timesliceMs','scope','cursor','locale','requestId','clientId','title','value','commit','mediaExport','maxRetries','account','output','archive','id','query','node','path','method','body','ref','epoch','selector','name','text','key','url','mode','width','height','x','y','dy','profile','browser','cdp','label','project','gpt','model','effort','conversation','section','limit','timeout','maxPages','pageSize','surface','message','interval','projectPath','file','source','reference','workspace','runId','version','catalog']);

const booleans=new Set(['all','original','fullText','binary','resume','dryRun','acknowledge','new','headed','headless','archived','json','jsonl','cached','includeRaw','discover','force','mock']);
const numeric=new Set(['turns','index','maxItems','duration','maxChunks','maxBytes','timesliceMs','ref','width','height','x','y','dy','limit','timeout','maxPages','pageSize','maxRetries','interval']);
export type SlashInvocation={kind:'message';text:string}|{kind:'local';command:string;args:Record<string,any>;positionals:string[]}|{kind:'operation';operation:string;args:Record<string,any>};
const fail=(message:string):never=>{throw Object.assign(new Error(message),{code:'SLASH_INVALID'});};
/** Literal shell-like quoting only: never evaluates variables, substitutions, or executable text. */
export function tokenizeSlash(input:string):string[]{
 const words:string[]=[];let word='',quote='',started=false;
 for(let i=0;i<input.length;i++){
  const ch=input[i];
  if(quote==="'"){if(ch==="'")quote='';else word+=ch;continue;}
  if(quote==='"'){
   if(ch==='"'){quote='';continue;}
   if(ch==='\\'&&i+1<input.length&&['"','\\','$','`','\n'].includes(input[i+1])){const next=input[++i];if(next!=='\n')word+=next;continue;}
   word+=ch;continue;
  }
  if(ch==='"'||ch==="'"){quote=ch;started=true;continue;}
  if(ch==='\\'){if(i+1>=input.length)fail('Trailing escape in slash command.');const next=input[++i];if(next!=='\n')word+=next;started=true;continue;}
  if(/\s/.test(ch)){if(started){words.push(word);word='';started=false;}continue;}
  word+=ch;started=true;
 }
 if(quote)fail('Unclosed quote in slash command.');if(started)words.push(word);return words;
}
function argumentsFor(words:string[]){
 const args:Record<string,any>={},positionals:string[]=[];let literal=false;
 for(let i=0;i<words.length;i++){
  const token=words[i];if(token==='--'&&!literal){literal=true;continue;}
  if(literal||!token.startsWith('--')){positionals.push(token);continue;}
  const equal=token.indexOf('='),raw=token.slice(2,equal<0?undefined:equal),key=raw.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
  if(!valued.has(key)&&!booleans.has(key))fail('Unknown option --'+raw+'. Use /help to inspect command syntax.');
  let value:any=equal<0?undefined:token.slice(equal+1);
  if(valued.has(key)&&value===undefined){if(i+1>=words.length)fail('Missing value for --'+raw+'.');value=words[++i];}
  if(booleans.has(key)){if(value===undefined)value=true;else if(value==='true'||value==='false')value=value==='true';else fail('--'+raw+' accepts true or false.');}
  if(numeric.has(key)){value=Number(value);if(!Number.isFinite(value))fail('--'+raw+' requires a finite number.');}
  if(key==='file'){(args.files??=[]).push(resolve(value));continue;}
  if(Object.hasOwn(args,key))fail('Repeated --'+raw+' option. Repeat --file for multiple attachments.');
  args[key]=value;
 }
 if(args.body!==undefined){try{args.body=JSON.parse(args.body);}catch{fail('--body must contain valid JSON.');}}
 if(args.headed===true&&args.headless===true)fail('Choose headed or headless, not both.');
 if(args.headed===true)args.headless=false;delete args.headed;
 return {args,positionals};
}
export function parseSlash(input:string,locals:string[]=localCommands):SlashInvocation|null{
 const source=input.trimStart();if(!source.startsWith('/'))return null;
 if(source.startsWith('//'))return {kind:'message',text:input.slice(0,input.length-source.length)+source.slice(1)};
 const tokens=tokenizeSlash(source.slice(1));if(!tokens.length)return {kind:'local',command:'help',args:{},positionals:[]};
 const first=tokens[0].toLowerCase();let operation:string|undefined,consumed=0;
 if(first==='run'){
  operation=tokens[1];consumed=2;if(!operation||!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(operation))fail('/run needs an explicit operation, such as /run models.list.');
 }else{
  for(let n=Math.min(3,tokens.length);n>0;n--){const candidate=tokens.slice(0,n).join('.').toLowerCase();if(serviceOperations.includes(candidate)){operation=candidate;consumed=n;break;}}
 }
 if(!operation){if(!locals.includes(first))fail('Unknown slash command /'+first+'. Use /help; nothing was sent.');const {args,positionals}=argumentsFor(tokens.slice(1));return {kind:'local',command:first,args,positionals};}
 const {args,positionals}=argumentsFor(tokens.slice(consumed));
 if(args.account!==undefined)fail('Switch the TUI account with /account before running an operation.');
 if(['chat.send','chat.new','queue.add'].includes(operation)){if(positionals.length){if(args.text!==undefined)fail('Supply message text once, as words or --text.');args.text=positionals.join(' ');}}
 else if(operation==='conversations.search'){if(positionals.length){if(args.query!==undefined)fail('Supply a search query once.');args.query=positionals.join(' ');}}
 else if(operation==='ui.upload'){args.files=[...(args.files||[]),...positionals.map(path=>resolve(path))];}
 else if(positionals.length){
  if(positionals.length>1)fail('Unexpected extra positional arguments. Quote a value containing spaces or use named options.');
  const fields:Record<string,string>={'flow.run':'path','flow.validate':'path','flow.status':'runId','settings.open':'section','chat.mode':'mode','chat.model':'model','chat.effort':'effort','browser.mode':'mode','browser.open':'url','ui.key':'key','ui.text':'text','audio.input':'path','dictation.transcribe':'path'};
  const key=fields[operation]||'id';if(args[key]!==undefined)fail('Supply '+key+' only once.');args[key]=positionals[0];
 }
 if(operation==='conversations.open')args.conversation??=args.id;
 if(operation==='conversations.list'&&args.all===true)args.archived='all';
 return {kind:'operation',operation,args};
}
export function slashCommands(locals:string[]=localCommands){return [...locals.map(name=>({name,description:'Open '+name+' controls'})),...serviceOperations.map(name=>({name,description:name.replaceAll('.',' · ')})),{name:'run',description:'Run an explicitly named service operation'}];}
