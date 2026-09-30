import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listOnlineRequests, onlineRequestStatus } from "../src/chatgpt/online-receipts.ts";
import type { Account } from "../src/chatgpt/accounts.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const account: Account = { id: "fixture", label: "Fixture", baseURL: "https://chatgpt.com", userId: "user", created: "2026-09-15T00:00:00.000Z" };
const requestId = "api-0123456789abcdef0123456789abcdef01234567";
function fixture(receipt: any) {
  const root = mkdtempSync(join(tmpdir(), "online-receipts-")); roots.push(root);
  const directory = join(root, requestId); mkdirSync(directory);
  writeFileSync(join(directory, "api-receipt.json"), JSON.stringify(receipt));
  return root;
}

const complete = {
  version: 1, requestId, status: "complete", model: "online-chat-latest", accountId: "fixture",
  started: "2026-09-15T10:00:00.000Z", completed: "2026-09-15T10:01:00.000Z", conversation: "conversation-1",
  deltas: [{ text: "private answer" }, { toolStart: { ref: "r", id: "c", name: "lookup" } }, { toolArgs: { ref: "r", json: "{}" } }, { toolStop: { ref: "r" } }, { stopReason: "tool_use" }],
};

describe("online API receipt observability", () => {
  test("list returns bounded metadata and counts without response text", () => {
    const root = fixture(complete);
    const result = listOnlineRequests(account, {}, root);
    expect(result).toMatchObject({ count: 1, redacted: true, source: "private local online API receipts" });
    expect(result.items[0]).toMatchObject({ requestId, status: "complete", model: "online-chat-latest", account: "fixture", conversation: "conversation-1", resultSummary: { deltaCount: 5, textDeltaCount: 1, textCharacters: 14, toolCallCount: 1, errorDeltaCount: 0, stopReasons: ["tool_use"] } });
    expect(JSON.stringify(result)).not.toContain("private answer");
    expect(result.items[0].receiptPath).toBe(join(root, requestId, "api-receipt.json"));
  });

  test("status stays redacted unless raw output is explicitly requested", () => {
    const root = fixture(complete);
    const safe = onlineRequestStatus(account, { id: requestId }, root);
    expect(safe.redacted).toBe(true);
    expect("receipt" in safe).toBe(false);
    expect(JSON.stringify(safe)).not.toContain("private answer");
    const raw = onlineRequestStatus(account, { requestId, includeRaw: true }, root);
    expect(raw.redacted).toBe(false);
    expect(raw.receipt.deltas[0].text).toBe("private answer");
  });

  test("uncertain outcomes carry a no-resubmit action and safe error metadata", () => {
    const root = fixture({ ...complete, status: "unknown", completed: undefined, deltas: undefined, error: { code: "OUTCOME_UNKNOWN", message: "Inspect the saved conversation", private: "omitted" } });
    const status = onlineRequestStatus(account, { id: requestId }, root);
    expect(status).toMatchObject({ status: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "Inspect the saved conversation" } });
    expect(status.lockPresent).toBe(false);
    expect(status.action).toContain("outcome remains uncertain");
    expect(status.action).toContain("do not resubmit");
    writeFileSync(join(root, requestId, "active.lock"), "fixture");
    const active = onlineRequestStatus(account, { id: requestId }, root);
    expect(active.lockPresent).toBe(true);
    expect(active.action).toContain("may still be active");
    expect(active.action).toContain("do not resubmit or clear its lock");
    expect(JSON.stringify(status)).not.toContain("omitted");
  });

  test("invalid IDs cannot escape the receipt root and list limits are bounded", () => {
    const root = fixture(complete);
    expect(() => onlineRequestStatus(account, { id: "../../accounts.json" }, root)).toThrow("api- followed by 40 lowercase hexadecimal");
    expect(() => listOnlineRequests(account, { limit: 0 }, root)).toThrow("integer from 1 to 1000");
    expect(() => listOnlineRequests(account, { limit: 1001 }, root)).toThrow("integer from 1 to 1000");
  });

  test("corrupt or mismatched receipts remain visible without exposing their bytes", () => {
    const root = fixture(complete);
    writeFileSync(join(root, requestId, "api-receipt.json"), "private malformed bytes");
    let result = listOnlineRequests(account, {}, root);
    expect(result.items[0]).toMatchObject({ requestId, status: "invalid", error: { code: "ONLINE_RECEIPT_CORRUPT" } });
    expect(JSON.stringify(result)).not.toContain("private malformed bytes");
    writeFileSync(join(root, requestId, "api-receipt.json"), JSON.stringify({ ...complete, accountId: "other-account" }));
    result = listOnlineRequests(account, {}, root);
    expect(result.items[0]).toMatchObject({ requestId, status: "invalid", error: { code: "ONLINE_RECEIPT_CORRUPT" } });
    expect(() => onlineRequestStatus(account, { id: requestId }, root)).toThrow("does not match its receipt directory and account");
  });
});
