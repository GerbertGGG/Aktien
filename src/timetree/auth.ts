import { API_BASE_URI, API_USER_AGENT } from "./const";

export class AuthenticationError extends Error {}
export class InvalidCredentialsError extends AuthenticationError {}
export class RateLimitAuthenticationError extends AuthenticationError {}

const SIGNIN_PAGE_URL = "https://timetreeapp.com/signin";
const CALENDARS_PAGE_URL = "https://timetreeapp.com/calendars";

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

function cookiePairsFrom(setCookieHeaders: string[]): string {
  return setCookieHeaders
    .map((header) => header.split(";", 1)[0]!.trim())
    .filter(Boolean)
    .join("; ");
}

function cookieJarToMap(cookieHeader: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of cookieHeader.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return map;
}

// Merges newly-issued Set-Cookie values onto an existing "name=value; ..."
// jar, replacing any cookie the new response updates and keeping the rest -
// same as a browser's cookie jar. Needed because TimeTree's login response
// only re-sets a subset of cookies (notably _session_id); the ones only set
// on the sign-in GET (see fetchCsrfContext) still had to be present on every
// later authenticated call, or those calls failed with a generic HTTP 400
// (e.g. "Failed to get calendar metadata") despite login itself succeeding.
function mergeCookieJar(baseCookieHeader: string, newSetCookieHeaders: string[]): string {
  const map = cookieJarToMap(baseCookieHeader);
  for (const pair of cookiePairsFrom(newSetCookieHeaders).split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return Array.from(map.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/**
 * TimeTree's web app serves a CSRF token via a <meta name="csrf-token">
 * tag on every page it renders (including the sign-in page while
 * unauthenticated), and API calls require it as X-Csrf-Token - without it,
 * the API rejects the request outright with a generic, undocumented error
 * regardless of whether the credentials/session are otherwise valid.
 *
 * Pass a cookieHeader to fetch this from an *authenticated* page - confirmed
 * live (via a real browser's console) that the pre-login token from
 * SIGNIN_PAGE_URL stops validating once login succeeds (Rails-typical
 * session-fixation protection rotates it), so login() re-fetches one from an
 * authenticated page before returning.
 */
async function fetchCsrfContext(url: string, cookieHeader?: string): Promise<{ token: string; cookies: string }> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  });
  const html = await response.text();
  const match =
    /<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i.exec(html) ??
    /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i.exec(html);
  if (!match) {
    throw new AuthenticationError(`Could not find a CSRF token on ${url} (its markup may have changed)`);
  }
  return { token: match[1]!, cookies: cookiePairsFrom(getSetCookieHeaders(response)) };
}

export interface TimeTreeSession {
  // Full "name=value; ..." Cookie header to send on every subsequent
  // authenticated request (not just the bare `_session_id` value - see
  // mergeCookieJar).
  cookieJar: string;
  // Fetched fresh from an authenticated page after login (see
  // fetchCsrfContext) - the pre-login token stops validating once
  // authenticated, confirmed live via a real browser's console.
  csrfToken: string;
}

/**
 * Logs in via TimeTree's unofficial web-app API and returns the session
 * (cookie jar + CSRF token) needed to authenticate subsequent requests.
 * Reverse-engineered from https://github.com/eoleedi/TimeTree-exporter
 * (unofficial, unsupported by TimeTree, can break at any time).
 */
export async function login(email: string, password: string): Promise<TimeTreeSession> {
  let response: Response;
  let cookies: string;
  let token: string;
  try {
    const csrf = await fetchCsrfContext(SIGNIN_PAGE_URL);
    cookies = csrf.cookies;
    token = csrf.token;

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

  let cookieJar = mergeCookieJar(cookies, getSetCookieHeaders(response));
  if (!cookieJarToMap(cookieJar).has("_session_id")) {
    throw new AuthenticationError("Login succeeded but no session cookie was returned");
  }

  // The pre-login CSRF token no longer validates once authenticated (see
  // fetchCsrfContext's docstring) - fetch a fresh one from an authenticated
  // page before it's used for any real API call.
  try {
    const authedCsrf = await fetchCsrfContext(CALENDARS_PAGE_URL, cookieJar);
    // authedCsrf.cookies is already "name=value; ..." pairs (no extra
    // Set-Cookie attributes) - mergeCookieJar's second arg just needs each
    // entry to look like a Set-Cookie value, which a bare pair satisfies.
    cookieJar = mergeCookieJar(cookieJar, authedCsrf.cookies ? authedCsrf.cookies.split("; ") : []);
    return { cookieJar, csrfToken: authedCsrf.token };
  } catch (err) {
    if (err instanceof AuthenticationError) throw err;
    throw new AuthenticationError(
      `Unexpected error fetching an authenticated CSRF token: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
