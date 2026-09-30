"""Two-process offline PTY session persistence, with an isolated account directory."""
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


class ReopenTests(unittest.TestCase):
    def test_quit_reopen_restores_exact_draft_conversation_and_reading_position(self):
        with tempfile.TemporaryDirectory(prefix='chatgpt-reopen-') as directory:
            root = Path(directory)
            home = root / 'account-data'
            home.mkdir()
            account = {'id': 'demo', 'label': 'Demo workspace', 'baseURL': 'https://chatgpt.com', 'created': ''}
            (home / 'accounts.json').write_text(json.dumps({'version': 1, 'selected': 'demo', 'accounts': [account]}))
            fixture = root / 'fixture.wav'
            fixture.write_bytes(b'offline audio fixture')
            driver = root / 'driver.ts'
            driver.write_text("import {runTui} from "+json.dumps(str(SOURCE / 'tui-host.ts'))+";import {loadTuiSession,saveTuiSession} from "+json.dumps(str(SOURCE / 'tui-session.ts'))+";const restored=loadTuiSession('demo');await runTui('demo',{mock:true,restore:restored,restoreFromDisk:!!restored,onCheckpoint:state=>saveTuiSession('demo',state)});")
            env = dict(os.environ, CHATGPT_HOME=str(home))
            processes = []

            def launch():
                master, slave = pty.openpty()
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 180, 0, 0))
                process = subprocess.Popen([shutil.which('bun'), str(driver)], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=root, close_fds=True)
                os.close(slave)
                processes.append((process, master))
                return process, master

            def wait_for(process, master, expected):
                output = ''
                deadline = time.monotonic()+10
                while time.monotonic() < deadline:
                    if select.select([master], [], [], .1)[0]:
                        try:
                            output += os.read(master, 65536).decode(errors='replace')
                        except OSError:
                            break
                        plain = ANSI.sub('', output)
                        if all(value in plain for value in expected):
                            return plain
                    if process.poll() is not None:
                        break
                self.fail('Missing '+repr(expected)+': '+ANSI.sub('', output)[-4000:])

            def finish(process, master):
                deadline = time.monotonic()+8
                while process.poll() is None and time.monotonic() < deadline:
                    if select.select([master], [], [], .1)[0]:
                        try:
                            os.read(master, 65536)
                        except OSError:
                            break
                return process.wait(timeout=2)

            try:
                process, master = launch()
                wait_for(process, master, ['Make the first five minutes count'])
                os.write(master, b'keep this draft')
                wait_for(process, master, ['keep this draft'])
                os.write(master, b'\x1ba')
                wait_for(process, master, ['Attach local image, audio or document'])
                os.write(master, str(fixture).encode()+b'\r')
                wait_for(process, master, ['Attached locally'])
                os.write(master, b'\x1b[5~')
                time.sleep(.1)
                os.write(master, b'\x11')
                self.assertEqual(finish(process, master), 0)
                checkpoint = next(home.rglob('tui-session.json'))
                saved = json.loads(checkpoint.read_text())['ui']
                self.assertEqual(saved['draft'], 'keep this draft')
                self.assertTrue(all(message.get('timestamp') and message.get('timestampSource') for message in saved['messages']))
                self.assertEqual(saved['conversation'], 'launch')
                self.assertGreater(saved['scroll'], 0)
                self.assertEqual(saved['attachments'], [str(fixture.resolve())])
                mode = checkpoint.stat().st_mode & 0o777
                self.assertEqual(mode, 0o600)
                # Reopening a previously unpaused queue must not send it.
                envelope = json.loads(checkpoint.read_text())
                envelope['ui']['queue'] = {'paused': False, 'items': [{'id': 'queued', 'text': 'do not autosend', 'files': []}]}
                checkpoint.write_text(json.dumps(envelope))
                second, second_master = launch()
                wait_for(second, second_master, ['keep this draft', '1 attached (pending)', '1 local queued (paused)', 'Restored last conversation'])
                os.write(second_master, b'\x11')
                self.assertEqual(finish(second, second_master), 0)
                resumed = json.loads(checkpoint.read_text())['ui']
                self.assertEqual(resumed['scroll'], saved['scroll'])
                self.assertEqual([(message.get('timestamp'), message.get('timestampSource')) for message in resumed['messages']], [(message.get('timestamp'), message.get('timestampSource')) for message in saved['messages']])
                self.assertEqual(resumed['conversation'], 'launch')
                self.assertEqual(resumed['queue']['items'][0]['text'], 'do not autosend')
                self.assertTrue(resumed['queue']['paused'])
            finally:
                for process, master in processes:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
                    os.close(master)


if __name__ == '__main__':
    unittest.main()
