"""Passive, per-owned-tab receipts from the page's existing generation requests.

No HTTP requests, headers, credentials or response bodies are persisted. [DONE]
and loadingFinished alone never establish an authoritative assistant response.
"""
import base64
import hashlib
import json
import os
import time
from pathlib import Path
from urllib.parse import urlparse

GENERATION_PATHS = {'/backend-api/conversation', '/backend-api/f/conversation'}
MAX_BODY_BYTES = 4 * 1024 * 1024


def parse_generation_sse(body):
    result = {'done': False, 'packets': 0, 'parseErrors': 0, 'schemas': [], 'eventTypes': [], 'messages': [], 'conversation': None, 'streamError': False, 'packetMetadata': []}
    messages = {}
    current_id = None
    continuation = None
    current_channel = None
    schemas, event_types = set(), set()
    for block in body.replace('\r\n', '\n').split('\n\n'):
        data = '\n'.join(line[5:].lstrip(' ') for line in block.split('\n') if line.startswith('data:'))
        for line in block.split('\n'):
            if line.startswith('event:'):
                value = line[6:].strip()
                if value == 'error':
                    result['streamError'] = True
                event_types.add(value if value in ('message', 'delta', 'done', 'error', 'ping', 'completion') else 'other')
        if not data:
            continue
        if data.strip() == '[DONE]':
            result['done'] = True
            continue
        try:
            packet = json.loads(data)
        except (ValueError, TypeError):
            result['parseErrors'] += 1
            continue
        result['packets'] += 1
        if isinstance(packet, dict) and (packet.get('error') or packet.get('type') == 'error'):
            result['streamError'] = True
        if not isinstance(packet, dict):
            result['parseErrors'] += 1
            continue
        schemas.add(','.join(sorted(key for key in packet if key in ('message', 'conversation_id', 'error', 'type', 'p', 'o', 'v', 'c'))))
        def shape(value, depth=0):
            if isinstance(value, dict):
                return {key: shape(item, depth + 1) for key, item in value.items()} if depth < 4 else {'objectKeys': list(value)}
            if isinstance(value, list):
                return [shape(item, depth + 1) for item in value[:8]] if depth < 4 else {'arrayLength': len(value)}
            if isinstance(value, str):
                return value if value in ('assistant', 'user', 'final', 'analysis', 'text', 'in_progress', 'finished_successfully', 'append', 'replace', 'patch', 'add', 'done') else {'stringLength': len(value)}
            return type(value).__name__
        if len(result['packetMetadata']) < 80:
            result['packetMetadata'].append({'keys': list(packet), 'path': packet.get('p'), 'operation': packet.get('o'), 'valueShape': shape(packet.get('v'))})

        envelope = packet.get('v') if isinstance(packet.get('v'), dict) and 'message' in packet['v'] else packet
        if isinstance(envelope.get('conversation_id'), str):
            result['conversation'] = envelope['conversation_id']
        message = envelope.get('message')
        if isinstance(message, dict) and isinstance(message.get('id'), str):
            continuation = None
            current_channel = packet.get('c')
            current_id = message['id']
            messages[current_id] = message
        # Observed compressed SSE packets omit p/o on subsequent string appends.
        # Inherit only a proven text-append path for the same current message.
        if isinstance(packet.get('v'), str) and set(packet).issubset({'v', 'c'}):
            if continuation == current_id and current_id is not None and ('c' not in packet or packet['c'] == current_channel):
                packet = dict(packet, p='/message/content/parts/0', o='append')
            else:
                result['parseErrors'] += 1
        if 'p' in packet or 'o' in packet:
            continuation = current_id if packet.get('p') == '/message/content/parts/0' and packet.get('o') == 'append' and isinstance(packet.get('v'), str) else None
        # Observed delta encoding sends a full v.message, then o=patch with a list
        # of explicit p/o/v mutations. Only known text/status paths are applied.
        patches = packet.get('v') if packet.get('o') == 'patch' and isinstance(packet.get('v'), list) else [packet]
        for patch in patches:
            if not isinstance(patch, dict):
                result['parseErrors'] += 1
                continue
            path, operation, value = patch.get('p'), patch.get('o'), patch.get('v')
            current = messages.get(current_id)
            semantic = isinstance(path, str) and (path == '/message' or any(path == prefix or path.startswith(prefix + '/') for prefix in ('/message/status', '/message/channel', '/message/author', '/message/id', '/message/content')))
            applied = False
            if current and path == '/message/status' and operation in ('replace', 'add') and isinstance(value, str):
                current['status'] = value
                applied = True
            elif current and path == '/message/content/parts/0' and operation in ('append', 'replace') and isinstance(value, str):
                content = current.get('content', {})
                parts = content.get('parts')
                if content.get('content_type') == 'text' and isinstance(parts, list) and len(parts) == 1 and isinstance(parts[0], str):
                    parts[0] = parts[0] + value if operation == 'append' else value
                    applied = True
            if semantic and not applied:
                result['parseErrors'] += 1
    for message in messages.values():
        content = message.get('content') or {}
        parts = content.get('parts')
        if message.get('author', {}).get('role') != 'assistant' or message.get('channel') not in (None, 'final'):
            continue
        if message.get('status') != 'finished_successfully' or content.get('content_type') != 'text' or not isinstance(parts, list) or not parts or not all(isinstance(part, str) for part in parts):
            continue
        result['messages'].append({'id': message['id'], 'role': 'assistant', 'status': 'finished_successfully', 'text': '\n'.join(parts)})
    result['schemas'] = sorted(schemas)
    result['eventTypes'] = sorted(event_types)
    result['authoritative'] = bool(result['messages']) and result['parseErrors'] == 0 and not result['streamError']
    return result


