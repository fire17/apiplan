import fcntl,json,os,pty,re,select,shutil,struct,subprocess,tempfile,termios,time,unittest
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[2]/'src'/'chatgpt'
ANSI=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
class SharedStreamTests(unittest.TestCase):
 def test_stream_targets_thoughts_media_and_literal_alt_text(self):
  with tempfile.TemporaryDirectory(prefix='chatgpt-shared-stream-') as directory:
   root=Path(directory);state=root/'state.json';calls=root/'calls.json';driver=root/'driver.ts'
   restore={'conversation':'main-chat','messages':[{'role':'user','id':'main-user','text':'Literal Alt+M message remains unchanged'}],'draft':'Literal Alt+M composer','cursor':9,'queue':{'paused':True,'items':[]}}
   driver.write_text("import {runTui} from "+json.dumps(str(SOURCE/'tui-host.ts'))+";import {writeFileSync} from 'node:fs';const calls=[];const state={account:{id:'demo',userId:'fixture-user'},paused:true,running:false,items:[{id:'one',requestId:'r1',phase:'queued',created:'2026-09-15T00:00:00Z',draft:{conversation:'other-chat',text:'Other target prompt'}},{id:'two',requestId:'r2',phase:'queued',created:'2026-09-15T00:00:00Z',draft:{new:true,text:'New target prompt'}}]};await runTui(undefined,{mock:true,sharedQueue:true,restore:"+json.dumps(restore)+",mockRpc:async(op,args,event)=>{calls.push(op);writeFileSync("+json.dumps(str(calls))+",JSON.stringify(calls));if(op==='queue.pause')state.paused=true;else if(op==='queue.resume')state.paused=false;else if(op==='queue.run'){state.running=true;event({type:'queue.submitting',id:'one'});event({type:'queue.event',id:'one',event:{type:'thinking',items:[{id:'thought',title:'Queue thought',text:'Detailed streamed queue thought'}]}});event({type:'queue.event',id:'one',event:{type:'text',text:'Streamed other-chat reply Alt+M'}});event({type:'queue.event',id:'one',event:{type:'media',items:[{reference:'file-fixture',kind:'image',alt:'streamed image'}]}});await Bun.sleep(300);event({type:'queue.event',id:'two',event:{type:'text',text:'Streamed new-chat reply'}});await Bun.sleep(300);state.running=false;state.items[0].phase='complete';state.items[0].result={text:'Streamed other-chat reply Alt+M',conversation:'other-chat'};state.items[1].phase='complete';state.items[1].result={text:'Streamed new-chat reply',conversation:'new-result'};return {...structuredClone(state),completedThisRun:2};}else if(op!=='queue.list')throw new Error('Unexpected '+op);return structuredClone(state);},onCheckpoint:value=>writeFileSync("+json.dumps(str(state))+",JSON.stringify(value))});")
   master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',42,190,0,0));process=subprocess.Popen([shutil.which('bun'),str(driver)],stdin=slave,stdout=slave,stderr=slave,cwd=root,close_fds=True);os.close(slave);output=''
   def wait_for(text):
    nonlocal output
    deadline=time.monotonic()+7
    while time.monotonic()<deadline:
     if select.select([master],[],[],.1)[0]:
      output+=os.read(master,65536).decode(errors='replace')
      if text in ANSI.sub('',output):return
    self.fail('Missing '+text+': '+ANSI.sub('',output)[-3000:])
   try:
    wait_for('2 shared queued');plain=ANSI.sub('',output);self.assertIn('Literal Alt+M message remains unchanged',plain);self.assertIn('Literal Alt+M composer',plain)
    if os.uname().sysname=='Darwin':self.assertIn('Option+M model',plain);self.assertNotIn('Literal Option+M',plain)
    os.write(master,b'\x1bq');wait_for('SHARED CLI / TUI QUEUE');os.write(master,b'Run shared\r');wait_for('Detailed streamed queue thought');wait_for('Streamed other-chat reply Alt+M');wait_for('streamed image');wait_for('Streamed new-chat reply');wait_for('2 completed');os.write(master,b'\x1b');time.sleep(.08);os.write(master,b'\x11');deadline=time.monotonic()+3
    while process.poll() is None and time.monotonic()<deadline:
     if select.select([master],[],[],.05)[0]:
      try:os.read(master,65536)
      except OSError:break
    self.assertEqual(process.wait(timeout=1),0);saved=json.loads(state.read_text());self.assertEqual(saved['conversation'],'main-chat');self.assertEqual(saved['draft'],'Literal Alt+M composer');self.assertEqual([m['text'] for m in saved['messages']],['Literal Alt+M message remains unchanged']);self.assertEqual(saved['sharedQueueView']['details']['one']['media'][0]['reference'],'file-fixture');self.assertFalse(saved['sharedQueueView']['visible']);self.assertNotIn('chat.send',json.loads(calls.read_text()))
   finally:
    if process.poll() is None:process.kill();process.wait(timeout=3)
    os.close(master)
if __name__=='__main__':unittest.main()
