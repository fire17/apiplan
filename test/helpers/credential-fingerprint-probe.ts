import { writeFileSync } from "node:fs";

const file = process.env.APIPLAN_GOOGLE_CRED_FILE;
if (!file) throw new Error("APIPLAN_GOOGLE_CRED_FILE is required");
const expiry = Date.now() + 6 * 3600_000;
const write = (access: string) => writeFileSync(file, JSON.stringify({
  auth_method: "consumer",
  token: { access_token: access, refresh_token: "RT-same-account", token_type: "Bearer", expiry: new Date(expiry).toISOString() },
}));

write("AT-one");
const { google } = await import("../../src/providers.ts");
const detail = google.probe().detail;
const before = JSON.stringify(google.credFp?.());
write("AT-two");
const after = JSON.stringify(google.credFp?.());
const stable = JSON.stringify(google.credFp?.());
console.log(JSON.stringify({ detail, before, after, stable }));
