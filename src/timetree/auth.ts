import { API_BASE_URI, API_USER_AGENT } from "./const";

export class AuthenticationError extends Error {}
export class InvalidCredentialsError extends AuthenticationError {}
export class RateLimitAuthenticationError extends AuthenticationError {}

const SIGNIN_PAGE_URL = "https://timetreeapp.com/signin";

// A real browser User-Agent, in case TimeTree's bot/CSRF protection rejects
// non-browser-looking requests. NOTE: "Origin" and "Referer" were tried here
// too but had to be dropped - the Workers runtime throws a TypeError when a
// fetch() sets "Origin" (forbidden header name, presumably to stop Workers
// forging it for SSRF/origin-spoofing), which crashed this route with a
// generic 500 before it ever reached TimeTree.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function extractErrorCode(body: unknown): number | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: unknown }).error;
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code?: unknown }).code;
      return typeof code === "number" ? code : undefined;
    }
  }
  return undefined;
}

function getSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const raw = response.headers.get("set-cookie");
  return raw ? [raw] : [];
}

function parseSessionId(setCookieHeaders: string[]): string | undefined {
  for (const header of setCookieHeaders) {
    const match = /(?:^|;\s*)_session_id=([^;]+)/.exec(header);
    // Keep the raw (possibly percent-encoded) cookie value as issued - it
    // gets echoed back verbatim as a Cookie header on every later API call
    // (see TimeTreeApi.headers() in ./api), same as a real browser would.
    // Decoding it here corrupted that round-trip: TimeTree's session cookie
    // can contain characters that must stay percent-encoded, and sending the
    // decoded form made every authenticated call after login fail with a
    // generic HTTP 400 (e.g. "Failed to get calendar metadata").
    if (match) return match[1]!;
  }
  return undefined;
}

function cookiePairsFrom(setCookieHeaders: string[]): string {
  return setCookieHeaders
    .map((header) => header.split(";", 1)[0]!.trim())
    .filter(Boolean)
    .join("; ");
}

/**
 * TimeTree's web app serves a CSRF token via a <meta name="csrf-token">
 * tag on its own sign-in page, and the login PUT below requires it (as
 * X-Csrf-Token) plus the cookies issued alongside it - without both, the
 * API rejects the request outright with a generic, undocumented error
 * regardless of whether the credentials are correct.
 */
async function fetchCsrfContext(): Promise<{ token: string; cookies: string }> {
  const response = await fetch(SIGNIN_PAGE_URL, {
    headers: { "User-Agent": BROWSER_USER_AGENT },
  });
  const html = await response.text();
  const match =
    /<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i.exec(html) ??
    /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i.exec(html);
  if (!match) {
    throw new AuthenticationError(
      "Could not find a CSRF token on TimeTree's sign-in page (its markup may have changed)",
    );
  }
  return { token: match[1]!, cookies: cookiePairsFrom(getSetCookieHeaders(response)) };
}

/**
 * Logs in via TimeTree's unofficial web-app API and returns the `_session_id`
 * cookie value used to authenticate subsequent requests. Reverse-engineered
 * from https://github.com/eoleedi/TimeTree-exporter (unofficial, unsupported
 * by TimeTree, can break at any time).
 */
export async function login(email: string, password: string): Promise<string> {
  let response: Response;
  try {
    const { token, cookies } = await fetchCsrfContext();

    response = await fetch(`${API_BASE_URI}/auth/email/signin`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": BROWSER_USER_AGENT,
        "X-Timetreea": API_USER_AGENT,
        "X-Csrf-Token": token,
        ...(cookies ? { Cookie: cookies } : {}),
      },
      body: JSON.stringify({
        uid: email,
        password,
        uuid: crypto.randomUUID().replace(/-/g, ""),
      }),
    });
  } catch (err) {
    // Surface runtime errors (e.g. the Workers runtime rejecting a forbidden
    // header name) as a visible login error instead of an opaque 500 -
    // AuthenticationError is what the route handler turns into a JSON
    // response the UI actually shows.
    if (err instanceof AuthenticationError) throw err;
    throw new AuthenticationError(`Unexpected error talking to TimeTree: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (response.status !== 200) {
    const text = await response.text();
    let code: number | undefined;
    try {
      code = extractErrorCode(JSON.parse(text));
    } catch {
      // Response body wasn't JSON (e.g. an edge/WAF error page) - code stays
      // undefined and the raw body snippet below is the only diagnostic.
    }
    if (code === -702) throw new InvalidCredentialsError("Wrong email or password");
    if (code === -495) {
      throw new RateLimitAuthenticationError("Rate limited, please try again later");
    }
    const snippet = text.slice(0, 300).replace(/\s+/g, " ").trim();
    throw new AuthenticationError(
      `Login failed (HTTP ${response.status})${snippet ? `: ${snippet}` : ""}`,
    );
  }

  const sessionId = parseSessionId(getSetCookieHeaders(response));
  if (!sessionId) {
    throw new AuthenticationError("Login succeeded but no session cookie was returned");
  }
  return sessionId;
}
