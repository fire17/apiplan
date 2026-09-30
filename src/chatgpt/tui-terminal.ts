export const shortcutModifier=process.platform==='darwin'?'Option':'Alt';
/** Terminal content is untrusted: strip controls before applying our own styling. */
export const clean=(s:unknown)=>String(s??'').replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'');
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
export const graphemes=(s:string)=>Array.from(segmenter.segment(s),x=>x.segment);
export function width(s:string){return graphemes(clean(s)).reduce((n,c)=>n+cell(c),0);}
function cell(c:string){const n=c.codePointAt(0)!;return /\p{Extended_Pictographic}/u.test(c)||n>=0x1100&&(n<=0x115f||n>=0x2e80&&n<=0xa4cf||n>=0xac00&&n<=0xd7af||n>=0xf900&&n<=0xfaff||n>=0xfe10&&n<=0xfe6f||n>=0xff00&&n<=0xff60||n>=0x20000)?2:1;}
export function clip(s:string,max:number){let out='',n=0;for(const c of graphemes(clean(s).replace(/[\r\n\t]/g,' '))){const w=cell(c);if(n+w>max)break;out+=c;n+=w;}return out;}
export const pad=(s:string,n:number)=>clip(s,n)+' '.repeat(Math.max(0,n-width(clip(s,n))));
export function wrap(s:string,n:number):string[]{n=Math.max(1,n);return clean(s).replace(/\t/g,'    ').split('\n').flatMap(line=>{const out:string[]=[];let row='',size=0;for(const c of graphemes(line)){const w=cell(c);if(size+w>n){out.push(row);row='';size=0;}row+=c;size+=w;}out.push(row);return out;});}
export type Key={key:string;text?:string};

/** Letters bound to a modifier shortcut. Everything here is also reachable as a slash command. */
export const shortcutKeys:Record<string,string>={a:'attach',e:'effort',m:'model',q:'queue',r:'received-media',t:'thinking'};
/**
 * macOS composes Option+<letter> into a printable character (Option+M is µ) unless the terminal is
 * configured to send Meta / Esc+. Terminal.app, Ghostty, Alacritty and kitty all default to composing,
 * so the shortcut never reaches an ESC-prefixed decoder and the character lands in the draft instead.
 * This table maps the US layout — plain, Shift, and the dead-key marks — back to its letter so the
 * shortcut fires on an unconfigured Mac. Letters without a binding still insert as ordinary text.
 */
export const optionComposed:Record<string,string>=(()=>{
 const letters='abcdefghijklmnopqrstuvwxyz';
 const plain=[...'å∫ç∂´ƒ©˙ˆ∆˚¬µ˜øπœ®ß†¨√∑≈¥Ω'];
 const shifted=[...'ÅıÇÎ´Ï˝ÓˆÔÒÂ˜Ø∏Œ‰Íˇ¨◊„˛Á¸'];
 const map:Record<string,string>={};
 for(let i=0;i<letters.length;i++){map[plain[i]]??=letters[i];map[shifted[i]]??=letters[i];}
 for(const [mark,letter] of [['\u0301','e'],['\u0308','u'],['\u0302','i'],['\u0303','n'],['\u2126','z'],['\uF8FF','k']] as const)map[mark]=letter;
 return map;
})();
/** Composed characters that currently resolve to a bound shortcut; everything else stays text. */
export const composedShortcuts:Record<string,string>=Object.fromEntries(Object.entries(optionComposed).filter(([,letter])=>shortcutKeys[letter]).map(([character,letter])=>[character,shortcutKeys[letter]]));

const codes:Record<string,string>={
 ...Object.fromEntries(Object.entries(shortcutKeys).flatMap(([letter,key])=>[['\x1b'+letter,key],['\x1b'+letter.toUpperCase(),key]])),
 '\x1b[A':'up','\x1b[B':'down','\x1b[C':'right','\x1b[D':'left','\x1bOA':'up','\x1bOB':'down','\x1bOC':'right','\x1bOD':'left',
 '\x1b[H':'home','\x1b[F':'end','\x1bOH':'home','\x1bOF':'end','\x1b[1~':'home','\x1b[4~':'end','\x1b[7~':'home','\x1b[8~':'end',
 '\x1b[5~':'pageup','\x1b[6~':'pagedown','\x1b[3~':'delete','\x1b[Z':'backtab','\x1b[13;2u':'newline','\x1b[27;2;13~':'newline'};
const arrowFinals:Record<string,string>={A:'up',B:'down',C:'right',D:'left',F:'end',H:'home'};
const controls:Record<string,string>={'\r':'enter','\n':'newline','\t':'tab','\x7f':'backspace','\x03':'ctrl-c','\x11':'ctrl-q','\x0b':'palette','\x0e':'new','\x06':'search','\x12':'refresh','\x02':'browser','\x15':'clear','\x01':'home','\x05':'end','\x17':'wordback','\x04':'delete'};

/**
 * Stateful decoder: pasted newlines never become submit keys; UTF-8 decoding is owned by stdin.
 *
 * Option / Alt shortcuts are accepted in every encoding a terminal can produce: ESC-prefixed
 * (iTerm2 "Esc+", Terminal.app "Use Option as Meta Key", WezTerm left Alt), the kitty keyboard
 * protocol (CSI code;mods u), xterm modifyOtherKeys (CSI 27;mods;code ~) and the macOS composed
 * character (µ † ® œ å ´ …).
 *
 * Composed-character rule: a composed character fires its shortcut only when it arrives as a bare
 * standalone keystroke — first key of an input chunk with nothing after it — and never inside a
 * bracketed paste. Typed inside prose (any burst that carries other characters) or after Ctrl+V
 * (quoted insert) it stays ordinary text, so µ and å remain typable.
 */
