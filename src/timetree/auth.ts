import { API_BASE_URI, API_USER_AGENT } from "./const";

export class AuthenticationError extends Error {}
export class InvalidCredentialsError extends AuthenticationError {}
export class RateLimitAuthenticationError extends AuthenticationError {}

const SIGNIN_PAGE_URL = "https://timetreeapp.com/signin";

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
    if (match) return decodeURIComponent(match[1]!);
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
  const response = await fetch(SIGNIN_PAGE_URL);
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
  const { token, cookies } = await fetchCsrfContext();

  const response = await fetch(`${API_BASE_URI}/auth/email/signin`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
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
