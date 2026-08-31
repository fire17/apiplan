export type Sequenced = { seq: number };
export type OrderedOutcome<T, R> = {
  seq: number;
  item: T;
  value?: R;
  error?: string;
  latencyMs: number;
};

export type OrderedStats = {
  accepted: number;
  completed: number;
  emitted: number;
  failed: number;
  maxInFlight: number;
  wallMs: number;
};

/**
 * Run independent frame calls concurrently, but expose them in capture order.
 * A failed frame is emitted as an explicit error record, so it cannot become a silent
 * frame miss and cannot permanently block every later observation behind it.
 */
export async function mapOrdered<T extends Sequenced, R>(
  items: readonly T[],
  concurrency: number,
  analyze: (item: T) => Promise<R>,
  emit: (outcome: OrderedOutcome<T, R>) => void | Promise<void>,
): Promise<OrderedStats> {
  const began = performance.now();
  const width = Math.max(1, Math.min(Math.floor(concurrency) || 1, Math.max(1, items.length)));
  const ready = new Map<number, OrderedOutcome<T, R>>();
  let cursor = 0, nextEmit = 0, completed = 0, emitted = 0, failed = 0;
  let inFlight = 0, maxInFlight = 0;
  let flushTail: Promise<void> = Promise.resolve();

  const flush = () => {
    const run = flushTail.then(async () => {
      while (ready.has(nextEmit)) {
        const outcome = ready.get(nextEmit)!;
        ready.delete(nextEmit++);
        await emit(outcome);
        emitted++;
      }
    });
    flushTail = run.catch(() => {});
    return run;
  };

  await Promise.all(Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      const started = performance.now();
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let outcome: OrderedOutcome<T, R>;
      try {
        outcome = { seq: item.seq, item, value: await analyze(item), latencyMs: performance.now() - started };
      } catch (e: any) {
        failed++;
        outcome = { seq: item.seq, item, error: e?.message ?? String(e), latencyMs: performance.now() - started };
      } finally {
        inFlight--;
        completed++;
      }
      ready.set(index, outcome);
      await flush();
    }
  }));
  await flushTail;
  if (emitted !== items.length || completed !== items.length)
    throw new Error(`vision ordering invariant failed: accepted=${items.length} completed=${completed} emitted=${emitted}`);
  return { accepted: items.length, completed, emitted, failed, maxInFlight, wallMs: performance.now() - began };
}
