import {expect,test} from 'bun:test';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';

test('authentication reads are bounded and recover only the dedicated identity-matched tab',()=>{
 const helper=join(import.meta.dir,'helpers/chatgpt-browser-session-suite.py');
 const source=join(import.meta.dir,'../src/chatgpt/browser.py');
 const result=Bun.spawnSync(['python3',helper,source],{stderr:'pipe'});
 expect(new TextDecoder().decode(result.stderr)).toBe('');
 expect(result.exitCode).toBe(0);
});

test('backend and binary asset reads bound authentication before dispatch and pin bulk stream state',()=>{
 const browser=readFileSync(join(import.meta.dir,'../src/chatgpt/browser.py'),'utf8');
 const assets=readFileSync(join(import.meta.dir,'../src/chatgpt/asset_stream.py'),'utf8');
 expect(browser).toContain("authTimer=setTimeout(()=>authController.abort(),5000)");
 expect(browser).toContain("requestTimer=setTimeout(()=>requestController.abort(),30000)");
 expect(browser).toContain("'Browser backend read timed out.'");
 expect(assets).toContain('tab = worker.api_tab');
 expect(assets).toContain("authTimer=setTimeout(()=>authController.abort(),5000)");
 expect(assets).toContain("headerTimer=setTimeout(()=>controller.abort(),30000)");
 expect(assets.match(/worker\.api_tab/g)?.length).toBe(1);
});
