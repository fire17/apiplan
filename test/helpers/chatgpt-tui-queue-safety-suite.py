import fcntl,json,os,pty,re,select,shutil,struct,subprocess,tempfile,termios,time,unittest
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[2]/'src'/'chatgpt';ANSI=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
class QueueSafetyTests(unittest.TestCase):
 def scenario(self,kind):
  with tempfile.TemporaryDirectory(prefix='chatgpt-queue-safety-') as directory:
   root=Path(directory);saved_path=root/'saved.json';calls_path=root/'calls.json';driver=root/'driver.ts'
   if kind=='stop':restore={'conversation':'main','messages':[],'draft':'','queue':{'paused':True,'items':[]}}
   elif kind=='detach':restore={'inFlight':True,'messages':[{'role':'user','text':'first','requestId':'parent','delivery':'submitting'}],'draft':'','queue':{'paused':True,'items':[{'id':'follow','text':'followup','awaitingConversation':True,'parentRequestId':'parent','context':{'new':True,'project':'project'}}]}}
   else:restore={'project':'project','messages':[],'draft':'first','queue':{'paused':True,'items':[]}}
   initial_items=[{'id':'one','requestId':'one','phase':'queued','draft':{'conversation':'target','text':'one'}},{'id':'two','requestId':'two','phase':'queued','draft':{'conversation':'target','text':'two'}}] if kind=='stop' else []
   code="import {runTui} from "+json.dumps(str(SOURCE/'tui-host.ts'))+";import {writeFileSync} from 'node:fs';const mode="+json.dumps(kind)+";const calls=[];const queue={account:{id:'demo',userId:'fixture-user'},paused:true,running:false,items:"+json.dumps(initial_items)+"};let finish;await runTui(undefined,{mock:true,sharedQueue:true,restoreFromDisk:true,restore:"+json.dumps(restore)+",mockRpc:async(op,args,event)=>{calls.push({op,args});writeFileSync("+json.dumps(str(calls_path))+",JSON.stringify(calls));let item;if(op==='queue.pause')queue.paused=true;else if(op==='queue.resume')queue.paused=false;else if(op==='queue.add'){item={id:args.clientId,clientId:args.clientId,requestId:'request-'+args.clientId,phase:'queued',draft:args};queue.items.push(item);}else if(op==='receipts.get')return {receipt:{id:'parent',operation:'chat.send',account:queue.account,status:mode==='unknown'?'unknown':'complete'},result:{conversation:'created-chat'}};else if(op==='chat.send'){event({type:'operation.receipt',requestId:'parent'});event({type:'text',text:'Original response underway'});await Bun.sleep(1300);if(mode==='unknown')throw Object.assign(new Error('Unknown fixture outcome'),{code:'OUTCOME_UNKNOWN',requestId:'parent'});event({type:'submitted',verified:true,url:'https://chatgpt.com/c/created-chat',messages:[{id:'first-user'}]});return {conversation:'created-chat',text:'Original complete'};}else if(op==='queue.run'){queue.running=true;event({type:'queue.submitting',id:'one'});event({type:'queue.event',id:'one',event:{type:'text',text:'RUNNING QUEUE RESPONSE'}});return new Promise(resolve=>{finish=resolve;});}else if(op==='chat.stop'){if(!queue.paused)throw new Error('Queue was not paused before stop');queue.running=false;queue.items[0].phase='unknown';finish(structuredClone(queue));return {stopped:true};}else if(op!=='queue.list')throw new Error('Unexpected '+op);return {...structuredClone(queue),...(item?{item}:{})};},onCheckpoint:value=>writeFileSync("+json.dumps(str(saved_path))+",JSON.stringify(value))});"
   driver.write_text(code);master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',34,180,0,0));process=subprocess.Popen([shutil.which('bun'),str(driver)],stdin=slave,stdout=slave,stderr=slave,cwd=root,close_fds=True);os.close(slave);output=''
   def wait_for(text):
    nonlocal output
    deadline=time.monotonic()+6
    while time.monotonic()<deadline:
     if select.select([master],[],[],.05)[0]:
      output+=os.read(master,65536).decode(errors='replace')
      if text in ANSI.sub('',output):return
    self.fail('Missing '+text+': '+ANSI.sub('',output)[-2000:])
   try:
    if kind=='stop':
     wait_for('2 shared queued');os.write(master,b'\x1bq');wait_for('SHARED CLI / TUI QUEUE');os.write(master,b'Run shared\r');wait_for('RUNNING QUEUE RESPONSE');os.write(master,b'\x03\x03');time.sleep(.15)
    elif kind=='detach':wait_for('1 shared queued (paused)')
    else:
     wait_for('0 shared queued');os.write(master,b'\r');wait_for('Original response underway');os.write(master,b'followup\r');wait_for('1 pending outbox (paused)');self.assertFalse(any(x['op']=='queue.add' for x in json.loads(calls_path.read_text())));wait_for('OUTCOME_UNKNOWN' if kind=='unknown' else '1 shared queued (paused)')
    os.write(master,b'\x11');deadline=time.monotonic()+3
    while process.poll() is None and time.monotonic()<deadline:
     if select.select([master],[],[],.05)[0]:
      try:os.read(master,65536)
      except OSError:break
    self.assertEqual(process.wait(timeout=1),0);calls=json.loads(calls_path.read_text());saved=json.loads(saved_path.read_text());adds=[x['args'] for x in calls if x['op']=='queue.add']
    if kind=='stop':
     ops=[x['op'] for x in calls];self.assertEqual(ops.count('chat.stop'),1);stop_at=ops.index('chat.stop');self.assertEqual(ops[stop_at-1],'queue.pause');self.assertEqual(ops.count('queue.run'),1)
    elif kind=='unknown':self.assertEqual(adds,[]);self.assertTrue(saved['queue']['items'][0]['awaitingConversation']);self.assertEqual(saved['queue']['items'][0]['parentRequestId'],'parent')
    else:self.assertEqual(len(adds),1);self.assertEqual(adds[0]['conversation'],'created-chat');self.assertNotIn('new',adds[0]);self.assertNotIn('project',adds[0]);self.assertNotIn('gpt',adds[0]);self.assertEqual(saved['queue']['items'],[])
    if kind=='detach':self.assertEqual(saved['messages'][0]['delivery'],'answered')
   finally:
    if process.poll() is None:process.kill();process.wait(timeout=3)
    os.close(master)
 def test_first_project_chat_followup_waits_for_verified_id(self):self.scenario('new')
 def test_unknown_first_chat_leaves_followup_local_and_paused(self):self.scenario('unknown')
 def test_detached_first_chat_uses_complete_parent_receipt(self):self.scenario('detach')
 def test_ctrl_c_pauses_queue_before_stopping_once(self):self.scenario('stop')
if __name__=='__main__':unittest.main()
