#!/usr/bin/env bun
import {account,config,saveAccount,selectAccount,installedBrowsers,ROOT,atomicJSON,accountDir} from '../src/chatgpt/accounts.ts';
import {classifyError} from '../src/chatgpt/monitor.ts';
import {existsSync,readFileSync} from 'node:fs';
import {call,runDaemon} from '../src/chatgpt/daemon.ts';

const argv=process.argv.slice(2), values=new Map<string,string>(),pos:string[]=[],files:string[]=[];
const valued=new Set(['reason','turns','index','maxItems','duration','maxChunks','maxBytes','timesliceMs','scope','cursor','locale','requestId','clientId','title','value','commit','mediaExport','maxRetries','account','output','archive','id','query','node','path','method','body','ref','epoch','selector','name','text','key','url','mode','width','height','x','y','dy','profile','browser','cdp','label','project','gpt','model','effort','conversation','section','limit','timeout','maxPages','pageSize','surface','message','interval','projectPath','file','source','reference','workspace','runId','version','catalog']);
let parseError:any;
try{
for(let i=0;i<argv.length;i++){if(argv[i].startsWith('--')){const [raw,inline]=argv[i].slice(2).split(/=(.*)/s),k=raw.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());let value=inline;if(value===undefined&&valued.has(k)){if(i+1>=argv.length)throw new Error('Missing --'+raw+' value');value=argv[++i];}value??='true';if(k==='file')files.push(value);else values.set(k,value);}else pos.push(argv[i]);}
}catch(error){parseError=error;}
const help=`ChatGPT — your website account, in the terminal
  queue add --conversation ID | --new --text TEXT [--file PATH] [--client-id KEY]
  queue list | status | pause | resume | run [--max-items N] [--jsonl]
  queue edit ID --text TEXT | remove ID | reorder ID --index N
  queue retry ID | reconcile ID
  Queue commands and the TUI share a durable local queue.
  Resume unpauses; run sends explicitly. Unknown outcomes require reconciliation.

  chatgpt                         Open the terminal workspace
  chatgpt login                   Open your account browser
  chatgpt status                  Browser, identity and index coverage
  chatgpt freeze [--reason TEXT]  STOP all site traffic now (durable; local reads keep working)
  chatgpt thaw | freeze status     Allow site traffic again | show the freeze state
  chatgpt gateway init|path|validate  One routed access point: dedupe, rate limits, protocol by config
  chatgpt accounts list|use|add    Account-scoped browser sessions
  chatgpt browsers                Discover installed browsers
  chatgpt browser start|stop|open|mode
  chatgpt conversations list|get|search|export|open|path
  chatgpt chat new|send --text TEXT [--conversation ID] [--model NAME]
  chatgpt chat stop|mode|model|effort|edit|branch|regenerate
  chatgpt projects list|get|chats
  chatgpt gpts list|get
  chatgpt settings get|open|map|set
  chatgpt takeout [--output PATH]    Resumable private archive
  chatgpt takeout status|audit [--archive DIR] [--output FILE]
  chatgpt invoices list|download|sync|watch
  chatgpt capabilities list
  chatgpt adapter get|validate|promote|rollback
  chatgpt monitor events|watch
  chatgpt models list              Website model catalog
  chatgpt voices list              Website voice catalog
  chatgpt ui snapshot|click|fill|key|text|mouse|scroll|upload|screenshot
  chatgpt media list|download --output PATH
  chatgpt flow validate|run|status   Declarative, resumable website flows
  chatgpt harness test --turns 6 --jsonl   Website tool-call integration test
  chatgpt harness run --text TEXT [--turns 8] [--jsonl]
  chatgpt harness list|status [--run-id ID]
  chatgpt online list [--limit N] | status REQUEST_ID [--include-raw]
  chatgpt runtime reload           Hot-load browser, actions and service
  chatgpt map network|scan              Observed website endpoints
  chatgpt api request --path /backend-api/…

  --account ID   --json   --output PATH
  ui references require --ref N --epoch SNAPSHOT_EPOCH
  APIPlan integration: apiplan chatgpt …
`;
async function main(){
 if(parseError)throw parseError;
 const a=account(values.get('account'));
 if((!pos.length&&!values.has('help'))||pos[0]==='tui'){const {runTui}=await import('../src/chatgpt/tui-host.ts');await runTui(a.id,{mock:values.has('mock'),mode:values.get('mode') as any,model:values.get('model'),effort:values.get('effort')});return;}
 if(values.has('help')||pos[0]==='help'){console.log(help);return;}
 if(pos[0]==='autostart'){const helpers=await import('../src/chatgpt/autostart.ts');const action=pos[1]||'status';if(!['install','status','uninstall'].includes(action))throw new Error('Use autostart install, status or uninstall.');console.log(JSON.stringify(await helpers[action](a),null,2));return;}
 if(['setup','doctor','install'].includes(pos[0])){const helpers=await import('../src/chatgpt/setup.ts');console.log(JSON.stringify(await helpers[pos[0]]({account:a.id}),null,2));return;}
 if(pos[0]==='_daemon'){await runDaemon(a,!values.has('headed'));return;}
 if(pos[0]==='browsers'){console.log(JSON.stringify(installedBrowsers(),null,2));return;}
 if(pos[0]==='accounts'){
  let r:any;
  if(pos[1]==='list')r=config();
  else if(pos[1]==='use')r=selectAccount(pos[2]);
  else if(pos[1]==='add'){r={id:pos[2],label:values.get('label')||pos[2],baseURL:'https://chatgpt.com',created:new Date().toISOString(),profilePath:values.get('profile'),browserPath:values.get('browser'),cdpURL:values.get('cdp'),workspace:values.get('workspace'),source:{provider:values.get('source')||(values.has('cdp')?'browser':'managed'),reference:values.get('reference')}};saveAccount(r);}
  else throw new Error('Use accounts list, use ID, or add ID.');console.log(JSON.stringify(r,null,2));return;
 }
 const args:any=Object.fromEntries(values);for(const k of ['turns','index','maxItems','duration','maxChunks','maxBytes','timesliceMs','ref','width','height','x','y','dy','limit','timeout','maxPages','pageSize'])if(k in args)args[k]=Number(args[k]);
 if(args.body)args.body=JSON.parse(args.body);if(files.length)args.files=files;for(const k of ['all','original','fullText','binary','resume','dryRun','acknowledge','includeRaw','allowWrite'])if(k in args)args[k]=args[k]!=='false';
 if(values.has('headed'))args.headless=false;
 if(values.has('headless'))args.headless=true;
 if(values.has('new'))args.new=true;
 if(values.has('archived'))args.archived=values.has('all')?'all':true;else if(values.has('all'))args.archived='all';
 let op=pos[0]||'help';
 if(op==='login'){op='browser.start';args.headless=false;}
 else if(op==='status'){}
 else if(op==='freeze'){if(pos[1]==='status')op='freeze.status';else{op='freeze.set';args.frozen=true;args.by='cli';}}
 else if(op==='thaw'){op='freeze.set';args.frozen=false;args.by='cli';}
 else if(op==='gateway'){
  // The config file IS the switch: writing it turns the gateway on, deleting it returns to shipped behaviour.
  const {BUILTIN_GATEWAY,gatewayConfigPath,validateGatewayConfig}=await import('../src/chatgpt/gateway-policy.ts');
  const path=gatewayConfigPath(a.id);
  if(pos[1]==='init'){
   if(existsSync(path)&&!values.has('force'))throw new Error('gateway.json already exists at '+path+'; pass --force to overwrite it.');
   atomicJSON(path,BUILTIN_GATEWAY);
   console.log(JSON.stringify({path,wrote:'built-in defaults',note:'Traffic now routes through the gateway. Behaviour is unchanged until you edit this file. Delete it to go back.'},null,2));return;
  }
  if(pos[1]==='path'){console.log(JSON.stringify({path,exists:existsSync(path)},null,2));return;}
  if(pos[1]==='validate'){
   const target=values.get('path')||path;
   if(!existsSync(target)){console.log(JSON.stringify({path:target,exists:false,active:'built-in defaults (gateway not installed)'},null,2));return;}
   const result=validateGatewayConfig(JSON.parse(readFileSync(target,'utf8')));
   console.log(JSON.stringify({path:target,...result},null,2));
   if(!(result as any).ok)process.exitCode=1;
   return;
  }
  throw new Error('Use gateway init, gateway path, or gateway validate [--path FILE].');
 }
 else if(op==='takeout'){op='takeout.'+(pos[1]||'run');}
 else if(op==='help'){console.log(help);return;}
 else {op+='.'+(pos[1]||'list');if(pos[0]==='audio'&&pos[1]==='output')op+='.'+(pos[2]||'status');if(pos[2]&&!args.id)args.id=pos[2];if(pos[0]==='conversations'&&pos[1]==='open')args.conversation=args.id;if(pos[0]==='conversations'&&pos[1]==='search')args.query=pos.slice(2).join(' ');if(pos[0]==='browser'&&pos[1]==='mode')args.mode=pos[2]||args.mode;if(pos[0]==='ui'&&pos[1]==='upload')args.files=pos.slice(2);}
 if(pos[0]==='chat'&&['new','send'].includes(pos[1])&&!args.text){args.text=pos.slice(2).join(' ');if(!args.text&&!process.stdin.isTTY)args.text=await new Response(Bun.stdin.stream()).text();}
 if(op==='queue.add'&&!args.text&&!args.files?.length&&!process.stdin.isTTY)args.text=await new Response(Bun.stdin.stream()).text();
 if(pos[0]==='flow'&&['run','validate'].includes(pos[1]))args.path||=pos[2];
 const r=op==='takeout.watch-status'?await (await import('../src/chatgpt/takeout-supervisor.ts')).readTakeoutWatchStatus(accountDir(a),args.archive):await call(a,op,args,e=>{if(values.has('jsonl'))console.log(JSON.stringify({event:e}));else if(e.type==='text'&&!values.has('json'))process.stderr.write(e.text);});
 if(op==='harness.test'&&r?.verification?.complete!==true)process.exitCode=1;
 if(args.output&&!['audio.output.capture','media.download','media.export','media.audit','ui.screenshot','conversations.export','takeout.run','invoices.download'].includes(op)){atomicJSON(args.output,r);console.log(JSON.stringify({path:args.output}));}else console.log(JSON.stringify(values.has('jsonl')?{result:r}:r,null,values.has('jsonl')?0:2));
}
main().catch(e=>{process.stderr.write(JSON.stringify({...classifyError(e),...(e.code?{code:e.code,...(e.action?{action:e.action}:{})}:{} )})+'\n');process.exitCode=1;});
