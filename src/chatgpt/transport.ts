import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ROOT, accountDir, type Account, installedBrowsers } from './accounts.ts';
import { isFrozen, allowedWhileFrozen, frozenError } from './freeze.ts';

type PendingCall = {
 resolve: (value: any) => void;
 reject: (error: Error) => void;
 timer: ReturnType<typeof setTimeout>;
};

export class BrowserWorker {
 private proc: any;
 private starting: Promise<void> | null = null;
 private closing: Promise<void> | null = null;
 private pending = new Map<string, PendingCall>();

 constructor(public account: Account) {}

 running() { return !!this.proc; }

 /**
  * Route every call through one gateway (dedupe, pacing, policy) without rewriting 36 call sites.
  *
  * The router wraps `next`, which performs the real worker dispatch. Freeze is still evaluated ABOVE
  * the router, so a frozen account refuses immediately instead of queueing work that must never run,
  * and it is still the last line of defence for anything that bypasses the router entirely.
  */
 setRouter(router?: (op: string, args: any, timeout: number) => Promise<any>) { this.router = router; }
 private router?: (op: string, args: any, timeout: number) => Promise<any>;

 /**
  * The real dispatch, with the router skipped. ONLY the gateway's downstream may call this: anything
  * else would be the bypass this whole seam exists to close. The freeze gate is repeated here on
  * purpose, so freeze remains the last line of defence underneath the gateway rather than something
  * the gateway could accidentally route around.
  */
 rawCall(op: string, args: any = {}, timeout = 45000): Promise<any> {
  if (this.closing) return Promise.reject(new Error('Browser worker is closing.'));
  if (isFrozen(this.account) && !allowedWhileFrozen(op, args)) return Promise.reject(frozenError(this.account, op));
  if (!this.proc) return Promise.reject(new Error('Browser worker not running.'));
  return this.send(this.proc, op, args, timeout);
 }

 async start(headless = true) {
  if (this.closing) await this.closing;
  if (this.starting) return this.starting;
  if (this.proc) return;
  if (isFrozen(this.account)) throw frozenError(this.account, 'browser.start');
  const starting = this.launch(headless);
  this.starting = starting;
  try {
   await starting;
  } finally {
   if (this.starting === starting) this.starting = null;
  }
 }

 private rejectPending(error: Error) {
  for (const call of this.pending.values()) {
   clearTimeout(call.timer);
   call.reject(error);
  }
  this.pending.clear();
 }

 private async exitedWithin(proc: any, milliseconds: number) {
  return Promise.race([
   proc.exited.then(() => true),
   Bun.sleep(milliseconds).then(() => false),
  ]);
 }

 private async terminate(proc: any) {
  if (await this.exitedWithin(proc, 0)) return;
  try { proc.kill('SIGTERM'); } catch {}
  if (await this.exitedWithin(proc, 1000)) return;
  try { proc.kill('SIGKILL'); } catch {}
  await this.exitedWithin(proc, 1000);
 }

 private acceptLine(line: string) {
  try {
   const message = JSON.parse(line);
   const call = this.pending.get(message.id);
   if (!call) return;
   clearTimeout(call.timer);
   this.pending.delete(message.id);
   message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result);
  } catch {
   // A malformed worker line is ignored. Process exit or the call timeout supplies
   // the bounded failure instead of exposing browser diagnostics or partial data.
  }
 }

 private async launch(headless = true) {
  const python = process.env.CHATGPT_PYTHON || join(ROOT, 'runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(python)) throw new Error('Browser runtime missing. Run chatgpt setup.');
  const proc = Bun.spawn([python, join(import.meta.dir, 'browser.py')], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  this.proc = proc;

  const read = async () => {
   let buffer = '';
   const decoder = new TextDecoder();
   for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
     const line = buffer.slice(0, newline);
     buffer = buffer.slice(newline + 1);
     if (line) this.acceptLine(line);
    }
   }
   buffer += decoder.decode();
   if (buffer) this.acceptLine(buffer);
  };
  void read().catch(() => {}); // Process exit rejects any calls left unresolved.
  void (async () => { for await (const _ of proc.stderr) { /* Never print browser internals/tokens. */ } })();
  void proc.exited.then(() => {
   if (this.proc !== proc) return;
   this.proc = null;
   this.rejectPending(new Error('Browser worker exited. Run chatgpt browser start.'));
  });

  const dir = accountDir(this.account);
  try {
   await this.send(proc, 'init', { ...this.account, profilePath: this.account.profilePath || join(dir, 'profile'), downloads: join(dir, 'downloads'), browserPath: this.account.browserPath || installedBrowsers()[0]?.path, headless }, 60000);
  } catch (error) {
   if (!this.closing && this.proc === proc) {
    await this.terminate(proc);
    if (this.proc === proc) this.proc = null;
   }
   throw error;
  }
 }

 private send(proc: any, op: string, args: any, timeout: number): Promise<any> {
  if (this.proc !== proc) return Promise.reject(new Error('Browser worker not running.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
   const timer = setTimeout(() => {
    this.pending.delete(id);
    reject(new Error(`Browser ${op} timed out. The operation may still be running; inspect status before retrying a write.`));
   }, timeout);
   this.pending.set(id, { resolve, reject, timer });
   try {
    proc.stdin.write(JSON.stringify({ id, op, args }) + '\n');
    proc.stdin.flush();
   } catch (error) {
    clearTimeout(timer);
    this.pending.delete(id);
    reject(error instanceof Error ? error : new Error(String(error)));
   }
  });
 }

 call(op: string, args: any = {}, timeout = 45000): Promise<any> {
  if (this.closing) return Promise.reject(new Error('Browser worker is closing.'));
  if (isFrozen(this.account) && !allowedWhileFrozen(op, args)) return Promise.reject(frozenError(this.account, op));
  if (!this.proc) return Promise.reject(new Error('Browser worker not running.'));
  // One dispatch path whether or not a gateway is installed, so the process is written to in exactly one place.
  return this.router ? this.router(op, args, timeout) : this.rawCall(op, args, timeout);
 }

 async close() {
  if (this.closing) return this.closing;
  const proc = this.proc;
  if (!proc) {
   if (this.starting) await this.starting.catch(() => {});
   return;
  }
  const closing = Promise.resolve().then(async () => {
   this.rejectPending(new Error('Browser worker is closing.'));
   const graceful = (async () => {
    await this.send(proc, 'close', {}, 45000).catch(() => {});
    try { proc.stdin.end(); } catch {}
    await proc.exited;
   })();
   if (!await Promise.race([graceful.then(() => true), Bun.sleep(3000).then(() => false)])) {
    try { proc.stdin.end(); } catch {}
    await this.terminate(proc);
   }
   if (this.proc === proc) this.proc = null;
  });
  this.closing = closing;
  try {
   await closing;
  } finally {
   if (this.closing === closing) this.closing = null;
   this.starting = null;
  }
 }
}
