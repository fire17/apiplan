"""Offline PTY exercise: model changes, thinking, validated hot reload and rollback."""
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


class TuiReloadTests(unittest.TestCase):
    def test_draft_palette_verified_model_and_bad_revision_survive_in_one_process(self):
        with tempfile.TemporaryDirectory(prefix='chatgpt-tui-pty-') as directory:
            root = Path(directory)
            for source in SOURCE.glob('tui*.ts'):
                (root / source.name).write_text(source.read_text().replace("'./freeze.ts'", json.dumps(str(SOURCE / 'freeze.ts'))).replace("'./accounts.ts'", json.dumps(str(SOURCE / 'accounts.ts'))).replace("'./daemon.ts'", json.dumps(str(SOURCE / 'daemon.ts'))).replace("'./message-time.ts'", json.dumps(str(SOURCE / 'message-time.ts'))).replace("'./slash.ts'", json.dumps(str(SOURCE / 'slash.ts'))))
            fixture = root / 'attached.png'
            fixture.write_bytes(b'offline attachment fixture')
            sent = root / 'last-send.json'
            mock = root / 'tui-mock.ts'
            mock.write_text(mock.read_text().replace("case 'chat.send':{", "case 'chat.send':{await Bun.write("+json.dumps(str(sent))+",JSON.stringify(args));"))
            view = root / 'tui.ts'
            code = view.read_text().replace("'./freeze.ts'", json.dumps(str(SOURCE / 'freeze.ts'))).replace("'./accounts.ts'", json.dumps(str(SOURCE / 'accounts.ts'))).replace("'./daemon.ts'", json.dumps(str(SOURCE / 'daemon.ts'))).replace("'./message-time.ts'", json.dumps(str(SOURCE / 'message-time.ts'))).replace("'./slash.ts'", json.dumps(str(SOURCE / 'slash.ts')))
            view.write_text(code)
            driver = root / 'driver.ts'
            driver.write_text("import {runTui} from './tui-host.ts';await runTui(undefined,{mock:true});")
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 240, 0, 0))
            process = subprocess.Popen([shutil.which('bun'), str(driver)], stdin=slave, stdout=slave, stderr=slave, cwd=root, close_fds=True)
            os.close(slave)

            def wait_for(expected, timeout=12):
                deadline = time.monotonic() + timeout
                output = ''
                while time.monotonic() < deadline:
                    if select.select([master], [], [], .1)[0]:
                        try:
                            output += os.read(master, 65536).decode(errors='replace')
                        except OSError:
                            break
                        if all(value in ANSI.sub('', output) for value in (expected if isinstance(expected, tuple) else (expected,))):
                            return ANSI.sub('', output)
                    if process.poll() is not None:
                        break
                self.fail('Missing '+repr(expected)+' in terminal output: '+ANSI.sub('', output)[-5000:])

            try:
                wait_for('Make the first five minutes count')
                os.write(master, b'\x1bm')
                wait_for('MODEL · applies immediately')
                # Chat model menu starts with the Work-mode switch, then Latest.
                os.write(master, b'\x1b[B\x1b[B\r')
                wait_for('Website verified model · GPT-5.6 Sol')
                os.write(master, b'\x1ba')
                wait_for('Attach local image, audio or document')
                os.write(master, str(fixture).encode()+b'\r')
                wait_for('Attached locally')
                os.write(master, b'draft survives hot reload')
                wait_for('draft survives hot reload')
                view.write_text(code.replace('◈ CHATGPT', '◈ RELOADED'))
                output = wait_for('Update loaded · session preserved')
                self.assertIn('RELOADED', output)
                self.assertIn('draft survives hot reload', output)
                self.assertIn('GPT-5.6 Sol', output)
                self.assertIn('1 attached (pending)', output)
                os.write(master, b'\x0bmodel')
                wait_for('model▏')
                view.write_text(code.replace('◈ CHATGPT', '◈ RELOADED AGAIN'))
                output = wait_for(('RELOADED AGAIN', 'model▏', 'Update loaded · session preserved'))
                self.assertIn('Select model', output)
                self.assertIn('model▏', output)
                view.write_text(code + '\n const syntax_error = ;\n')
                output = wait_for('Update rejected; current view retained')
                self.assertIn('RELOADED AGAIN', output)
                self.assertIn('draft survives hot reload', output)
                os.write(master, b'\x1b')
                time.sleep(.08)
                os.write(master, b'\x15hello\r')
                output = wait_for('THINKING · website activity')
                self.assertIn('simulated website activity', output)
                self.assertEqual(json.loads(sent.read_text())['files'], [str(fixture.resolve())])
                os.write(master, b'queued request\r')
                wait_for('1 local queued')
                os.write(master, b'\x1bq')
                wait_for('LOCAL QUEUE · paused for editing')
                os.write(master, b'\x1b\x1b')
                time.sleep(.08)
                view.write_text(code.replace('◈ CHATGPT', '◈ QUEUED RELOAD'))
                wait_for('update pending')
                output = wait_for(('QUEUED RELOAD', 'Update loaded · session preserved', '1 local queued (paused)'))
                self.assertIn('simulated website activity', output)
                os.write(master, b'\x1bq')
                wait_for('Resume local queue')
                os.write(master, b'\r')
                wait_for('Response complete')
                os.write(master, b'\x11')
                self.assertEqual(process.wait(timeout=5), 0)
            finally:
                if process.poll() is None:
                    process.terminate()
                    
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                os.close(master)


if __name__ == '__main__':
    unittest.main()
