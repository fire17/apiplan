// Chat vs Work as an explicit, per-invocation CLI choice on `astra` (2026-09-16).
//
// The bug this exists to prevent: `astra` posts to the Codex responses backend, which has
// no mode concept at all, so changing the desktop app's Chat/Work toggle could never
// affect it. A mode flag that only reached the argument parser would reproduce exactly
// that failure one layer higher — which is why every test here follows the mode all the
// way down to the `selection` block the website driver is actually handed.
//
// No network and no site traffic: the parser is pure, and the online provider's `build()`
// is pure, so the whole contract is checkable against a synthetic account in a temp dir.
import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseArgs,providerCanUseWarmDaemon} from '../src/engine.ts';

const ROOT=join(import.meta.dir,'..');
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

/** A signed-in website account that exists only for this test. */
function home(){
 const root=mkdtempSync(join(tmpdir(),'astra-mode-'));roots.push(root);mkdirSync(root,{recursive:true});
 writeFileSync(join(root,'accounts.json'),JSON.stringify({version:1,selected:'probe',accounts:[{
  id:'probe',label:'Probe',baseURL:'https://chatgpt.com',cdpURL:'http://127.0.0.1:9222',
  userId:'user-probe',workspace:'space',created:'2026-09-16T00:00:00.000Z',
 }]}));
 return root;
}

