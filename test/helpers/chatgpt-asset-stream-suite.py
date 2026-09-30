import asyncio
import base64
import hashlib
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).parents[2] / 'src' / 'chatgpt' / 'asset_stream.py'
SPEC = importlib.util.spec_from_file_location('asset_stream_under_test', SOURCE)
asset_stream = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(asset_stream)


class FakeWorker:
    def __init__(self, frames=(), status=200):
        self.api_tab = object()
        self.frames = list(frames)
        self.status = status
        self.cleaned = False
        self.frame_expression_bounded = False

    async def evaluate(self, expression, _tab):
        if 'delete window.__apiplanAssets' in expression:
            self.cleaned = True
            return True
        if '__apiplanAssets??=' in expression:
            return {'status': self.status, 'contentType': 'application/octet-stream'}
        self.frame_expression_bounded = 'subarray(0,262144)' in expression
        if not self.frames:
            return {'done': True}
        frame = self.frames.pop(0)
        if isinstance(frame, Exception):
            raise frame
        if isinstance(frame, str):
            return {'done': False, 'base64': frame}
        return {'done': False, 'base64': base64.b64encode(frame).decode()}


class AssetStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_success_is_bounded_private_and_hashed(self):
        payload = b'a' * 262144 + b'final'
        worker = FakeWorker([payload[:262144], payload[262144:]])
        with tempfile.TemporaryDirectory() as directory:
            result = await asset_stream.download(worker, {
                'path': '/backend-api/estuary/content?id=file_fixture',
                'directory': directory,
                'maxBytes': len(payload),
            })
            output = Path(result['path'])
            self.assertEqual(output.read_bytes(), payload)
            self.assertEqual(result['size'], len(payload))
            self.assertEqual(result['sha256'], hashlib.sha256(payload).hexdigest())
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertTrue(worker.frame_expression_bounded)
            self.assertTrue(worker.cleaned)

    async def test_rejects_oversized_frame_and_removes_partial_file(self):
        worker = FakeWorker([b'x' * 262145])
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'frame exceeds'):
                await asset_stream.download(worker, {'path': '/backend-api/estuary/content?id=x', 'directory': directory})
            self.assertEqual(list(Path(directory).glob('asset-*.part')), [])
            self.assertTrue(worker.cleaned)

    async def test_size_limit_and_truncation_remove_partial_files(self):
        for frames, message in [([b'12345'], 'size limit'), ([b'ok', RuntimeError('stream cut')], 'stream cut')]:
            worker = FakeWorker(frames)
            with tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(Exception, message):
                    await asset_stream.download(worker, {
                        'path': '/backend-api/estuary/content?id=x', 'directory': directory, 'maxBytes': 4,
                    })
                self.assertEqual(list(Path(directory).glob('asset-*.part')), [])
                self.assertTrue(worker.cleaned)

    async def test_invalid_frame_and_temp_creation_failure_cleanup(self):
        worker = FakeWorker(['not-base64!'])
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(Exception):
                await asset_stream.download(worker, {'path': '/backend-api/estuary/content?id=x', 'directory': directory})
            self.assertEqual(list(Path(directory).glob('asset-*.part')), [])
            self.assertTrue(worker.cleaned)

        worker = FakeWorker([b'unused'])
        original = asset_stream.tempfile.mkstemp
        asset_stream.tempfile.mkstemp = lambda **_kwargs: (_ for _ in ()).throw(OSError('disk unavailable'))
        try:
            with tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(OSError, 'disk unavailable'):
                    await asset_stream.download(worker, {'path': '/backend-api/estuary/content?id=x', 'directory': directory})
                self.assertTrue(worker.cleaned)
        finally:
            asset_stream.tempfile.mkstemp = original

    async def test_rejects_invalid_limits_before_starting_a_stream(self):
        for limit in (0, -1, True, 512*1024*1024 + 1):
            worker = FakeWorker([b'unused'])
            with tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(ValueError, 'size limit'):
                    await asset_stream.download(worker, {
                        'path': '/backend-api/estuary/content?id=x', 'directory': directory, 'maxBytes': limit,
                    })
            self.assertFalse(worker.cleaned)


if __name__ == '__main__':
    unittest.main()
