import {describe,test,expect} from 'bun:test';
import {clean,width,clip,pad,wrap,InputDecoder} from './tui-terminal.ts';
import {mockClient} from './tui-mock.ts';
describe('terminal trust boundary and Unicode layout',()=>{
 test('untrusted messages cannot inject terminal commands',()=>{expect(clean('hello\x1b[2Jworld\x1b]52;c;secret\x07!')).toBe('helloworld!');expect(clean('safe\x00\x07\x1b[?1049l')).toBe('safe');});
 test('wide graphemes fit their terminal cells',()=>{expect(width('a界👩‍💻')).toBe(5);expect(clip('a界👩‍💻',4)).toBe('a界');expect(width(pad('界',4))).toBe(4);expect(wrap('界界ab',4)).toEqual(['界界','ab']);});
 test('combining accents remain intact',()=>{expect(clip('e\u0301x',1)).toBe('e\u0301');});
});
describe('keyboard decoder',()=>{
 test('split arrow sequences are not inserted into the composer',()=>{const d=new InputDecoder();expect(d.feed('\x1b[')).toEqual([]);expect(d.feed('A')).toEqual([{key:'up'}]);});
 test('multiline paste never submits, even with chunked delimiters',()=>{const d=new InputDecoder();expect(d.feed('\x1b[200~hello\n')).toEqual([]);expect(d.feed('world\x1b[20')).toEqual([]);expect(d.feed('1~')).toEqual([{key:'text',text:'hello\nworld'}]);});
 test('escape can be distinguished from a partial control sequence',()=>{const d=new InputDecoder();d.feed('\x1b');expect(d.flushEscape()).toBe(1);expect(d.feed('\r\n\x03')).toEqual([{key:'enter'},{key:'newline'},{key:'ctrl-c'}]);});
 test('Unicode text survives and terminal control pastes are sanitized',()=>{const d=new InputDecoder();expect(d.feed('שלום')).toHaveLength(4);expect(d.feed('\x1b[200~x\x1b[2Jy\x1b[201~')).toEqual([{key:'text',text:'xy'}]);});
});
test('mock streaming and cancellation preserve partial response',async()=>{const rpc=mockClient();let text='';await rpc('chat.send',{text:'hello'},e=>{if(e.type==='text'){text+=e.text;if(text.length>20)void rpc('chat.stop');}});expect(text.length).toBeGreaterThan(20);expect(text.length).toBeLessThan(200);expect((await rpc('conversations.list')).complete).toBe(true);});
test('Alt model and effort shortcuts decode atomically including split sequences',()=>{
 const decoder=new InputDecoder();
 expect(decoder.feed('\x1b')).toEqual([]);
 expect(decoder.feed('m')).toEqual([{key:'model'}]);
 expect(decoder.feed('\x1be\x1bM\x1bE')).toEqual([{key:'effort'},{key:'model'},{key:'effort'}]);
 expect(decoder.feed('\x1b[109;')).toEqual([]);
 expect(decoder.feed('3u\x1b[101;3u')).toEqual([{key:'model'},{key:'effort'}]);
 expect(decoder.feed('\x1b[200~\x1bmhello\x1b[201~')).toEqual([{key:'text',text:'hello'}]);
});

