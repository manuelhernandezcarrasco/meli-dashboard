const ML_HOST = "api.mercadolibre.com";
const MP_HOST = "api.mercadopago.com";
const OAUTH_TOKEN_URL = `https://${ML_HOST}/oauth/token`;
const TIMEOUT_MS = 30_000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class ReadOnlyViolationError extends Error {
  constructor(method: string, url: string) {
    super(`Blocked ${method} ${safeUrl(url)}: Mercado Libre access is read-only`);
    this.name = "ReadOnlyViolationError";
  }
}

/** Strips the query string so nothing sensitive can end up in an error message. */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

export interface TokenAuth {
  getAccessToken(): Promise<string>;
  /** Refreshes the stored tokens (serialized by the caller). */
  refresh(): Promise<void>;
}

export interface MlFetchOpts {
  query?: Record<string, string | number>;
  headers?: Record<string, string>;
  /** Sent form-urlencoded; only allowed for the oauth token POST. */
  form?: Record<string, string>;
  /** Omit for unauthenticated calls (the oauth token POST). */
  auth?: TokenAuth;
  retries?: number;
  /** Injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function assertAllowed(method: string, url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ReadOnlyViolationError(method, url);
  }
  if (u.protocol !== "https:") throw new ReadOnlyViolationError(method, url);
  if (method === "GET") {
    if (u.hostname !== ML_HOST && u.hostname !== MP_HOST) {
      throw new ReadOnlyViolationError(method, url);
    }
    return;
  }
  if (method === "POST" && `${u.origin}${u.pathname}` === OAUTH_TOKEN_URL && !u.search) {
    return;
  }
  throw new ReadOnlyViolationError(method, url);
}

/**
 * The ONLY place that talks to Mercado Libre / Mercado Pago. Allows GET to the two API
 * hosts and the single POST to /oauth/token; anything else throws ReadOnlyViolationError.
 * Returns the parsed JSON body, or null on 404.
 */
export async function mlFetch(
  method: string,
  url: string,
  opts: MlFetchOpts = {},
): Promise<unknown> {
  const m = method.toUpperCase();
  const qs = opts.query
    ? "?" +
      new URLSearchParams(
        Object.entries(opts.query).map(([k, v]) => [k, String(v)]),
      ).toString()
    : "";
  const fullUrl = url + qs;
  assertAllowed(m, fullUrl);
  if (opts.form && m !== "POST") throw new ReadOnlyViolationError(m, fullUrl);

  const retries = opts.retries ?? 4;
  const sleep = opts.sleep ?? realSleep;
  const headers: Record<string, string> = { ...opts.headers, Accept: "application/json" };
  let body: string | undefined;
  if (opts.form) {
    body = new URLSearchParams(opts.form).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  if (opts.auth) headers.Authorization = `Bearer ${await opts.auth.getAccessToken()}`;

  for (let i = 0; i < retries; i++) {
    let res: Response;
    try {
      res = await fetch(fullUrl, {
        method: m,
        headers,
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      await sleep(2 ** i * 1000);
      continue;
    }
    if (res.ok) return (await res.json()) as unknown;
    if (res.status === 401 && opts.auth && i === 0) {
      await opts.auth.refresh();
      headers.Authorization = `Bearer ${await opts.auth.getAccessToken()}`;
      continue;
    }
    if (RETRY_STATUS.has(res.status)) {
      await sleep(2 ** i * 1000);
      continue;
    }
    if (res.status === 404) return null;
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} en ${safeUrl(fullUrl)}: ${txt.slice(0, 300)}`);
  }
  throw new Error(`No pude conectar con ${safeUrl(fullUrl)}`);
}
