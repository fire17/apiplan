import {expect,test} from 'bun:test';
import {preparationEvidence,waitHarnessSurfaceReady} from '../src/chatgpt/harness-web.ts';

// The 2026-09-15 preparation timeouts recorded only controlCount:2 against a loaded page's 61. That proved the
// app never rendered but left what the site actually served unknowable after the fact. These tests pin the
// evidence a timeout must carry, and pin the privacy rule: never the page text, only its length and which
// known markers matched.

const loadedPage={url:'https://chatgpt.com/?model=gpt-5-6',title:'ChatGPT',text:'Ask anything',harnessDOM:{visibilityState:'visible',hidden:false}};
const composer={id:'prompt-textarea',role:'textbox',name:'Chat with ChatGPT',disabled:false};
const chatRadio={role:'radio',name:'Chat',disabled:false};

test('evidence names the page and the controls that do exist',()=>{
 const evidence=preparationEvidence(loadedPage,[composer,chatRadio]);
 expect(evidence.url).toBe('https://chatgpt.com/');// query string dropped: it can carry identifiers
 expect(evidence.title).toBe('ChatGPT');
 expect(evidence.textLength).toBe('Ask anything'.length);
 expect(evidence.controlNames).toEqual(['prompt-textarea|textbox|Chat with ChatGPT','radio|Chat']);
 expect(evidence.pageMarkers).toBeUndefined();
});

test('known interstitials are flagged by marker name, never by storing the text',()=>{
 const challenge={url:'https://chatgpt.com/',title:'Just a moment…',text:'Verify you are human before continuing. Unusual activity detected.',harnessDOM:{visibilityState:'visible',hidden:false}};
 const evidence=preparationEvidence(challenge,[{role:'button',name:'Verify'}]);
 expect(evidence.pageMarkers).toContain('human-verification');
 expect(evidence.pageMarkers).toContain('unusual-activity');
 expect(JSON.stringify(evidence)).not.toContain('Verify you are human');
 expect(evidence.textLength).toBe(challenge.text.length);
 for(const [page,marker] of [
  [{text:'Too many requests, try again later'},'rate-limited'],
  [{text:'Log in or Sign up to continue'},'signed-out'],
  [{text:'Something went wrong.'},'site-error'],
 ] as [any,string][])expect(preparationEvidence(page,[]).pageMarkers).toContain(marker);
});

test('a missing or malformed snapshot degrades to empty evidence instead of throwing',()=>{
 for(const page of [undefined,null,{},{text:42,url:7,title:{}}] as any[]){
  const evidence=preparationEvidence(page,[]);
  expect(evidence.textLength).toBe(0);
  expect(evidence.controlNames).toEqual([]);
  expect(evidence.url).toBeUndefined();
 }
});

test('a real timeout carries the evidence on the thrown fault, and a ready surface returns it',async()=>{
 let ticks=0;
 const blankPage={url:'https://chatgpt.com/',title:'ChatGPT',text:'',harnessDOM:{visibilityState:'visible',hidden:false},controls:[{role:'link',name:'Skip to content'},{role:'button',name:'Open sidebar'}]};
 let clock=0;
 const failure=await waitHarnessSurfaceReady(async()=>blankPage,'Chat',false,{
  now:()=>clock,sleep:async()=>{clock+=150;ticks++;},timeout:450,
 }).catch((error:any)=>error);
 expect(failure).toBeInstanceOf(Error);
 expect(failure.code).toBe('HARNESS_PREPARATION_TIMEOUT');
 // This is the shape the 2026-09-15 receipts lacked: the two controls are now named.
 expect(failure.preparation).toMatchObject({
  composerReady:false,requestedModeReady:false,requestedMode:'Chat',controlCount:2,
  visibilityState:'visible',hidden:false,title:'ChatGPT',textLength:0,
  controlNames:['link|Skip to content','button|Open sidebar'],
 });
 expect(ticks).toBeGreaterThan(0);
 const ready=await waitHarnessSurfaceReady(async()=>({...loadedPage,controls:[composer,chatRadio]}),'Chat',false,{now:()=>0,sleep:async()=>{},timeout:450});
 expect(ready).toMatchObject({composerReady:true,requestedModeReady:true,controlCount:2,title:'ChatGPT'});
});
