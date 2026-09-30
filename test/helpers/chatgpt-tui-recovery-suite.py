import fcntl,json,os,pty,re,select,shutil,struct,subprocess,tempfile,termios,time,unittest
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[2]/'src'/'chatgpt'
ANSI=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
class RecoveryTests(unittest.TestCase):
 def test_read_only_retry_replaces_stale_errors_preserves_draft_and_never_sends(self):
  with tempfile.TemporaryDirectory(prefix='chatgpt-recovery-') as directory:
   root=Path(directory);state=root/'state.json';calls=root/'calls.json';driver=root/'driver.ts'
   restore={'conversation':'expected-chat','heading':'Recovery fixture','draft':'preserve composer','attachments':['/tmp/retained.png'],'scroll':2,'messages':[{'id':'confirmed','role':'user','text':'old confirmed','delivery':'unconfirmed'},{'role':'user','text':'uncertain','delivery':'submitted'},{'role':'user','text':'uncertain','delivery':'unconfirmed'},{'role':'assistant','text':'stale error placeholder'},{'role':'system','text':'Browser session timed out'}],'error':'old failure','queue':{'paused':False,'items':[]}}
   driver.write_text("import {runTui} from "+json.dumps(str(SOURCE/'tui-host.ts'))+";import {writeFileSync} from 'node:fs';let reads=0;const calls=[];await runTui(undefined,{mock:true,restore:"+json.dumps(restore)+",mockRpc:async(op,args)=>{calls.push({op,args});writeFileSync("+json.dumps(str(calls))+",JSON.stringify(calls));if(op!=='chat.reconcile')throw new Error('Unexpected operation '+op);if(++reads===1)throw new Error('Daemon connection unavailable');if(reads===2)return {verified:true,conversation:'wrong-chat',messages:[{role:'assistant',text:'WRONG CONVERSATION'}]};return {verified:true,conversation:'expected-chat',active:reads===3,messages:[{id:'confirmed',role:'user',text:'old confirmed'},{id:'answer',role:'assistant',text:reads===3?'Partial recovered answer':'Completed recovered answer'}]};},onCheckpoint:value=>writeFileSync("+json.dumps(str(state))+",JSON.stringify(value))});")
   master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,180,0,0));process=subprocess.Popen([shutil.which('bun'),str(driver)],stdin=slave,stdout=slave,stderr=slave,cwd=root,close_fds=True);os.close(slave)
   try:
    output='';deadline=time.monotonic()+12
    while time.monotonic()<deadline:
     if select.select([master],[],[],.1)[0]:
      output+=os.read(master,65536).decode(errors='replace')
      if 'Completed recovered answer' in ANSI.sub('',output):break
    self.assertIn('Completed recovered answer',ANSI.sub('',output));os.write(master,b'\x11')
    while process.poll() is None:
     if select.select([master],[],[],.1)[0]:
      try:os.read(master,65536)
      except OSError:break
    self.assertEqual(process.wait(timeout=2),0);saved=json.loads(state.read_text());operations=json.loads(calls.read_text());self.assertEqual([x['op'] for x in operations],['chat.reconcile','chat.reconcile','chat.reconcile','chat.reconcile']);self.assertTrue(all(x['args']['conversation']=='expected-chat' for x in operations));self.assertEqual(saved['draft'],'preserve composer');self.assertEqual(saved['attachments'],['/tmp/retained.png']);self.assertEqual(saved['scroll'],2);self.assertEqual(saved['error'],'');self.assertTrue(saved['queue']['paused']);self.assertEqual(len(saved['messages']),3);self.assertEqual(saved['messages'][-1]['role'],'draft');self.assertEqual(saved['messages'][-1]['text'],'uncertain')
   finally:
    if process.poll() is None:process.kill();process.wait(timeout=3)
    os.close(master)
if __name__=='__main__':unittest.main()
