import {afterAll,expect,test} from 'bun:test';
import {readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const TEST_HOME=join(tmpdir(),`apiplan-chatgpt-import-${process.pid}`);
process.env.CHATGPT_HOME=TEST_HOME;
afterAll(()=>rmSync(TEST_HOME,{recursive:true,force:true}));

const source=join(import.meta.dir,'../../src/chatgpt');

test('every production TypeScript module imports in one isolated process',async()=>{
 const files=readdirSync(source).filter(file=>file.endsWith('.ts')&&!file.endsWith('.test.ts')).sort();
 const results=await Promise.allSettled(files.map(file=>import(pathToFileURL(join(source,file)).href)));
 const failures=results.flatMap((result,index)=>result.status==='rejected'?[{file:files[index],reason:String(result.reason?.stack||result.reason)}]:[]);
 expect(failures).toEqual([]);
 expect(files).toContain('voice.ts');
 expect(files).toContain('service.ts');
 expect(files).toContain('daemon.ts');
});

test('every Python worker module compiles without importing browser dependencies',async()=>{
 const python=process.env.CHATGPT_PYTHON||Bun.which('python3');expect(python).toBeTruthy();
 const script="import pathlib,sys; root=pathlib.Path(sys.argv[1]); files=sorted(root.glob('*.py')); [compile(p.read_bytes(),str(p),'exec') for p in files]; print(len(files))";
 const child=Bun.spawn([python!,'-c',script,source],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(code!==0)throw new Error(stderr);
 expect(Number(stdout.trim())).toBeGreaterThanOrEqual(3);
});
