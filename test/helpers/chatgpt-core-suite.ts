import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Application modules read CHATGPT_HOME at import time. Set the isolation boundary
// before importing any of them so this suite cannot inspect or mutate a real profile.
const TEST_HOME = join(tmpdir(), `apiplan-chatgpt-tests-${process.pid}`);
mkdirSync(TEST_HOME, { recursive: true });
process.env.CHATGPT_HOME = TEST_HOME;

const [{ Store, paginate, paginateCursor, messagePath }, accounts, adapters, monitor, { BrowserWorker }] = await Promise.all([
 import('../../src/chatgpt/store.ts'),
 import('../../src/chatgpt/accounts.ts'),
 import('../../src/chatgpt/adapters.ts'),
 import('../../src/chatgpt/monitor.ts'),
 import('../../src/chatgpt/transport.ts'),
]);

const account = (id: string) => ({
 id,
 label: id,
 baseURL: 'https://chatgpt.com',
 created: '2026-09-15T00:00:00.000Z',
 source: { provider: 'managed' as const },
});

process.on('exit', () => rmSync(TEST_HOME, { recursive: true, force: true }));

describe('offset pagination receipts', () => {
 test('walks every offset, deduplicates overlaps, and proves complete coverage', async () => {
  const offsets: number[] = [];
  const pages = new Map([
   [0, [{ id: 'a' }, { id: 'b' }]],
   [2, [{ id: 'b' }, { id: 'c' }]],
   [4, [{ id: 'd' }]],
  ]);
  const result = await paginate(async (offset, limit) => {
   offsets.push(offset);
   expect(limit).toBe(2);
   return { items: pages.get(offset) ?? [], total: 4 };
  }, 'active', { limit: 2 });

  expect(offsets).toEqual([0, 2, 4]);
  expect(result.items.map(item => item.id)).toEqual(['a', 'b', 'c', 'd']);
  expect(result.coverage).toMatchObject({ scope: 'active', complete: true, pages: 3, count: 4, total: 4 });
 });

 test('marks an ignored offset as partial instead of looping or claiming success', async () => {
  const result = await paginate(async () => ({ items: [{ id: 'a' }, { id: 'b' }], total: 4 }), 'active', { limit: 2 });
  expect(result.items.map(item => item.id)).toEqual(['a', 'b']);
  expect(result.coverage).toMatchObject({ complete: false, pages: 2, reason: 'Server repeated a page without progress.' });
 });

 test('records early termination, empty gaps, and page-budget exhaustion as partial', async () => {
  const ended = await paginate(async () => ({ items: [{ id: 'a' }], total: 3, has_more: false }), 'ended');
  expect(ended.coverage).toMatchObject({ complete: false, reason: 'Server ended before advertised total.' });

  const empty = await paginate(async () => ({ items: [], total: 3 }), 'empty');
  expect(empty.coverage).toMatchObject({ complete: false, reason: 'Empty page before advertised total.' });

  const budget = await paginate(async offset => ({ items: [{ id: `row-${offset}` }], has_more: true }), 'budget', { limit: 1, maxPages: 2 });
  expect(budget.coverage).toMatchObject({ complete: false, pages: 2, reason: 'Page budget reached.' });
 });

 test('rejects pages whose records cannot be identified', async () => {
  await expect(paginate(async () => ({ items: [{ title: 'anonymous' }] }), 'bad')).rejects.toThrow('Page record missing id.');
 });
});

describe('cursor pagination receipts', () => {
 test('follows cursors and deduplicates overlapping page boundaries', async () => {
  const visited: Array<string | undefined> = [];
  const result = await paginateCursor(async cursor => {
   visited.push(cursor);
   if (cursor === undefined) return { results: [{ id: 'a' }, { id: 'b' }], next_cursor: 'two' };
   if (cursor === 'two') return { results: [{ id: 'b' }, { id: 'c' }], nextCursor: 'three' };
   return { results: [{ id: 'd' }], has_more: false };
  }, 'gpts', { field: 'results' });

  expect(visited).toEqual([undefined, 'two', 'three']);
  expect(result.items.map(item => item.id)).toEqual(['a', 'b', 'c', 'd']);
  expect(result.coverage).toMatchObject({ complete: true, pages: 3, count: 4 });
 });

 test('detects cursor cycles and changing cursors that add no records', async () => {
  const cycle = await paginateCursor(async cursor => cursor === undefined
   ? { items: [{ id: 'a' }], next_cursor: 'again' }
   : { items: [{ id: 'b' }], next_cursor: 'again' }, 'cycle');
  expect(cycle.coverage).toMatchObject({ complete: false, pages: 2, reason: 'Cursor pagination stopped making progress.' });

  const stalled = await paginateCursor(async cursor => cursor === undefined
   ? { items: [{ id: 'a' }], next_cursor: 'one' }
   : { items: [{ id: 'a' }], next_cursor: 'two' }, 'stalled');
  expect(stalled.coverage).toMatchObject({ complete: false, pages: 2, reason: 'Cursor pagination stopped making progress.' });
 });

 test('marks a missing continuation cursor and page-budget exhaustion as partial', async () => {
  const missing = await paginateCursor(async () => ({ items: [{ id: 'a' }], has_more: true }), 'missing');
  expect(missing.coverage).toMatchObject({ complete: false, reason: 'Server says more data exists without a cursor.' });

  const budget = await paginateCursor(async cursor => ({ items: [{ id: cursor ?? 'first' }], next_cursor: `${cursor ?? 'first'}+` }), 'budget', { maxPages: 2 });
  expect(budget.coverage).toMatchObject({ complete: false, pages: 2, reason: 'Page budget reached.' });
 });
});

