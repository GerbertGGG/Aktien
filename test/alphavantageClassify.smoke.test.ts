// Locks in the classification of Alpha Vantage's error/rate-limit/premium
// wrapper messages (src/alphavantage.ts: classifyError). Every case below
// except the two explicitly marked "genuinely gated" is a REAL message
// captured from this project's own key on 2026-08-05..08 while diagnosing a
// misclassification bug: virtually all Alpha Vantage quota messages end
// with a "subscribe to premium plans" upsell footer, which a naive
// "contains 'premium'" check wrongly flagged as feature-gating. Run via
// `npm test`.

import { classifyError } from "../src/alphavantage";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`ok:   ${msg}`);
  }
}

// --- Real quota/rate-limit messages (must NOT be premium_gated) -----------

assert(
  classifyError({
    Information:
      "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day), raise the per-second burst limit, and instantly unlock all premium endpoints",
  })?.kind === "rate_limited",
  "burst-limit message ('spreading out', 'per second') -> rate_limited, not premium_gated",
);

assert(
  classifyError({
    Information:
      "Thank you for using Alpha Vantage! Please contact premium@alphavantage.co if you are targeting a higher API call volume.",
  })?.kind === "rate_limited",
  "'contact premium@... call volume' message -> rate_limited, not premium_gated",
);

assert(
  classifyError({
    Information:
      "We have detected your API key as SH49HCQSG3DYY62Z and our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits.",
  })?.kind === "rate_limited",
  "explicit '25 requests per day' quota message -> rate_limited, not premium_gated",
);

// --- Real genuinely-gated feature message (MUST be premium_gated) ---------

assert(
  classifyError({
    Information:
      "Thank you for using Alpha Vantage! The outputsize=full parameter value is a premium feature for the TIME_SERIES_DAILY endpoint. You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly unlock all premium features",
  })?.kind === "premium_gated",
  "'outputsize=full ... is a premium feature' -> premium_gated (genuinely endpoint/parameter-specific)",
);

// --- Other classification paths --------------------------------------------

assert(
  classifyError({ "Error Message": "Invalid API call. Please retry or visit the documentation..." })?.kind === "invalid_symbol",
  "Error Message field -> invalid_symbol",
);

assert(classifyError({}) === null, "no error/rate-limit/premium fields -> null (caller treats response as ok)");

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
