import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {messageTime,messageTimeLabel} from '../src/chatgpt/message-time.ts';

// fire17's ask, verbatim: "please add timestamps to every message from the user or the agent".
// The semantics live in message-time.ts and are tested there; what was missing is a guard that the transcript
// actually prints a stamp on EVERY role's header, and that it is wrapped so a narrow pane cannot lose it.

const source=readFileSync(join(import.meta.dir,'../src/chatgpt/tui.ts'),'utf8');

test('every transcript role prints its timestamp, wrapped to the pane width',()=>{
 const at=source.indexOf('messageTimeLabel(m)');
 expect(at).toBeGreaterThan(0);
 const line=source.slice(at-400,at+60);
 // One header expression covers all four roles, so no role can quietly lose its stamp.
 for(const role of ['YOU','LOCAL DRAFT · UNCONFIRMED','WORKSPACE','CHATGPT'])expect(line).toContain(role);
 // Wrapped at the chat width, never printed raw: a narrow pane folds the header instead of truncating it.
 expect(line).toContain('wrap(');
 expect(line.slice(line.indexOf('messageTimeLabel(m)'))).toContain(',chatW-2)');
});

test('the label carries date, seconds and zone, and never passes an observation off as a send time',()=>{
 const sent='2026-09-15T12:34:56.000Z';// timestamps travel as ISO strings, never epoch numbers
 const website=messageTimeLabel({timestamp:sent,timestampSource:'website'},'Asia/Jerusalem');
 expect(website).toContain('2026-09-15 15:34:56');
 expect(website).toContain('GMT+3');
 expect(website).not.toContain('·');// a real creation time needs no qualifier

 const local=messageTimeLabel({timestamp:sent,timestampSource:'local'},'Asia/Jerusalem');
 expect(local.endsWith(' · local')).toBe(true);

 const seen=messageTimeLabel({timestamp:sent,timestampSource:'observed'},'Asia/Jerusalem');
 expect(seen.endsWith(' · seen')).toBe(true);

 // Same instant, three provenances, one format: only the qualifier differs.
 expect(local.slice(0,website.length)).toBe(website);
 expect(seen.slice(0,website.length)).toBe(website);
});

test('a message with no website time still gets a stamp rather than an empty header',()=>{
 const stamp=messageTime({id:'user-1',role:'user'},undefined,'2026-09-15T12:34:56.000Z');
 expect(typeof stamp.timestamp).toBe('string');
 expect(stamp.timestampSource).not.toBe('website');
 expect(messageTimeLabel(stamp,'Asia/Jerusalem')).toContain('2026-09-15 15:34:56');
});