describe('macOS Option encodings reach the same shortcut',()=>{
 const feed=(bytes:string)=>new InputDecoder().feed(bytes);
 test('ESC-prefixed Meta form fires every bound shortcut in both cases',()=>{
  expect(feed('\x1ba\x1bA\x1be\x1bE\x1bm\x1bM\x1bq\x1bQ\x1br\x1bR\x1bt\x1bT')).toEqual([{key:'attach'},{key:'attach'},{key:'effort'},{key:'effort'},{key:'model'},{key:'model'},{key:'queue'},{key:'queue'},{key:'received-media'},{key:'received-media'},{key:'thinking'},{key:'thinking'}]);
 });
 test('composed characters typed alone fire the shortcut and never reach the draft',()=>{
  for(const [character,key] of [['µ','model'],['Â','model'],['†','thinking'],['ˇ','thinking'],['®','received-media'],['‰','received-media'],['œ','queue'],['Œ','queue'],['å','attach'],['Å','attach'],['´','effort'],['́','effort']] as const)
   expect(feed(character)).toEqual([{key,text:character}]);
 });
 test('composed characters inside prose, pastes or quoted insert stay text',()=>{
  expect(feed('µπ')).toEqual([{key:'text',text:'µ'},{key:'text',text:'π'}]);
  expect(feed('abµ')).toEqual([{key:'text',text:'a'},{key:'text',text:'b'},{key:'text',text:'µ'}]);
  expect(feed('\x1b[200~µ†å\x1b[201~')).toEqual([{key:'text',text:'µ†å'}]);
  expect(feed('\x16µ')).toEqual([{key:'text',text:'µ'}]);
  const split=new InputDecoder();expect(split.feed('\x16')).toEqual([]);expect(split.feed('†')).toEqual([{key:'text',text:'†'}]);
  expect(feed('ø∑ß')).toEqual([{key:'text',text:'ø'},{key:'text',text:'∑'},{key:'text',text:'ß'}]);
 });
 test('kitty protocol and modifyOtherKeys chords resolve, including composed text fields',()=>{
  expect(feed('\x1b[109;3u\x1b[116;3u\x1b[97;3u\x1b[113;3u\x1b[114;3u\x1b[101;3u')).toEqual([{key:'model'},{key:'thinking'},{key:'attach'},{key:'queue'},{key:'received-media'},{key:'effort'}]);
  expect(feed('\x1b[109;4u')).toEqual([{key:'model'}]);
  expect(feed('\x1b[109;3:1;109u')).toEqual([{key:'model'}]);
  expect(feed('\x1b[27;3;109~\x1b[27;3;116~')).toEqual([{key:'model'},{key:'thinking'}]);
  expect(feed('\x1b[181;3u')).toEqual([{key:'model',text:'µ'}]);
  expect(feed('\x1b[109;7u')).toEqual([]);
  expect(feed('\x1b[102;3u')).toEqual([]);
 });
 test('ESC-prefixed composed characters and unbound Alt chords never insert stray text',()=>{
  expect(feed('\x1bµ')).toEqual([{key:'model',text:'µ'}]);
  expect(feed('\x1bf')).toEqual([]);
  expect(feed('\x1b.')).toEqual([]);
 });
 test('application-mode and modified arrows still navigate the composer',()=>{
  expect(feed('\x1bOA\x1bOB\x1bOC\x1bOD')).toEqual([{key:'up'},{key:'down'},{key:'right'},{key:'left'}]);
  expect(feed('\x1b[1;3A\x1b[1;2B\x1b[1;5C')).toEqual([{key:'up'},{key:'down'},{key:'right'}]);
  expect(feed('\x1b\x1b[A')).toEqual([{key:'up'}]);
  expect(feed('\x1b[3~\x1b[H\x1b[F')).toEqual([{key:'delete'},{key:'home'},{key:'end'}]);
 });
 test('every encoding survives chunk splits and a lone Escape still resolves',()=>{
  const decoder=new InputDecoder();
  expect(decoder.feed('\x1b[27;3;')).toEqual([]);expect(decoder.feed('109~')).toEqual([{key:'model'}]);
  expect(decoder.feed('\x1b[1;')).toEqual([]);expect(decoder.feed('3A')).toEqual([{key:'up'}]);
  expect(decoder.feed('\x1b')).toEqual([]);expect(decoder.flushEscape()).toBe(1);
  expect(decoder.feed('\x1b\x1b')).toEqual([]);expect(decoder.flushEscape()).toBe(2);
  expect(decoder.feed('†')).toEqual([{key:'thinking',text:'†'}]);
 });
});
