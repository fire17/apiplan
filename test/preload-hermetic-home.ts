// Test preload: every in-process test gets an EMPTY, private APIPLAN_HOME.
//
// platform.ts binds STATE_DIR from APIPLAN_HOME once, at first import, and bun runs every test
// file in ONE process with a shared module cache — so a single file cannot isolate itself, and
// without this the in-process registry/roster tests read the operator's own ~/.apiplan model
// caches. Those caches move under the tests whenever anyone runs `apiplan models --refresh`
// (2026-09-30: the Codex catalog dropped gpt-5.4-mini and Anthropic added claude-opus-5-5 /
// claude-sonnet-5-5, turning 7 registry/roster pins red on this machine only). With an empty
// state dir the registry serves its baked FALLBACK, which is what those pins describe.
// Subprocess tests already pass their own APIPLAN_HOME; an explicit one here is respected.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.APIPLAN_HOME) process.env.APIPLAN_HOME = mkdtempSync(join(tmpdir(), "apiplan-test-home-"));
