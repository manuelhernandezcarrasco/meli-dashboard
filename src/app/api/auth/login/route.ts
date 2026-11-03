import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "~/env";
import { authorizationUrl, newCodeVerifier } from "~/server/ml/oauth";

export function GET() {
  const state = randomBytes(16).toString("hex");
  const verifier = newCodeVerifier();
  const res = NextResponse.redirect(authorizationUrl(state, verifier), 302);
  const opts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  };
  res.cookies.set("ml_oauth_state", state, opts);
  res.cookies.set("ml_oauth_verifier", verifier, opts);
  return res;
}
