import asyncio
import base64
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'chatgpt'))
class Fetch:
    class RequestPaused:
        pass
    class RequestStage:
        RESPONSE = 'response'
    @staticmethod
    def RequestPattern(**kwargs):
        return kwargs
    @staticmethod
    def enable(**kwargs):
        return ('enable', kwargs)
    @staticmethod
    def disable():
        return ('disable', {})

nodriver = types.ModuleType('nodriver')
nodriver.cdp = types.SimpleNamespace(fetch=Fetch)
sys.modules.setdefault('nodriver', nodriver)
import audio_input


class Tab:
    def __init__(self):
        self.handlers = {Fetch.RequestPaused: []}
        self.commands = []
        self.fail_enable = None
        self.fail_disable = None

    def add_handler(self, event, handler):
        self.handlers.setdefault(event, []).append(handler)

    async def send(self, command):
        self.commands.append(command)
        if command[0] == 'enable' and self.fail_enable:
            raise self.fail_enable
        if command[0] == 'disable' and self.fail_disable:
            raise self.fail_disable


class Worker:
    def __init__(self, result=None, error=None, inspect=None):
        self.result = result or {'prepared': True}
        self.error = error
        self.inspect = inspect
        self.scripts = []
        self.tab = Tab()
        self.audio_capture = None

    async def evaluate(self, script):
        self.scripts.append(script)
        if self.inspect:
            self.inspect(script)
        if self.error:
            raise self.error
        return self.result


class AudioInputTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='apiplan-audio-input-')
        self.root = Path(self.directory.name)

    async def asyncTearDown(self):
        self.directory.cleanup()

    async def test_accepts_only_bounded_explicit_audio_and_embeds_fixture_bytes(self):
        fixture = self.root / 'fixture.wav'
        fixture.write_bytes(b'RIFF fixture audio bytes')
        worker = Worker(result={'prepared': True, 'ambientMicrophone': False})
        result = await audio_input.prepare(worker, {'path': str(fixture)})
        self.assertEqual(result, {'prepared': True, 'ambientMicrophone': False})
        self.assertEqual(len(worker.scripts), 1)
        self.assertIn(base64.b64encode(fixture.read_bytes()).decode(), worker.scripts[0])
        self.assertIn("source:'explicit local audio file'", worker.scripts[0])
        self.assertIn('ambientMicrophone:false', worker.scripts[0])
        self.assertIsNotNone(worker.audio_capture)
        await audio_input.clear(worker)
        self.assertIsNone(worker.audio_capture)

    async def test_rejects_unsupported_empty_and_oversized_inputs_before_browser_evaluation(self):
        unsupported = self.root / 'fixture.txt'
        unsupported.write_text('not audio')
        empty = self.root / 'empty.wav'
        empty.touch()
        oversized = self.root / 'oversized.wav'
        with oversized.open('wb') as stream:
            stream.seek(16 * 1024 * 1024)
            stream.write(b'x')
        worker = Worker()
        with self.assertRaisesRegex(ValueError, 'requires a WAV'):
            await audio_input.prepare(worker, {'path': str(unsupported)})
        for path in (empty, oversized):
            with self.assertRaisesRegex(ValueError, 'nonempty and at most 16 MiB'):
                await audio_input.prepare(worker, {'path': str(path)})
        self.assertEqual(worker.scripts, [])

    async def test_rejects_missing_paths_and_directories_with_actionable_validation(self):
        directory = self.root / 'directory.wav'
        directory.mkdir()
        worker = Worker()
        for args in ({}, {'path': None}, {'path': ' '}):
            with self.assertRaisesRegex(ValueError, 'explicit local file path'):
                await audio_input.prepare(worker, args)
        with self.assertRaisesRegex(ValueError, 'regular file'):
            await audio_input.prepare(worker, {'path': str(directory)})
        self.assertEqual(worker.scripts, [])

    async def test_decode_failure_script_closes_context_before_exposing_global_state(self):
        fixture = self.root / 'decode.wav'
        fixture.write_bytes(b'RIFF intentionally invalid')

        def inspect(script):
            decode = script.index('decodeAudioData')
            cleanup = script.index('await context.close()', decode)
            actionable = script.index('Browser could not decode this audio file', cleanup)
            expose = script.index('window.__apiplanAudioInput=state', actionable)
            self.assertLess(decode, cleanup)
            self.assertLess(cleanup, actionable)
            self.assertLess(actionable, expose)

        worker = Worker(error=RuntimeError('simulated browser decode rejection'), inspect=inspect)
        with self.assertRaisesRegex(RuntimeError, 'simulated browser decode rejection'):
            await audio_input.prepare(worker, {'path': str(fixture)})
        self.assertEqual(len(worker.scripts), 1)

    async def test_clear_script_restores_media_devices_and_releases_every_owned_resource(self):
        required = ['navigator.mediaDevices.getUserMedia=s.original', 's.source?.stop()', 't=>t.stop()', 'await s.context.close()', 'delete window.__apiplanAudioInput']
        worker = Worker(inspect=lambda script: [self.assertIn(fragment, script) for fragment in required])
        await audio_input.clear(worker)
        self.assertEqual(len(worker.scripts), 1)

    async def test_clear_restores_browser_state_even_when_capture_disable_fails(self):
        worker = Worker(result={'cleared': True})
        handler = object()
        worker.tab.handlers[Fetch.RequestPaused].append(handler)
        worker.audio_capture = {'tab': worker.tab, 'handler': handler, 'receipt': None}
        worker.tab.fail_disable = RuntimeError('disable failed')
        result = await audio_input.clear(worker)
        self.assertEqual(result, {'cleared': True})
        self.assertIsNone(worker.audio_capture)
        self.assertNotIn(handler, worker.tab.handlers[Fetch.RequestPaused])
        self.assertEqual(len(worker.scripts), 1)

    async def test_prepare_preserves_capture_error_when_cleanup_evaluation_also_fails(self):
        fixture = self.root / 'capture.wav'
        fixture.write_bytes(b'RIFF capture fixture')

        class CleanupFailureWorker(Worker):
            async def evaluate(self, script):
                self.scripts.append(script)
                if len(self.scripts) == 1:
                    return {'prepared': True}
                raise RuntimeError('cleanup evaluation failed')

        worker = CleanupFailureWorker()
        worker.tab.fail_enable = RuntimeError('capture enable failed')
        with self.assertRaisesRegex(RuntimeError, 'capture enable failed'):
            await audio_input.prepare(worker, {'path': str(fixture)})
        self.assertEqual(len(worker.scripts), 2)
        self.assertIsNone(worker.audio_capture)


if __name__ == '__main__':
    unittest.main()