class GenerationObserver:
    def __init__(self, tab, cdp, metadata_directory=None):
        self.tab, self.cdp = tab, cdp
        self.metadata_directory = Path(metadata_directory) if metadata_directory else None
        self.requests = {}
        self.sequence = 0
        self.handlers = [(cdp.network.RequestWillBeSent, self.request), (cdp.network.ResponseReceived, self.response), (cdp.network.LoadingFinished, self.finished), (cdp.network.LoadingFailed, self.failed)]
        for event, handler in self.handlers:
            tab.add_handler(event, handler)

    async def request(self, event):
        request = event.request
        parsed = urlparse(request.url)
        if parsed.scheme != 'https' or parsed.netloc != 'chatgpt.com' or parsed.path not in GENERATION_PATHS or request.method != 'POST':
            return
        try:
            payload = json.loads(request.post_data or '{}')
        except (ValueError, TypeError):
            payload = {}
        self.sequence += 1
        key = str(event.request_id.to_json())
        user_ids = [message['id'] for message in payload.get('messages', []) if isinstance(message, dict) and message.get('author', {}).get('role') == 'user' and isinstance(message.get('id'), str)]
        self.requests[key] = {'id': key, 'sequence': self.sequence, 'endpoint': parsed.path, 'started': time.time(), 'userIds': user_ids, 'conversation': payload.get('conversation_id'), 'phase': 'requested'}
        if len(self.requests) > 32:
            for old in list(self.requests)[:-32]:
                self.requests.pop(old, None)

    async def response(self, event):
        record = self.requests.get(str(event.request_id.to_json()))
        if not record:
            return
        record.update(status=int(event.response.status), mime=str(event.response.mime_type), phase='response')
        self.persist(record)

    async def finished(self, event):
        key = str(event.request_id.to_json())
        record = self.requests.get(key)
        if not record:
            return
        record['loadingFinished'] = True
        if record.get('status') != 200 or record.get('mime', '').split(';')[0].strip() != 'text/event-stream':
            record['phase'] = 'unverified-response'
            self.persist(record)
            return
        try:
            body, encoded = await self.tab.send(self.cdp.network.get_response_body(event.request_id))
            if encoded:
                body = base64.b64decode(body).decode('utf-8')
            if len(body.encode('utf-8')) > MAX_BODY_BYTES:
                raise ValueError('Generation response exceeds observation limit.')
            receipt = parse_generation_sse(body)
            if record.get('conversation') and receipt.get('conversation') and record['conversation'] != receipt['conversation']:
                receipt['authoritative'] = False
                record['error'] = 'conversation-mismatch'
            record['receipt'] = receipt
            record['phase'] = 'complete' if receipt['authoritative'] else 'transport-complete-content-unverified'
        except Exception:
            record['phase'] = 'body-unavailable'
            record['error'] = 'observed-response-body-unavailable'
        self.persist(record)

    async def failed(self, event):
        record = self.requests.get(str(event.request_id.to_json()))
        if record:
            record['phase'] = 'network-failed'
            self.persist(record)

    def persist(self, record):
        if self.metadata_directory is None:
            return
        receipt = record.get('receipt', {})
        metadata = {key: record[key] for key in ('sequence', 'endpoint', 'started', 'phase', 'status', 'mime', 'loadingFinished', 'error') if key in record}
        metadata.update(userIdCount=len(record['userIds']), done=receipt.get('done', False), packets=receipt.get('packets', 0), streamError=receipt.get('streamError', False), parseErrors=receipt.get('parseErrors', 0), schemas=receipt.get('schemas', []), eventTypes=receipt.get('eventTypes', []), packetMetadata=receipt.get('packetMetadata', []), assistantMessages=[{'characters': len(message['text']), 'sha256': hashlib.sha256(message['text'].encode()).hexdigest(), 'status': message['status']} for message in receipt.get('messages', [])])
        self.metadata_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.metadata_directory, 0o700)
        name = hashlib.sha256((str(id(self.tab)) + ':' + record['id']).encode()).hexdigest() + '.json'
        path = self.metadata_directory / name
        temp = path.with_suffix('.tmp')
        with open(temp, 'w', opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            json.dump(metadata, stream, indent=2)
        os.replace(temp, path)
        os.chmod(path, 0o600)

    def receipt(self, user_ids, conversation=None, after=0):
        wanted = set(user_ids or [])
        if not wanted:
            return {'authoritative': False, 'reason': 'observed submitted user IDs required', 'sequence': self.sequence}
        candidates = [record for record in self.requests.values() if record['sequence'] > after and wanted.intersection(record['userIds'])]
        if len(candidates) != 1:
            return {'authoritative': False, 'reason': 'generation request missing or ambiguous', 'matches': len(candidates), 'sequence': self.sequence}
        record = candidates[0]
        receipt = record.get('receipt', {})
        observed_conversation = receipt.get('conversation') or record.get('conversation')
        verified = bool(receipt.get('authoritative')) and bool(observed_conversation) and (not conversation or conversation == observed_conversation)
        result = {'authoritative': verified, 'sequence': record['sequence'], 'phase': record['phase'], 'transportComplete': record.get('loadingFinished', False), 'done': receipt.get('done', False), 'conversation': observed_conversation, 'source': 'observed page generation response', 'additionalRequests': 0}
        if verified:
            result.update(messages=receipt['messages'], text='\n\n'.join(message['text'] for message in receipt['messages']))
        return result

    def close(self):
        for event, handler in self.handlers:
            handlers = getattr(self.tab, 'handlers', {}).get(event, [])
            if handler in handlers:
                handlers.remove(handler)
