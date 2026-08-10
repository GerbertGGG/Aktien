// Locks in the status/error classification for the Twelve Data client
// (src/twelvedata.ts: classifyStatus). Based on Twelve Data's documented
// error schema (HTTP status codes 429/401/403/400 plus an embedded
// {"status":"error","code":N,"message":"..."} JSON body) — NOT yet checked
// against a real captured response (no network access to api.twelvedata.com
// from the environment this was built in). If real responses differ, patch
// classifyStatus() and these cases together. Run via `npm test`.

import { classifyStatus } from "../src/twelvedata";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`ok:   ${msg}`);
  }
}

assert(
  classifyStatus(200, { status: "ok" }) === null,
  "normal 200 + status:ok -> null (no error), i.e. caller proceeds to parse values",
);

assert(
  classifyStatus(429, { status: "error", code: 429, message: "You have run out of API credits for the day." })?.kind === "rate_limited",
  "HTTP 429 + code 429 -> rate_limited",
);

assert(
  classifyStatus(200, { status: "error", code: 429, message: "API rate limit exceeded." })?.kind === "rate_limited",
  "HTTP 200 body with embedded code 429 -> rate_limited (Twelve Data sometimes wraps errors in a 200)",
);

assert(
  classifyStatus(401, { status: "error", code: 401, message: "Invalid API key." })?.kind === "error",
  "HTTP 401 -> error (auth), not silently treated as ok",
);

assert(
  classifyStatus(400, { status: "error", code: 400, message: "**symbol** not found: BADTICKER" })?.kind === "invalid_symbol",
  "HTTP 400 mentioning 'symbol' -> invalid_symbol",
);

assert(
  classifyStatus(400, { status: "error", code: 400, message: "**interval** is missing or invalid" })?.kind === "error",
  "HTTP 400 NOT mentioning 'symbol' -> generic error, not misclassified as invalid_symbol",
);

assert(
  classifyStatus(500, { status: "error", code: 500, message: "Internal server error" })?.kind === "error",
  "HTTP 500 -> generic error",
);

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
