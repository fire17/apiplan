import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
import unittest

SOURCE=Path(__file__).resolve().parents[2]/'src'/'chatgpt'
ANSI=re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')


class SubmissionTests(unittest.TestCase):
    def run_case(self, known):
        with tempfile.TemporaryDirectory(prefix='chatgpt-submission-') as directory:
            root=Path(directory);state=root/'state.json';calls=root/'calls.json';driver=root/'driver.ts'
            failure="event?.({type:'submission.failed',submissionState:'not-submitted'});throw Object.assign(new Error('Preparation failed'),{code:'NOT_SUBMITTED',submissionState:'not-submitted'});" if known else "throw Object.assign(new Error('Response timed out'),{code:'OUTCOME_UNKNOWN',requestId:'request-1'});"
            driver.write_text("import {runTui} from "+json.dumps(str(SOURCE/'tui-host.ts'))+";import {mockClient} from "+json.dumps(str(SOURCE/'tui-mock.ts'))+";import {writeFileSync} from 'node:fs';const mock=mockClient();let sends=0;await runTui(undefined,{mock:true,mockRpc:async(op,args,event,signal)=>{if(op==='chat.send'){writeFileSync("+json.dumps(str(calls))+",JSON.stringify(++sends));"+failure+"}return mock(op,args,event,signal);},onCheckpoint:value=>writeFileSync("+json.dumps(str(state))+",JSON.stringify(value))});")
            master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,180,0,0))
            process=subprocess.Popen([shutil.which('bun'),str(driver)],stdin=slave,stdout=slave,stderr=slave,cwd=root,close_fds=True);os.close(slave)
            def wait_for(expected):
                output='';deadline=time.monotonic()+8
                while time.monotonic()<deadline:
                    if select.select([master],[],[],.1)[0]:
                        try:output+=os.read(master,65536).decode(errors='replace')
                        except OSError:break
                        if expected in ANSI.sub('',output):return
                self.fail('Missing '+expected+': '+ANSI.sub('',output)[-1500:])
            try:
                wait_for('Make the first five minutes count');os.write(master,b'attempt\r')
                wait_for('Not submitted' if known else 'OUTCOME_UNKNOWN')
                if not known:
                    os.write(master,b'attempt\r');wait_for('Identical submission is unconfirmed')
                os.write(master,b'\x11');deadline=time.monotonic()+5
                while process.poll() is None and time.monotonic()<deadline:
                    if select.select([master],[],[],.05)[0]:
                        try:os.read(master,65536)
                        except OSError:break
                self.assertEqual(process.wait(timeout=1),0)
                saved=json.loads(state.read_text());self.assertEqual(saved['draft'],'attempt');self.assertEqual(json.loads(calls.read_text()),1)
                self.assertEqual(len([message for message in saved['messages'] if message['role']=='user' and message['text']=='attempt']),0 if known else 1)
            finally:
                if process.poll() is None:process.kill();process.wait(timeout=5)
                os.close(master)

    def test_not_submitted_restores_draft_without_fake_user_message(self):self.run_case(True)
    def test_unknown_submission_blocks_identical_retry(self):self.run_case(False)

if __name__=='__main__':unittest.main()