async function run(argv:string[],env:Record<string,string>={}){
 const child=Bun.spawn(['bun',join(ROOT,'bin','ask.ts'),...argv],
  {cwd:ROOT,env:{...process.env,...env},stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,exit]=await Promise.all([
  new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 return {stdout,stderr,exit};
}

async function probe(route:string,mode:string,effort='low'){
 const child=Bun.spawn(['bun',join(import.meta.dir,'helpers','astra-mode-probe.ts'),route,mode,effort],
  {cwd:ROOT,env:{...process.env,CHATGPT_HOME:home()},stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,exit]=await Promise.all([
  new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect(exit,stderr).toBe(0);
 return JSON.parse(stdout);
}

describe('mode parsing',()=>{
 test('no flag means no mode, so the established default is untouched',()=>{
  const o=parseArgs(['-m','astra','hello','there']);
  expect(o.mode).toBeUndefined();
  expect(o.prompt).toEqual(['hello','there']);
 });

 test.each([['--chatmode','chat'],['--chat-mode','chat'],['--work','work'],['--workmode','work'],['--work-mode','work']])
  ('%s → mode %s',(flag,mode)=>{
   expect(parseArgs(['-m','astra',flag,'hello there']).mode).toBe(mode);
  });

 test.each([['--mode','chat'],['--mode','work']])('%s %s is the same choice by another name',(flag,value)=>{
  expect(parseArgs(['-m','astra',flag,value,'hi']).mode).toBe(value);
  expect(parseArgs(['-m','astra',`${flag}=${value}`,'hi']).mode).toBe(value);
 });

 test('the prompt survives the flag, in either position',()=>{
  expect(parseArgs(['-m','astra','--chatmode','hello','there']).prompt).toEqual(['hello','there']);
  expect(parseArgs(['-m','astra','hello','there','--chatmode']).prompt).toEqual(['hello','there']);
  expect(parseArgs(['-m','astra','--mode','chat','hello']).prompt).toEqual(['hello']);
 });

 // Argument order deciding a billing-relevant surface is exactly the silent failure the
 // brief forbids, so contradictions are refused by name rather than resolved.
 test.each([
  [['--chatmode','--work'],'--chatmode','--work'],
  [['--work','--chatmode'],'--work','--chatmode'],
  [['--chatmode','--mode','work'],'--chatmode','--mode work'],
  [['--mode','chat','--work'],'--mode chat','--work'],
 ])('%p is refused, naming both sides',(flags,first,second)=>{
  expect(()=>parseArgs(['-m','astra',...flags as string[],'hi'])).toThrow(
   `choose one mode: ${first} and ${second} contradict each other.`);
 });

 test('repeating ONE mode is not a contradiction',()=>{
  expect(parseArgs(['-m','astra','--chatmode','--chatmode','hi']).mode).toBe('chat');
  expect(parseArgs(['-m','astra','--work','--mode','work','hi']).mode).toBe('work');
 });

 test('an unknown mode is named, not guessed at',()=>{
  expect(()=>parseArgs(['-m','astra','--mode','bogus','hi'])).toThrow("--mode takes chat or work, not 'bogus'.");
 });

 // Two independent settings. A mode must never imply, change, or downgrade an effort.
 test('mode and effort are orthogonal',()=>{
  for(const mode of ['--chatmode','--work'])for(const effort of ['low','medium','high','xhigh','max']){
   const o=parseArgs(['-m','astra',mode,'--effort',effort,'hi']);
   expect(o.effort).toBe(effort);
   expect(o.mode).toBe(mode==='--chatmode'?'chat':'work');
  }
 });

 // `--chat` has meant "JSON messages array on stdin" since long before modes existed.
 test('the pre-existing --chat flag keeps its meaning and gains no mode',()=>{
  const o=parseArgs(['-m','astra','--chat','--session','shell-thread-7']);
  expect(o.chat).toBe(true);
  expect(o.mode).toBeUndefined();
  expect(parseArgs(['-m','astra','--chatmode','hi']).chat).toBe(false);
 });
});

describe('the mode reaches the website transport, and may only agree with it',()=>{
 test('each route keeps its own composer mode when none is requested',async()=>{
  expect((await probe('online/chat','none')).selection).toEqual({mode:'Chat',model:'Latest',effort:'Instant'});
  expect((await probe('online/astra','none')).selection).toEqual({mode:'Work',model:'GPT-6 Astra',effort:'Light'});
 });

 test('an explicitly requested mode that matches the route is carried through',async()=>{
  expect((await probe('online/chat','chat')).selection).toEqual({mode:'Chat',model:'Latest',effort:'Instant'});
  expect((await probe('online/astra','work')).selection).toEqual({mode:'Work',model:'GPT-6 Astra',effort:'Light'});
 });

 // The worst outcome this provider can produce is a Chat/Latest answer wearing an Astra
 // receipt, so a mode the route cannot serve fails instead of quietly picking the model
 // the other mode does offer.
 test('a mode the route cannot serve is refused, never substituted',async()=>{
  const chatOnAstra=await probe('online/astra','chat');
  expect(chatOnAstra.selection).toBeUndefined();
  expect(chatOnAstra.error.code).toBe('MODE_UNAVAILABLE');
  expect(chatOnAstra.error.message).toContain('Work mode only');

  const workOnChat=await probe('online/chat','work');
  expect(workOnChat.selection).toBeUndefined();
  expect(workOnChat.error.code).toBe('MODE_UNAVAILABLE');
 });

 test('an effort the website does not expose still fails rather than quietly dropping',async()=>{
  expect((await probe('online/chat','chat','high')).error.code).toBe('UNSUPPORTED_EFFORT');
 });
});

describe('the installed command routes, and says so on stderr',()=>{
 test('no flag still posts to the Codex responses backend as gpt-6-astra',async()=>{
  const {stdout,stderr,exit}=await run(['--model','astra','--dry-run','hello there']);
  expect(exit).toBe(0);
  const request=JSON.parse(stdout);
  expect(request.url).toBe('https://chatgpt.com/backend-api/codex/responses');
  expect(request.body.model).toBe('gpt-6-astra');
  expect(stderr).not.toContain('mode=');
 });

 test('--work is the same request, said out loud',async()=>{
  const bare=JSON.parse((await run(['--model','astra','--dry-run','hello there'])).stdout);
  const {stdout,stderr,exit}=await run(['--model','astra','--work','--dry-run','hello there']);
  expect(exit).toBe(0);
  const work=JSON.parse(stdout);
  expect(work.url).toBe(bare.url);
  expect(work.body.model).toBe(bare.body.model);
  expect(work.body.input).toEqual(bare.body.input);
  expect(stderr).toContain('mode=work');
 });

 test('--chatmode re-routes to the website Chat composer and announces the change',async()=>{
  const {stdout,stderr,exit}=await run(['--model','astra','--chatmode','--dry-run','hello there'],
   {CHATGPT_HOME:home()});
  expect(exit).toBe(0);
  const request=JSON.parse(stdout);
  expect(request.url).toBe('apiplan-online://website/generate');
  expect(request.body.model).toBe('online-chat-latest');
  expect(request.body.selection).toEqual({mode:'Chat',model:'Latest',effort:'Instant'});
  // The re-route is a different model as well as a different surface. Saying so on stderr
  // is what keeps it from being a silent substitution; stdout stays pipeable.
  expect(stderr).toContain("does not offer 'astra'");
  expect(stderr).toContain('DIFFERENT model');
  expect(stderr).toContain('mode=chat');
  expect(stdout).not.toContain('mode=chat');
 });

 // Chat/Work belong to ChatGPT. Routing another vendor's command to chatgpt.com because a
 // mode flag was present would send the prompt to an account the command never named.
 test.each([['opus','anthropic'],['gemini','google'],['grok','grok']])
  ('--chatmode on %s (a %s model) is refused, not redirected',async(model,provider)=>{
   const {stdout,stderr,exit}=await run(['--model',model,'--chatmode','--dry-run','hi']);
   expect(exit).toBe(1);
   expect(stdout).toBe('');
   expect(stderr).toContain(`${provider} model and has no Chat/Work setting`);
   expect(stderr).not.toContain('online/chat');
  });

 test('the same guard applies to --work',async()=>{
  const {stderr,exit}=await run(['--model','opus','--work','--dry-run','hi']);
  expect(exit).toBe(1);
  expect(stderr).toContain('--work is a ChatGPT composer mode');
 });

 test('contradictory selectors exit nonzero with one clear line and no stack trace',async()=>{
  const {stdout,stderr,exit}=await run(['--model','astra','--chatmode','--work','hello there']);
  expect(exit).toBe(1);
  expect(stdout).toBe('');
  expect(stderr).toContain('choose one mode: --chatmode and --work contradict each other.');
  expect(stderr).not.toContain('at <anonymous>');
 });

 // A long-running daemon started before this feature existed would happily serve a
 // Chat-mode request with pre-mode code and no mode guard. It cannot: the website
 // provider is excluded from the warm daemon outright, so `--chatmode` always executes
 // in-process, against whatever code is on disk right now.
 test('the website route can never be served by a stale warm daemon',()=>{
  expect(providerCanUseWarmDaemon({provider:'online'})).toBe(false);
  expect(providerCanUseWarmDaemon({provider:'openai'})).toBe(true);
 });

 // The MODE_UNAVAILABLE guard must be reachable from the real command, not only from a
 // unit probe: an explicit -m online/... route is deliberately left as typed, so this is
 // the path where a mode and a route can actually disagree in production.
 test('an explicit website route whose mode disagrees fails through the real command',async()=>{
  const chatRouteWorkMode=await run(['-m','online/chat','--work','--dry-run','hi'],{CHATGPT_HOME:home()});
  expect(chatRouteWorkMode.exit).toBe(1);
  expect(chatRouteWorkMode.stderr).toContain("offers 'Latest' in Chat mode only");
  expect(chatRouteWorkMode.stdout).toBe('');

  const astraRouteChatMode=await run(['-m','online/astra','--chatmode','--dry-run','hi'],{CHATGPT_HOME:home()});
  expect(astraRouteChatMode.exit).toBe(1);
  expect(astraRouteChatMode.stderr).toContain('Work mode only');
 });

 test('an explicit website route whose mode AGREES is carried through',async()=>{
  const {stdout,exit}=await run(['-m','online/astra','--work','--dry-run','hi'],{CHATGPT_HOME:home()});
  expect(exit).toBe(0);
  expect(JSON.parse(stdout).body.selection).toEqual({mode:'Work',model:'GPT-6 Astra',effort:'Light'});
 });

 // The two flags sit one word apart and people will type both. They are independent and
 // must compose: --chat supplies the turns, --chatmode supplies the surface.
 test('--chat and --chatmode compose instead of fighting',async()=>{
  const child=Bun.spawn(['bun',join(ROOT,'bin','ask.ts'),'-m','astra','--chat','--chatmode','--dry-run'],
   {cwd:ROOT,env:{...process.env,CHATGPT_HOME:home()},stdin:new TextEncoder().encode('[{"role":"user","content":"hi there"}]'),stdout:'pipe',stderr:'pipe'});
  const [stdout,,exit]=await Promise.all([
   new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(exit).toBe(0);
  const body=JSON.parse(stdout).body;
  expect(body.model).toBe('online-chat-latest');
  expect(body.selection).toEqual({mode:'Chat',model:'Latest',effort:'Instant'});
  expect(body.turns).toEqual([{role:'user',text:'hi there'}]);
 });

 test('--mode with nothing after it is named, not silently ignored',async()=>{
  const {stderr,exit}=await run(['-m','astra','--mode']);
  expect(exit).toBe(1);
  expect(stderr).toContain('--mode takes chat or work');
 });

 test('with no model at all, the model error speaks — not a route=undefined line',async()=>{
  const {stderr,exit}=await run(['--chatmode','--dry-run','hi']);
  expect(exit).toBe(1);
  expect(stderr).not.toContain('route=undefined');
  expect(stderr).toContain('no model');
 });

 test('an effort the chosen mode cannot serve fails loudly instead of downgrading',async()=>{
  const {stderr,exit}=await run(['--model','astra','--chatmode','--effort','high','hi'],
   {CHATGPT_HOME:home()});
  expect(exit).toBe(1);
  expect(stderr).toContain("effort 'high' is not available");
  expect(stderr).toContain('valid: low');
 });
});
