import fcntl,json,os,pty,re,select,shutil,struct,subprocess,tempfile,termios,time,unittest
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[2]/'src'/'chatgpt'
ANSI=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
class SlashTests(unittest.TestCase):
 def test_controls_invalid_commands_streams_and_unicode(self):
  with tempfile.TemporaryDirectory(prefix='chatgpt-slash-') as directory:
   root=Path(directory);state=root/'state.json';calls=root/'calls.json';driver=root/'driver.ts';attachment=root/'fixture.txt';attachment.write_text('attachment fixture')
   restore={'conversation':'main-chat','messages':[{'role':'user','id':'main-user','text':'Existing transcript'}],'draft':'','cursor':0,'attachments':[str(attachment)],'queue':{'paused':True,'items':[]}}
   driver.write_text("import {runTui} from "+json.dumps(str(SOURCE/'tui.ts'))+";import {writeFileSync} from 'node:fs';const calls=[];await runTui(undefined,{mock:true,restore:"+json.dumps(restore)+",mockRpc:async(op,args,event)=>{calls.push({op,args});writeFileSync("+json.dumps(str(calls))+",JSON.stringify(calls));if(op==='models.options')return {models:[{label:'Fixture model',selected:true}],efforts:['Medium']};if(op==='chat.model')return {verified:true,model:args.model,label:args.model};if(op==='chat.effort')return {verified:true,effort:args.effort,label:args.effort};if(op==='status'){event({type:'thinking',items:[{id:'thought',title:'Slash thought',text:'Live slash detail'}]});event({type:'text',text:'Live slash response'});event({type:'media',items:[{reference:'file-slash',kind:'image',alt:'slash image'}]});return {fixture:'done'};}if(op==='chat.send'){event({type:'submitted',verified:true,messages:[{id:'sent'}]});return {conversation:'main-chat',text:'Unicode received'};}throw new Error('Unexpected '+op);},onCheckpoint:value=>writeFileSync("+json.dumps(str(state))+",JSON.stringify(value))});")
   master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',46,170,0,0));process=subprocess.Popen([shutil.which('bun'),str(driver)],stdin=slave,stdout=slave,stderr=slave,cwd=root,close_fds=True);os.close(slave);output=''
   def wait_for(text):
    nonlocal output
    deadline=time.monotonic()+7
    while time.monotonic()<deadline:
     if text in ANSI.sub('',output):return
     if select.select([master],[],[],.1)[0]:
      try:output+=os.read(master,65536).decode(errors='replace')
      except OSError:break
      if text in ANSI.sub('',output):return
    self.fail('Missing '+text+': '+ANSI.sub('',output)[-4000:])
   def press(sequence,text):
    nonlocal output
    start=len(output);os.write(master,sequence if isinstance(sequence,bytes) else sequence.encode());deadline=time.monotonic()+7
    while time.monotonic()<deadline:
     if select.select([master],[],[],.1)[0]:
      try:output+=os.read(master,65536).decode(errors='replace')
      except OSError:break
     if text in ANSI.sub('',output[start:]):return
    self.fail('Missing fresh '+text+' after '+repr(sequence)+': '+ANSI.sub('',output[start:])[-4000:])
   def send(text):
    nonlocal output
    os.write(master,text if isinstance(text,bytes) else text.encode());deadline=time.monotonic()+.15
    while time.monotonic()<deadline:
     if select.select([master],[],[],.01)[0]:
      try:output+=os.read(master,65536).decode(errors='replace')
      except OSError:break
   def records():return json.loads(calls.read_text()) if calls.exists() else []
   def checkpoint():
    time.sleep(1.0)
    while select.select([master],[],[],.05)[0]:
     try:os.read(master,65536)
     except OSError:break
    return json.loads(state.read_text())
   try:
    wait_for('/help  /model');send('/model');wait_for('/model');send('\t');self.assertEqual(records(),[]);send('\r');wait_for('MODEL · applies immediately');send('\x1b');time.sleep(.08);send('\x1b');send('\x15/not-a-command\r');wait_for('Unknown slash command /not-a-command');self.assertFalse(any(x['op']=='chat.send' for x in records()))
    send('\x15/model \"Fixture model\"\t\r');wait_for('Website verified model');send('/effort Medium\r');wait_for('Website verified effort');send('/status\r');wait_for('Live slash detail');wait_for('Live slash response');wait_for('slash image');send('\t');send('µπ\r');wait_for('Unicode received');self.assertEqual([x['args']['text'] for x in records() if x['op']=='chat.send'],['µπ']);self.assertEqual([x['args']['files'] for x in records() if x['op']=='chat.send'],[[str(attachment)]])
    # Slash discovery finds partial names, and the palette lists the same operations.
    send('\x15');press('/att','/attach');send('\x15');press('/free','/freeze');send('\x15');press('/conv','/conversations.list');send('\x15')
    press('\x0b','COMMANDS · type to search all');press('freeze','Freeze account');send('\x1b')
    press('\x0b','COMMANDS · type to search all');press('thaw','Thaw account');send('\x1b')
    self.assertEqual(checkpoint()['draft'],'')
    # Every macOS terminal encoding of Option+M opens the same model chooser without typing a character.
    for sequence in [b'\xc2\xb5',b'\x1bm',b'\x1bM',b'\xc3\x82',b'\x1b[109;3u',b'\x1b[27;3;109~',b'\x1b\xc2\xb5']:
     press(sequence,'MODEL · applies immediately');send('\x1b');time.sleep(.08);send('\x1b')
    self.assertEqual(checkpoint()['draft'],'')
    send('\x16µ');self.assertEqual(checkpoint()['draft'],'µ');send('\x15')
    send('//literal slash\r');wait_for('YOU · ANSWERED');time.sleep(.1);self.assertEqual([x['args']['text'] for x in records() if x['op']=='chat.send'],['µπ','/literal slash'],ANSI.sub('',output)[-4000:])
    send('/action-toggle-thinking-details\r');time.sleep(.1);send('\x11')
    deadline=time.monotonic()+5
    while process.poll() is None and time.monotonic()<deadline:
     if select.select([master],[],[],.05)[0]:
      try:os.read(master,65536)
      except OSError:break
    process.wait(timeout=3);self.assertEqual(process.returncode,0);saved=json.loads(state.read_text());self.assertFalse(saved['showThinking']);self.assertTrue(any('Live slash response' in m['text'] for m in saved['messages']))
   finally:
    if process.poll() is None:process.kill();process.wait(timeout=3)
    os.close(master)
if __name__=='__main__':unittest.main()
