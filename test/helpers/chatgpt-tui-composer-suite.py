import fcntl,json,os,pty,select,shutil,struct,subprocess,tempfile,termios,time,unittest
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[2]/'src'/'chatgpt'
class ComposerTests(unittest.TestCase):
 def test_history_multiline_unicode_and_paste_never_submit_until_enter(self):
  with tempfile.TemporaryDirectory(prefix='chatgpt-composer-') as directory:
   root=Path(directory);state=root/'state.json';calls=root/'calls.json';driver=root/'driver.ts'
   original='draft\n界👩‍💻x';restore={'messages':[{'role':'user','id':'first','text':'first sent'},{'role':'user','id':'latest','text':'latest sent','delivery':'answered','files':['/tmp/sent.png']},{'role':'user','text':'unknown excluded','delivery':'unconfirmed'},{'role':'draft','text':'local excluded'}],'draft':original,'cursor':2,'attachments':['/tmp/original.png'],'queue':{'paused':True,'items':[]}}
   driver.write_text("import {runTui} from "+json.dumps(str(SOURCE/'tui-host.ts'))+";import {writeFileSync} from 'node:fs';const calls=[];await runTui(undefined,{mock:true,restore:"+json.dumps(restore)+",mockRpc:async(op,args,event)=>{calls.push({op,args});writeFileSync("+json.dumps(str(calls))+",JSON.stringify(calls));if(op==='chat.send'){event?.({type:'submitted',messages:[{id:'new-user'}]});return {text:'sent fixture'};}throw new Error('Unexpected '+op);},onCheckpoint:value=>writeFileSync("+json.dumps(str(state))+",JSON.stringify(value))});")
   master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,100,0,0));process=subprocess.Popen([shutil.which('bun'),str(driver)],stdin=slave,stdout=slave,stderr=slave,cwd=root,close_fds=True);os.close(slave)
   def until(predicate):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
     if select.select([master],[],[],.05)[0]:
      try:os.read(master,65536)
      except OSError:break
     if state.exists():
      try:saved=json.loads(state.read_text())
      except ValueError:continue
      if predicate(saved):return saved
    self.fail('Checkpoint condition failed: '+(state.read_text() if state.exists() else 'no state'))
   try:
    until(lambda s:s['draft']==original);os.write(master,b'\x1b[A');until(lambda s:s['draft']=='latest sent');os.write(master,b'!\x1b[B');saved=until(lambda s:s['draft']==original);self.assertEqual(saved['cursor'],2);self.assertEqual(saved['attachments'],['/tmp/original.png'])
    os.write(master,b'\x1b[B');until(lambda s:s['cursor']==7);os.write(master,b'\x1b[13;2u');expanded='draft\n界\n👩‍💻x';until(lambda s:s['draft']==expanded)
    os.write(master,b'\x1b[200~line two\nline three\x1b[201~');pasted='draft\n界\nline two\nline three👩‍💻x';saved=until(lambda s:s['draft']==pasted);self.assertFalse(calls.exists());self.assertEqual(saved['messages'][1]['text'],'latest sent')
    os.write(master,b'\r');until(lambda s:s['draft']=='' and any(m.get('text')=='sent fixture' for m in s['messages']));sent=json.loads(calls.read_text());self.assertEqual(len(sent),1);self.assertEqual(sent[0]['op'],'chat.send');self.assertEqual(sent[0]['args']['text'],pasted);self.assertEqual(sent[0]['args']['files'],['/tmp/original.png'])
    # Every macOS Option encoding fires the shortcut and leaves the draft untouched.
    os.write(master,'\u2020'.encode());until(lambda s:s['showThinking'] is False and s['draft']=='')
    os.write(master,b'\x1bt');until(lambda s:s['showThinking'] is True and s['draft']=='')
    os.write(master,b'\x1b[116;3u');until(lambda s:s['showThinking'] is False and s['draft']=='')
    os.write(master,b'\x1b[27;3;116~');until(lambda s:s['showThinking'] is True and s['draft']=='')
    os.write(master,b'\x1b\xe2\x80\xa0');until(lambda s:s['showThinking'] is False and s['draft']=='')
    os.write(master,b'\x1bT');until(lambda s:s['showThinking'] is True and s['draft']=='')
    # Quoted insert keeps the same character typable, and inside a burst it is ordinary text.
    os.write(master,b'\x16'+'\u2020'.encode());until(lambda s:s['draft']=='\u2020' and s['showThinking'] is True)
    os.write(master,'a\u2020b'.encode());until(lambda s:s['draft']=='\u2020a\u2020b' and s['showThinking'] is True)
    # Application-mode and modified arrows still recall history and restore the draft.
    os.write(master,b'\x1b[1;3A');until(lambda s:s['draft']==pasted)
    os.write(master,b'\x1bOB');saved=until(lambda s:s['draft']=='\u2020a\u2020b');self.assertEqual(saved['attachments'],[])
    os.write(master,b'\x11')
    deadline=time.monotonic()+3
    while process.poll() is None and time.monotonic()<deadline:
     if select.select([master],[],[],.05)[0]:
      try:os.read(master,65536)
      except OSError:break
    self.assertEqual(process.wait(timeout=1),0)
   finally:
    if process.poll() is None:process.kill();process.wait(timeout=3)
    os.close(master)
if __name__=='__main__':unittest.main()
