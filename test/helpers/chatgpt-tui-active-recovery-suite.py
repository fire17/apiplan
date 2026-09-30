import fcntl,json,os,pty,re,select,shutil,struct,subprocess,tempfile,termios,time,unittest
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[2]/'src'/'chatgpt'
ANSI=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
class ActiveRecoveryTests(unittest.TestCase):
 def check_active(self,stop):
  with tempfile.TemporaryDirectory(prefix='chatgpt-active-recovery-') as directory:
   root=Path(directory);state=root/'state.json';calls=root/'calls.json';driver=root/'driver.ts'
   restore={'conversation':'active-chat','inFlight':True,'messages':[],'draft':'','queue':{'paused':True,'items':[]}}
   driver.write_text("import {runTui} from "+json.dumps(str(SOURCE/'tui-host.ts'))+";import {writeFileSync} from 'node:fs';const calls=[];await runTui(undefined,{mock:true,restore:"+json.dumps(restore)+",mockRpc:async(op,args)=>{calls.push({op,args});writeFileSync("+json.dumps(str(calls))+",JSON.stringify(calls));if(op==='chat.stop')return {stopped:true};if(op!=='chat.reconcile')throw new Error('Unexpected '+op);return {verified:true,conversation:'active-chat',active:true,thinking:[{id:'new',title:'Pro thinking',text:'',status:'not-expandable'}],messages:[{id:'user',role:'user',text:'Original website prompt'}]};},onCheckpoint:value=>writeFileSync("+json.dumps(str(state))+",JSON.stringify(value))});")
   master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,180,0,0));process=subprocess.Popen([shutil.which('bun'),str(driver)],stdin=slave,stdout=slave,stderr=slave,cwd=root,close_fds=True);os.close(slave)
   def wait_for(text):
    output='';deadline=time.monotonic()+6
    while time.monotonic()<deadline:
     if select.select([master],[],[],.1)[0]:
      output+=os.read(master,65536).decode(errors='replace')
      if text in ANSI.sub('',output):return
    self.fail('Missing '+text+': '+ANSI.sub('',output)[-1200:])
   try:
    wait_for('Pro thinking');os.write(master,b'queued followup\r');wait_for('1 local queued (paused)');os.write(master,b'\x1bm');wait_for('Stop generation with Ctrl+C')
    if stop:
     os.write(master,b'\x03\x03');time.sleep(.15)
    os.write(master,b'\x11');deadline=time.monotonic()+3
    while process.poll() is None and time.monotonic()<deadline:
     if select.select([master],[],[],.05)[0]:
      try:os.read(master,65536)
      except OSError:break
    self.assertEqual(process.wait(timeout=1),0);saved=json.loads(state.read_text());operations=json.loads(calls.read_text());self.assertEqual(sum(x['op']=='chat.stop' for x in operations),1 if stop else 0);self.assertTrue(all(x['op'] in ['chat.reconcile','chat.stop'] for x in operations));self.assertEqual(saved['queue']['items'][0]['text'],'queued followup');self.assertTrue(saved['queue']['paused'])
   finally:
    if process.poll() is None:process.kill();process.wait(timeout=3)
    os.close(master)
 def test_enter_queues_and_ctrl_q_detaches_without_stop(self):self.check_active(False)
 def test_ctrl_c_stops_once_after_recovery(self):self.check_active(True)
if __name__=='__main__':unittest.main()