describe('conversation tree paths', () => {
 test('returns only the selected branch from root to the requested node', () => {
  const raw = { current_node: 'assistant-b', mapping: {
   root: { parent: null, children: ['user'], message: null },
   user: { parent: 'root', children: ['assistant-a', 'assistant-b'], message: { role: 'user', content: { parts: ['question'] } } },
   'assistant-a': { parent: 'user', children: [], message: { role: 'assistant', content: { parts: ['first branch'] } } },
   'assistant-b': { parent: 'user', children: [], message: { role: 'assistant', content: { parts: ['chosen branch'] } } },
  } };

  expect(messagePath(raw).map(node => node.node_id)).toEqual(['user', 'assistant-b']);
  expect(messagePath(raw, 'assistant-a').map(node => node.node_id)).toEqual(['user', 'assistant-a']);
 });

 test('fails closed on cycles and missing ancestors', () => {
  expect(() => messagePath({ current_node: 'a', mapping: {
   a: { parent: 'b', message: { role: 'user' } },
   b: { parent: 'a', message: { role: 'assistant' } },
  } })).toThrow('Conversation tree contains a cycle.');
  expect(() => messagePath({ current_node: 'a', mapping: {
   a: { parent: 'missing', message: { role: 'user' } },
  } })).toThrow('Conversation tree references a missing node: missing');
 });

 test('returns an empty path when the conversation has no selected node', () => {
  expect(messagePath({ mapping: {} })).toEqual([]);
 });
});

describe('account identity and data isolation', () => {
 test('separates identical record ids by account and pins each store to one user', () => {
  const first = new Store(account('first'));
  const second = new Store(account('second'));
  try {
   first.bindIdentity('user-one');
   first.bindIdentity('user-one');
   second.bindIdentity('user-two');
   first.put('chat', { id: 'same-id', title: 'first title' });
   second.put('chat', { id: 'same-id', title: 'second title' });

   expect(first.get('chat', 'same-id').title).toBe('first title');
   expect(second.get('chat', 'same-id').title).toBe('second title');
   expect(() => first.bindIdentity('user-two')).toThrow('signed in to a different user');
  } finally {
   first.close();
   second.close();
  }
 });

 test('rejects account ids that could escape their private directory', () => {
  expect(() => accounts.accountDir(account('../shared'))).toThrow('Account id must use');
 });

 test('atomic JSON preserves existing parent permissions and protects new paths', () => {
  const existing=join(TEST_HOME,'existing-public-parent');mkdirSync(existing,{recursive:true,mode:0o755});chmodSync(existing,0o755);
  const existingFile=join(existing,'receipt.json');accounts.atomicJSON(existingFile,{ok:true});
  const created=join(TEST_HOME,'new-private-parent'),createdFile=join(created,'state.json');accounts.atomicJSON(createdFile,{private:true});
  expect(JSON.parse(readFileSync(existingFile,'utf8'))).toEqual({ok:true});
  if(process.platform!=='win32'){
   expect(statSync(existing).mode&0o777).toBe(0o755);
   expect(statSync(existingFile).mode&0o777).toBe(0o600);
   expect(statSync(created).mode&0o777).toBe(0o700);
   expect(statSync(createdFile).mode&0o777).toBe(0o600);
  }
 });
});