export class InputDecoder {
 private buffer='';private paste=false;private pasted='';private literal=false;
 /** Decode one chunk of terminal input into keys. */
 feed(s:string):Key[]{this.buffer+=s;const out:Key[]=[];
  while(this.buffer){
   if(this.paste){const i=this.buffer.indexOf('\x1b[201~');if(i<0){const keep=Math.min(5,this.buffer.length);this.pasted+=this.buffer.slice(0,-keep);this.buffer=this.buffer.slice(-keep);break;}this.pasted+=this.buffer.slice(0,i);out.push({key:'text',text:clean(this.pasted.replace(/\r\n?/g,'\n'))});this.paste=false;this.pasted='';this.buffer=this.buffer.slice(i+6);continue;}
   if(this.buffer.startsWith('\x1b[200~')){this.paste=true;this.buffer=this.buffer.slice(6);continue;}
   if(this.literal){const c=String.fromCodePoint(this.buffer.codePointAt(0)!);this.buffer=this.buffer.slice(c.length);this.literal=false;const text=clean(c);if(text)out.push({key:'text',text});continue;}
   const match=Object.keys(codes).find(k=>this.buffer.startsWith(k));if(match){out.push({key:codes[match]});this.buffer=this.buffer.slice(match.length);continue;}
   const mouse=this.buffer.match(/^\x1b\[<(\d+;\d+;\d+)([mM])/);if(mouse){if(mouse[2]==='M')out.push({key:'mouse',text:mouse[1]});this.buffer=this.buffer.slice(mouse[0].length);continue;}
   if(this.buffer[0]==='\x1b'){
    if(/^\x1b(?:\x1b?|\[[0-9;:<>?]*[ -/]*|O)$/.test(this.buffer)||Object.keys(codes).concat('\x1b[200~').some(k=>k.startsWith(this.buffer)))break;
    if(this.buffer.startsWith('\x1b\x1b')&&/^\x1b\x1b[[O]/.test(this.buffer)){this.buffer=this.buffer.slice(1);continue;}
    const kitty=this.buffer.match(/^\x1b\[(\d+)(?::\d+)*(?:;(\d+)(?::\d+)?)?(?:;[\d:]*)?u/);
    if(kitty){this.buffer=this.buffer.slice(kitty[0].length);const key=chord(Number(kitty[1]),Number(kitty[2]||1));if(key)out.push(key);continue;}
    const other=this.buffer.match(/^\x1b\[27;(\d+)(?::\d+)?;(\d+)~/);
    if(other){this.buffer=this.buffer.slice(other[0].length);const key=chord(Number(other[2]),Number(other[1]));if(key)out.push(key);continue;}
    const arrow=this.buffer.match(/^\x1b\[1;\d+(?::\d+)?([A-HPS])/);
    if(arrow){this.buffer=this.buffer.slice(arrow[0].length);if(arrowFinals[arrow[1]])out.push({key:arrowFinals[arrow[1]]});continue;}
    const sequence=this.buffer.match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[@-~])/);
    if(sequence){this.buffer=this.buffer.slice(sequence[0].length);out.push({key:'escape'});continue;}
    const next=String.fromCodePoint(this.buffer.codePointAt(1)!);
    if(next.codePointAt(0)!>=0x20&&next!=='\x7f'){this.buffer=this.buffer.slice(1+next.length);const letter=(optionComposed[next]||next).toLowerCase();if(shortcutKeys[letter])out.push({key:shortcutKeys[letter],...(optionComposed[next]?{text:next}:{})});continue;}
    this.buffer=this.buffer.slice(1);out.push({key:'escape'});continue;
   }
   const first=!out.length,c=String.fromCodePoint(this.buffer.codePointAt(0)!);this.buffer=this.buffer.slice(c.length);
   if(c==='\x16'){this.literal=true;continue;}
   if(composedShortcuts[c]&&first&&!this.buffer){out.push({key:composedShortcuts[c],text:c});continue;}
   out.push(controls[c]?{key:controls[c]}:{key:'text',text:clean(c)});
  }return out;}
 /** Pending Escapes resolve once no sequence follows: returns how many escape keys to deliver. */
 flushEscape(){if(/^\x1b+$/.test(this.buffer)){const pending=this.buffer.length;this.buffer='';return pending;}return 0;}
}
/** Resolve a kitty / modifyOtherKeys chord. Modifier value is 1 + bitmask (shift 1, alt 2, ctrl 4). */
function chord(code:number,modifiers:number):Key|null{
 const bits=Math.max(0,modifiers-1),shift=!!(bits&1),alt=!!(bits&2),ctrl=!!(bits&4);
 const character=code>=0x20&&code!==0x7f?String.fromCodePoint(code):'';
 if(alt&&!ctrl){const letter=(optionComposed[character]||character).toLowerCase();return shortcutKeys[letter]?{key:shortcutKeys[letter],...(optionComposed[character]?{text:character}:{})}:null;}
 if(code===13)return {key:shift||alt?'newline':'enter'};
 if(!alt&&!ctrl&&character){const text=clean(character);return text?{key:'text',text}:null;}
 return null;
}
