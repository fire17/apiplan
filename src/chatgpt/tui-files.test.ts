import {expect,test} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {attachmentPath,mediaReference} from './tui-files.ts';
import {LocalQueue} from './tui-queue.ts';
test('attachments validate local files and reject empty files or directories',async()=>{
 const root=await mkdtemp(join(tmpdir(),'tui-files-'));
 try{const path=join(root,'fixture.png');await writeFile(path,'fixture');expect(await attachmentPath(path)).toEndWith('/fixture.png');await expect(attachmentPath(root)).rejects.toThrow('regular file');await writeFile(path,'');await expect(attachmentPath(path)).rejects.toThrow('empty');}finally{await rm(root,{recursive:true,force:true});}
});
test('attachment-only local queue preserves files independently through handoff',()=>{
 const files=['/tmp/image.png','/tmp/audio.wav'],queue=new LocalQueue();queue.add('',files);files.pop();
 const restored=new LocalQueue();restored.restore(queue.snapshot());expect(restored.next()?.files).toEqual(['/tmp/image.png','/tmp/audio.wav']);expect(queue.items).toHaveLength(1);
});
test('media actions use only an observed reference',()=>{expect(mediaReference({src:'https://example.test/image.png'})).toBe('https://example.test/image.png');expect(mediaReference({})).toBe('');});
