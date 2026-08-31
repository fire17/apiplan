import { describe, expect, test } from "bun:test";
import { mapOrdered } from "../src/vision-pipeline.ts";

describe("ordered concurrent vision pipeline", () => {
  test("slow frames finish out of order but emit in capture order with no misses", async () => {
    const items = [40, 5, 25, 1].map((delay, seq) => ({ seq, delay }));
    const emitted: Array<{ seq: number; value?: string; error?: string }> = [];
    const stats = await mapOrdered(items, 4, async (item) => {
      await Bun.sleep(item.delay);
      return `frame-${item.seq}`;
    }, (out) => emitted.push({ seq: out.seq, value: out.value, error: out.error }));
    expect(emitted.map((x) => x.seq)).toEqual([0, 1, 2, 3]);
    expect(emitted.map((x) => x.value)).toEqual(["frame-0", "frame-1", "frame-2", "frame-3"]);
    expect(stats).toMatchObject({ accepted: 4, completed: 4, emitted: 4, failed: 0, maxInFlight: 4 });
  });

  test("a failed frame is an ordered error record, not a silent drop", async () => {
    const emitted: any[] = [];
    const stats = await mapOrdered([{ seq: 10 }, { seq: 11 }, { seq: 12 }], 2, async (item) => {
      if (item.seq === 11) throw new Error("bad frame");
      return item.seq;
    }, (out) => emitted.push(out));
    expect(emitted.map((x) => x.seq)).toEqual([10, 11, 12]);
    expect(emitted[1].error).toBe("bad frame");
    expect(stats).toMatchObject({ accepted: 3, completed: 3, emitted: 3, failed: 1 });
  });
});
