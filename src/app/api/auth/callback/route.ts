import { auth } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import { exchangeCode, TokenStorageError } from "~/server/ml/tokens";

type MlErrorCode = "state" | "exchange" | "storage";

function failure(req: NextRequest, code: MlErrorCode) {
  const res = NextResponse.redirect(new URL(`/?ml_error=${code}`, req.nextUrl.origin), 302);
  res.cookies.delete("ml_oauth_state");
  return res;
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expected = req.cookies.get("ml_oauth_state")?.value;
  if (!code || !state || !expected || state !== expected) {
    console.error("[ml-oauth] estado OAuth inválido o faltante");
    return failure(req, "state");
  }
  try {
    await exchangeCode(userId, code);
  } catch (e) {
    console.error("[ml-oauth] no se pudo canjear el código:", e instanceof Error ? e.message : e);
    return failure(req, e instanceof TokenStorageError ? "storage" : "exchange");
  }
  const res = NextResponse.redirect(new URL("/", req.nextUrl.origin), 302);
  res.cookies.delete("ml_oauth_state");
  return res;
}
