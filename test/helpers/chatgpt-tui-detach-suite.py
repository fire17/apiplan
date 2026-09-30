"""Ctrl+Q detaches an active client request without sending chat.stop."""
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

SOURCE = Path(__file__).resolve().parents[2] / 'src' / 'chatgpt'
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')


class DetachTests(unittest.TestCase):
    def test_active_quit_exits_promptly_and_never_requests_website_stop(self):
        with tempfile.TemporaryDirectory(prefix='chatgpt-detach-') as directory:
            root = Path(directory)
            log = root / 'operations.json'
            checkpoint = root / 'checkpoint.json'
            driver = root / 'driver.ts'
            driver.write_text("import {runTui} from "+json.dumps(str(SOURCE/'tui-host.ts'))+";import {mockClient} from "+json.dumps(str(SOURCE/'tui-mock.ts'))+";import {writeFileSync} from 'node:fs';const mock=mockClient(),ops:string[]=[];await runTui(undefined,{mock:true,mockRpc:async(op,args,event,signal)=>{ops.push(op);writeFileSync("+json.dumps(str(log))+",JSON.stringify(ops));return mock(op,args,event,signal);},onCheckpoint:state=>writeFileSync("+json.dumps(str(checkpoint))+",JSON.stringify(state))});")
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 180, 0, 0))
            process = subprocess.Popen([shutil.which('bun'), str(driver)], stdin=slave, stdout=slave, stderr=slave, cwd=root, close_fds=True)
            os.close(slave)

            def wait_for(expected):
                output = ''
                deadline = time.monotonic()+8
                while time.monotonic()<deadline:
                    if select.select([master], [], [], .1)[0]:
                        try:
                            output += os.read(master, 65536).decode(errors='replace')
                        except OSError:
                            break
                        if expected in ANSI.sub('', output):
                            return
                self.fail('Missing '+expected+': '+ANSI.sub('', output)[-2000:])

            try:
                wait_for('Make the first five minutes count')
                os.write(master, b'keep generating after client quit\r')
                wait_for('THINKING · website activity')
                started=time.monotonic()
                os.write(master, b'\x11')
                while process.poll() is None and time.monotonic()-started<3:
                    if select.select([master], [], [], .02)[0]:
                        try:
                            os.read(master,65536)
                        except OSError:
                            break
                self.assertEqual(process.wait(timeout=1),0)
                self.assertLess(time.monotonic()-started,1.0)
                operations=json.loads(log.read_text())
                self.assertIn('chat.send',operations)
                self.assertNotIn('chat.stop',operations)
                self.assertTrue(json.loads(checkpoint.read_text())['inFlight'])
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                os.close(master)


if __name__ == '__main__':
    unittest.main()
