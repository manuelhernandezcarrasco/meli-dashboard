import { createHash, randomBytes } from "node:crypto";
import { env } from "~/env";

const AUTH_URL = "https://auth.mercadolibre.com.ar/authorization";

export function newCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function authorizationUrl(state: string, codeVerifier: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: env.ML_CLIENT_ID,
    redirect_uri: env.ML_REDIRECT_URI,
    state,
    code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${q.toString()}`;
}

/** Accepts a full redirect URL, `code=TG-…` or the bare `TG-…` code. */
export function extractCode(input: string): string {
  const s = input.trim();
  const m = /[?&]?code=([^&\s]+)/.exec(s);
  return m ? decodeURIComponent(m[1]!) : s;
}
