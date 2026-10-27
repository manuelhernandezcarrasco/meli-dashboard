import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "~/env";
import { authorizationUrl } from "~/server/ml/oauth";

export function GET() {
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(authorizationUrl(state), 302);
  res.cookies.set("ml_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return res;
}
