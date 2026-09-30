import {test,expect} from 'bun:test';
import {mkdtempSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {freshRevision} from '../src/chatgpt/fresh.ts';

const harnessModules=['harness-run','harness-web','conversation-harness','harness-protocol','harness-verify'];

test('one composite harness revision invalidates after every atomic dependency replacement',()=>{
 const directory=mkdtempSync(join(tmpdir(),'chatgpt-fresh-'));
 try{
  for(const [index,name] of harnessModules.entries())writeFileSync(join(directory,name+'.ts'),'export const revision='+index+';\n');
  let previous=freshRevision('harness-run',directory);
  expect(new Set(harnessModules.map(name=>freshRevision(name,directory)))).toEqual(new Set([previous]));
  for(const [index,name] of harnessModules.entries()){
   const replacement=join(directory,'.replacement-'+index);writeFileSync(replacement,'export const revision="changed-'+index+'";\n');renameSync(replacement,join(directory,name+'.ts'));
   const next=freshRevision('harness-run',directory);expect(next).not.toBe(previous);expect(new Set(harnessModules.map(module=>freshRevision(module,directory)))).toEqual(new Set([next]));previous=next;
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});


test('online requests reload one composite graph when wire, runtime or harness changes',()=>{
 const directory=mkdtempSync(join(tmpdir(),'chatgpt-online-fresh-'));
 const modules=[...harnessModules,'online-runtime','online-wire'];
 try{
  for(const name of modules)writeFileSync(join(directory,name+'.ts'),'export const revision=1;\n');
  let previous=freshRevision('online-runtime',directory);
  expect(freshRevision('online-wire',directory)).toBe(previous);
  for(const name of modules){
   writeFileSync(join(directory,name+'.ts'),'export const revision=2;\n');
   const next=freshRevision('online-runtime',directory);expect(next).not.toBe(previous);expect(freshRevision('online-wire',directory)).toBe(next);previous=next;
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});
