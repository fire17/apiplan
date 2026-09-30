import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountDir, type Account } from "./accounts.ts";

const REQUEST_ID = /^api-[0-9a-f]{40}$/;
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };

function rootFor(account: Account, override?: string) {
  return override ?? join(accountDir(account), "online");
}
function receiptFile(directory: string, requestId: string) {
  if (!REQUEST_ID.test(requestId)) fail("ONLINE_REQUEST_ID_INVALID", "Online request ID must be api- followed by 40 lowercase hexadecimal characters.");
  return join(directory, requestId, "api-receipt.json");
}
function summary(receipt: any) {
  const deltas = Array.isArray(receipt?.deltas) ? receipt.deltas : [];
  return {
    deltaCount: deltas.length,
    textDeltaCount: deltas.filter((delta: any) => typeof delta?.text === "string").length,
    textCharacters: deltas.reduce((total: number, delta: any) => total + (typeof delta?.text === "string" ? delta.text.length : 0), 0),
    toolCallCount: deltas.filter((delta: any) => delta?.toolStart || delta?.toolCallDone).length,
    errorDeltaCount: deltas.filter((delta: any) => typeof delta?.error === "string").length,
    stopReasons: [...new Set(deltas.map((delta: any) => delta?.stopReason).filter((value: any) => typeof value === "string"))],
  };
}
function action(status: string, lockPresent: boolean) {
  if (status === "complete") return "Complete. Repeating the exact request replays its saved result without another website submission.";
  if (status === "not-submitted") return "No submission was observed. Correct the preparation failure before retrying.";
  return lockPresent
    ? "A lock is present, so the request may still be active. Monitor this receipt; do not resubmit or clear its lock."
    : "No lock is present, but the outcome remains uncertain. Inspect the saved conversation and receipt; do not resubmit.";
}
function metadata(receipt: any, path: string, requestId: string) {
  const status = typeof receipt?.status === "string" ? receipt.status : "invalid";
  const lockPresent = existsSync(join(dirname(path), "active.lock"));
  return {
    requestId: typeof receipt?.requestId === "string" ? receipt.requestId : requestId,
    status,
    model: receipt?.model,
    account: receipt?.accountId,
    started: receipt?.started,
    completed: receipt?.completed,
    conversation: receipt?.conversation,
    error: receipt?.error && typeof receipt.error === "object" ? { code: receipt.error.code, message: receipt.error.message } : undefined,
    cancellationRequested: receipt?.cancellationRequested === true,
    resultSummary: summary(receipt),
    receiptPath: path,
    lockPresent,
    action: action(status, lockPresent),
  };
}
function readReceipt(path: string, requestId: string, accountId: string) {
  if (!existsSync(path)) fail("ONLINE_REQUEST_NOT_FOUND", `Online request ${requestId} was not found.`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("ONLINE_RECEIPT_UNSAFE", `Online request ${requestId} does not point to a regular receipt file.`);
  let receipt: any;
  try { receipt = JSON.parse(readFileSync(path, "utf8")); }
  catch { fail("ONLINE_RECEIPT_CORRUPT", `Online request ${requestId} has an unreadable receipt.`); }
  if (!receipt || receipt.requestId !== requestId || receipt.accountId !== accountId) fail("ONLINE_RECEIPT_CORRUPT", `Online request ${requestId} does not match its receipt directory and account.`);
  return receipt;
}

export function onlineRequestStatus(account: Account, args: { id?: string; requestId?: string; includeRaw?: boolean } = {}, directory?: string) {
  const requestId = args.requestId || args.id;
  if (!requestId) fail("ONLINE_REQUEST_ID_REQUIRED", "Online status requires a request ID.");
  const path = receiptFile(rootFor(account, directory), requestId);
  const receipt = readReceipt(path, requestId, account.id);
  const item = metadata(receipt, path, requestId);
  return { ...item, source: "private local online API receipt", redacted: args.includeRaw !== true, ...(args.includeRaw === true ? { receipt } : {}) };
}

export function listOnlineRequests(account: Account, args: { limit?: number } = {}, directory?: string) {
  const root = rootFor(account, directory);
  const limit = args.limit === undefined ? 100 : args.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail("ONLINE_LIMIT_INVALID", "Online list limit must be an integer from 1 to 1000.");
  if (!existsSync(root)) return { items: [], count: 0, source: "private local online API receipts", redacted: true };
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) fail("ONLINE_RECEIPT_ROOT_UNSAFE", "Online receipt root must be a regular directory.");
  const items = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && REQUEST_ID.test(entry.name))
    .map((entry) => {
      const path = receiptFile(root, entry.name);
      try { return metadata(readReceipt(path, entry.name, account.id), path, entry.name); }
      catch (error: any) { return { requestId: entry.name, status: "invalid", receiptPath: path, error: { code: error.code || "ONLINE_RECEIPT_CORRUPT", message: error.message }, resultSummary: summary(null), lockPresent: existsSync(join(root, entry.name, "active.lock")), action: action("invalid", existsSync(join(root, entry.name, "active.lock"))) }; }
    })
    .sort((left, right) => String(right.started || "").localeCompare(String(left.started || "")))
    .slice(0, limit);
  return { items, count: items.length, source: "private local online API receipts", redacted: true };
}