describe('adapter validation and hot loading', () => {
 const revision = (version: string, models: string) => ({
  ...structuredClone(adapters.BUILTIN),
  version,
  routes: { ...adapters.BUILTIN.routes, models },
 });

 test('rejects unsafe routes and malformed selector or label tables', () => {
  expect(() => adapters.validateAdapter(revision('external', 'https://evil.example/backend-api/models'))).toThrow('Unsafe adapter route');
  expect(() => adapters.validateAdapter(revision('traversal', '/backend-api/../api/auth/session'))).toThrow('Unsafe adapter route');
  expect(() => adapters.validateAdapter({ ...revision('selectors', '/backend-api/models'), selectors: { ...adapters.BUILTIN.selectors, composer: '#prompt' } })).toThrow('Invalid adapter selectors.composer');
  expect(() => adapters.validateAdapter({ ...revision('labels', '/backend-api/models'), labels: { ...adapters.BUILTIN.labels, settings: [42] } })).toThrow('Invalid adapter labels.settings');
 });

 test('requires every built-in key and at least one usable selector and label', () => {
  const missing = revision('missing-models', '/backend-api/models');
  delete missing.routes.models;
  expect(() => adapters.validateAdapter(missing)).toThrow('Adapter missing required route: models');
  expect(() => adapters.validateAdapter({ ...revision('empty-selector', '/backend-api/models'), selectors: { ...adapters.BUILTIN.selectors, composer: [] } })).toThrow('Invalid adapter selectors.composer');
  expect(() => adapters.validateAdapter({ ...revision('empty-label', '/backend-api/models'), labels: { ...adapters.BUILTIN.labels, settings: [''] } })).toThrow('Invalid adapter labels.settings');
 });

 test('an invalid promotion leaves the active adapter untouched', () => {
  const before = adapters.adapter().version;
  expect(() => adapters.promoteAdapter(revision('bad', '/not-backend/models'))).toThrow('Unsafe adapter route');
  expect(adapters.adapter().version).toBe(before);
 });

 test('route reads the promoted revision at every operation boundary', () => {
  const first = adapters.promoteAdapter(revision('one', '/backend-api/models?revision=one'));
  expect(first).toMatchObject({ active: 'one', hotloaded: true, validation: { structural: true, behaviorallyTested: false }, diff: { routes: { changed: ['models'] } } });
  expect(adapters.route('models')).toBe('/backend-api/models?revision=one');
  adapters.promoteAdapter(revision('two', '/backend-api/models?revision=two'));
  expect(adapters.route('models')).toBe('/backend-api/models?revision=two');
  expect(adapters.route('conversation', 'id/with spaces')).toBe('/backend-api/conversation/id%2Fwith%20spaces');
 });

 test('retains last-good on a broken update, diagnoses its signature, then accepts repaired bytes', () => {
  writeFileSync(join(TEST_HOME, 'adapters', 'current.json'), '{broken json\n');
  expect(adapters.adapter().version).toBe('two');
  const rejected = adapters.adapterDiagnostic();
  expect(rejected).toMatchObject({ ok: false, source: 'last-good', active: 'two' });
  expect(rejected.rejectedSignature).toHaveLength(64);
  expect(rejected.error).toContain('JSON');

  accounts.atomicJSON(join(TEST_HOME, 'adapters', 'current.json'), revision('repaired', '/backend-api/models?revision=repaired'));
  expect(adapters.route('models')).toBe('/backend-api/models?revision=repaired');
  expect(adapters.adapterDiagnostic()).toMatchObject({ ok: true, source: 'current', active: 'repaired' });
 });

 test('rolls back by version from immutable signature-addressed history', () => {
  adapters.promoteAdapter(revision('rollback-target', '/backend-api/models?revision=target'));
  adapters.promoteAdapter(revision('rollback-away', '/backend-api/models?revision=away'));
  const receipt = adapters.rollbackAdapter('rollback-target');
  expect(receipt).toMatchObject({ active: 'rollback-target', previous: 'rollback-away', reason: 'rollback', validation: { structural: true, behaviorallyTested: false } });
  expect(adapters.route('models')).toBe('/backend-api/models?revision=target');
  expect(receipt.historyPath).toContain(receipt.previousSignature.slice(0, 12));
 });

 test('ships the observed maximum GPT bootstrap limit', () => {
  expect(adapters.BUILTIN.routes.gpts).toContain('limit=20');
 });
});

