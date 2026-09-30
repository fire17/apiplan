#!/usr/bin/env bun
/**
 * A fixed, ISOLATED `apiplan serve` for the OM end-to-end proof — real grok and gemini
 * backends, on a loopback port of its own, with its own state dir.
 *
 * WHY A SEPARATE PROCESS AND A SEPARATE STATE DIR. The live daemon (pid 78136, port 8787)
 * runs older code and must not be restarted or drained, and `STATE_DIR` is read at MODULE
 * IMPORT time in platform.ts. Pointing APIPLAN_HOME at a scratch dir BEFORE api.ts is
 * imported is therefore the only way to get a server that speaks today's code, writes its
 * outcome memory nowhere near the operator's, and still dials the real vendors — which is
 * exactly what an end-to-end proof through omp needs.
 *
 * WHAT IS REAL AND WHAT IS NOT. The vendor credentials are the operator's own, read
 * READ-ONLY from their wells by the providers themselves (~/.grok/auth.json,
 * ~/.config/gemini/api_key) — this file never opens, copies or prints them. The state dir
 * is scratch. `token: ""` so the caller needs no key (omp sends `apiKey: not-needed`), and
 * never the operator's APIPLAN_API_KEY, or the server would 401 on itself.
 *
 * Prints `READY <port> <stateDir>` and serves until the parent kills it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set BEFORE api.ts is imported — STATE_DIR is bound at import time (platform.ts:24).
process.env.APIPLAN_HOME ??= mkdtempSync(join(tmpdir(), "apiplan-om-e2e-home-"));
process.env.APIPLAN_API_KEY = "";
// Loopback must never traverse a proxy: a corporate HTTPS_PROXY in the environment would
// route omp → server through it and the connection would simply hang.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

// Dynamic import, deliberately: a static one hoists ABOVE the env writes above and would
// bind the operator's real ~/.apiplan instead of this scratch dir. Same reason as
// test/helpers/om-proof-host.ts and usage-dialect-probe.ts.
const { serve } = await import("../../src/api.ts");
const api = serve({ port: 0, host: "127.0.0.1", token: "" });

console.log(`READY ${api.port} ${process.env.APIPLAN_HOME}`);
// Park. Nothing resolves this; the parent kills the process when the proof is done.
await Promise.withResolvers<never>().promise;
