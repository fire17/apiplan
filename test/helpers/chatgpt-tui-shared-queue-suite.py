import fcntl,json,os,pty,re,select,shutil,struct,subprocess,tempfile,termios,time,unittest
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[2]/'src'/'chatgpt'
ANSI=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
class SharedQueueTests(unittest.TestCase):
 def run_case(self,add_input=False):
  with tempfile.TemporaryDirectory(prefix='chatgpt-shared-pty-') as directory:
   root=Path(directory);state=root/'state.json';calls=root/'calls.json';driver=root/'driver.ts';queue_root=root/'queue'
   restore={'conversation':'fixture-chat','messages':[],'draft':'composer retained','cursor':4,'queue':{'paused':False,'items':[{'id':'legacy-stable-id','text':'legacy queued','files':[]}]}}
   driver.write_text("import {runTui} from "+json.dumps(str(SOURCE/'tui-host.ts'))+";import {MessageQueue} from "+json.dumps(str(SOURCE/'message-queue.ts'))+";import {writeFileSync} from 'node:fs';const a={id:'demo',userId:'fixture-user',label:'fixture',baseURL:'https://chatgpt.com',created:''};const q=new MessageQueue(a,{directory:"+json.dumps(str(queue_root))+"});q.add({text:'uncertain CLI attempt',conversation:'fixture-chat'});q.resume();await q.run(async()=>{throw new Error('synthetic unknown');});q.add({text:'CLI queued message',conversation:'other-chat'});const calls=[];await runTui(undefined,{mock:true,sharedQueue:true,restoreFromDisk:true,restore:"+json.dumps(restore)+",mockRpc:async(op,args)=>{calls.push(op);writeFileSync("+json.dumps(str(calls))+",JSON.stringify(calls));let item;if(op==='queue.pause')q.pause();else if(op==='queue.add')item=q.add(args,args.clientId);else if(op!=='queue.list')throw new Error('Unexpected '+op);return {...q.status(),...(item?{item}:{})};},onCheckpoint:value=>writeFileSync("+json.dumps(str(state))+",JSON.stringify(value))});")
   master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',36,180,0,0));process=subprocess.Popen([shutil.which('bun'),str(driver)],stdin=slave,stdout=slave,stderr=slave,cwd=root,close_fds=True);os.close(slave)
   def wait_for(text):
    output='';deadline=time.monotonic()+8
    while time.monotonic()<deadline:
     if select.select([master],[],[],.1)[0]:
      output+=os.read(master,65536).decode(errors='replace')
      if text in ANSI.sub('',output):return
    self.fail('Missing '+text+': '+ANSI.sub('',output)[-2000:])
   try:
    wait_for('2 shared queued (paused) · 1 unknown')
    if add_input:
     os.write(master,b'\r');wait_for('3 shared queued (paused) · 1 unknown')
    os.write(master,b'\x1bq');wait_for('CLI queued message');os.write(master,b'Run shared');os.write(master,b'\r');wait_for('uncertain or not-submitted');os.write(master,b'\x11');deadline=time.monotonic()+3
    while process.poll() is None and time.monotonic()<deadline:
     if select.select([master],[],[],.05)[0]:
      try:os.read(master,65536)
      except OSError:break
    self.assertEqual(process.wait(timeout=1),0);saved=json.loads(state.read_text());stored=json.loads((queue_root/'queue.json').read_text());operations=json.loads(calls.read_text());self.assertEqual(saved['draft'],'' if add_input else 'composer retained');self.assertEqual(saved['cursor'],0 if add_input else 4);self.assertEqual(saved['queue']['items'],[]);self.assertTrue(stored['paused']);self.assertEqual(len(stored['items']),4 if add_input else 3);self.assertEqual(len([x for x in stored['items'] if x.get('clientId')=='legacy-stable-id']),1);self.assertEqual(stored['items'][0]['phase'],'unknown');self.assertTrue(all(op in ['queue.list','queue.pause','queue.add'] for op in operations))
   finally:
    if process.poll() is None:process.kill();process.wait(timeout=3)
    os.close(master)
 def test_cli_store_visible_legacy_migrates_once_and_unknown_blocks_run(self):self.run_case()
 def test_new_enter_queues_into_shared_store_without_running_unknown(self):self.run_case(True)
if __name__=='__main__':unittest.main()
