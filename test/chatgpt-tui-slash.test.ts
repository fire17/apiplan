import {expect,test} from 'bun:test';
import {join} from 'node:path';
test('slash commands PTY completes, guards, streams and preserves Unicode text',async()=>{const child=Bun.spawn([process.env.CHATGPT_PYTHON||Bun.which('python3')!,join(import.meta.dir,'helpers/chatgpt-tui-slash-suite.py')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw new Error(out+'\n'+err);expect(code).toBe(0);},45000);
import {parseSlash,serviceOperations,localCommands} from '../src/chatgpt/slash.ts';
import {shortcutKeys} from '../src/chatgpt/tui-terminal.ts';
test('every operation and every keyboard shortcut is reachable as a slash command',()=>{
 for(const operation of serviceOperations)expect(parseSlash('/'+operation)).toMatchObject({kind:'operation',operation});
 for(const command of localCommands)expect(parseSlash('/'+command)).toMatchObject({kind:'local',command});
 const slashFor:Record<string,string>={attach:'attach',effort:'effort',model:'model',queue:'queue','received-media':'media',thinking:'thinking'};
 for(const key of Object.values(shortcutKeys))expect(localCommands).toContain(slashFor[key]!);
});