describe('error classification', () => {
 test.each([
  ['Sign in to ChatGPT first', 'AUTH_REQUIRED', false],
  ['403 unusual activity challenge', 'SITE_CHECK_REQUIRED', false],
  ['429 rate limit reached', 'RATE_LIMITED', true],
  ['503 upstream unavailable', 'UPSTREAM_UNAVAILABLE', true],
  ['selector missing after UI refresh', 'SITE_DRIFT', false],
  ['Browser action timed out', 'OUTCOME_UNKNOWN', false],
  ['This browser signed in to a different user', 'ACCOUNT_MISMATCH', false],
  ['something else broke', 'OPERATION_FAILED', false],
 ])('%s -> %s', (message, code, retryable) => {
  expect(monitor.classifyError(new Error(message))).toMatchObject({ code, retryable });
 });

 test('redacts bearer values and URL queries while preserving actionable context', () => {
  const result = monitor.classifyError(new Error('request Bearer top-secret failed at https://example.test/private/path?access_token=secret'));
  expect(result.message).toContain('Bearer [redacted]');
  expect(result.message).toContain('https://example.test/private/path');
  expect(result.message).not.toContain('top-secret');
  expect(result.message).not.toContain('access_token');
 });

 test('does not mistake a stack trace line number for an HTTP status', () => {
  expect(monitor.classifyError(new Error('at handler (/app/service.ts:503:9)'))).toMatchObject({code:'OPERATION_FAILED',retryable:false});
 });
});

const FAKE_WORKER = join(TEST_HOME, 'fake-browser-worker.ts');
writeFileSync(FAKE_WORKER, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';

function send(message, splitUnicode = false) {
  const bytes = Buffer.from(JSON.stringify(message) + '\\n');
  const marker = Buffer.from('🙂');
  const markerAt = bytes.indexOf(marker);
  if (!splitUnicode || markerAt < 0) return void process.stdout.write(bytes);
  process.stdout.write(bytes.subarray(0, markerAt + 1));
  setTimeout(() => process.stdout.write(bytes.subarray(markerAt + 1)), 5);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.op === 'init') return send({ id: message.id, result: { running: true, pid: process.pid } });
  if (message.op === 'status') return send({ id: message.id, result: { running: true, pid: process.pid, text: 'שלום🙂 café' } }, true);
  if (message.op === 'crash') return void process.exit(19);
  if (message.op === 'hang') return;
  if (message.op === 'close') return send({ id: message.id, result: { closed: true } });
  send({ id: message.id, result: message.args });
});
`, { mode: 0o700 });
chmodSync(FAKE_WORKER, 0o700);

const STUBBORN_WORKER = join(TEST_HOME, 'stubborn-browser-worker.ts');
writeFileSync(STUBBORN_WORKER, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';

process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.op === 'init') process.stdout.write(JSON.stringify({ id: message.id, result: { running: true } }) + '\\n');
  // Deliberately ignore close and every later operation. EOF, close RPC and TERM
  // all leave this fixture alive; only the transport's final KILL can end it.
});
`, { mode: 0o700 });
chmodSync(STUBBORN_WORKER, 0o700);

describe('browser worker transport without a live browser', () => {
 test('preserves Unicode characters split across stdout chunks', async () => {
  process.env.CHATGPT_PYTHON = FAKE_WORKER;
  const worker = new BrowserWorker(account('unicode'));
  try {
   await worker.start();
   expect(await worker.call('status')).toMatchObject({ text: 'שלום🙂 café' });
  } finally {
   await worker.close();
  }
 });

 test('can restart after an unexpected worker death', async () => {
  process.env.CHATGPT_PYTHON = FAKE_WORKER;
  const worker = new BrowserWorker(account('restart'));
  try {
   await worker.start();
   const first = await worker.call('status');
   await expect(worker.call('crash', {}, 1000)).rejects.toThrow('Browser worker exited');
   await worker.start();
   const second = await worker.call('status');
   expect(second).toMatchObject({ running: true, text: 'שלום🙂 café' });
   expect(second.pid).not.toBe(first.pid);
  } finally {
   await worker.close();
  }
 });

 test('close rejects pending work, blocks new calls, and can be repeated', async () => {
  process.env.CHATGPT_PYTHON = FAKE_WORKER;
  const worker = new BrowserWorker(account('close-race'));
  await worker.start();
  const pending = worker.call('hang', {}, 10000).then(() => null, error => error as Error);
  await worker.close();
  expect((await pending)?.message).toContain('Browser worker is closing');
  await expect(worker.call('status')).rejects.toThrow('Browser worker not running');
  await worker.close();
 });

 test('escalates from bounded grace to TERM and KILL when a worker never exits', async () => {
  process.env.CHATGPT_PYTHON = STUBBORN_WORKER;
  const worker = new BrowserWorker(account('stubborn'));
  await worker.start();
  const started = performance.now();
  await worker.close();
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(2900);
  expect(elapsed).toBeLessThan(5500);
  await expect(worker.call('status')).rejects.toThrow('Browser worker not running');
 }, 8000);
});
