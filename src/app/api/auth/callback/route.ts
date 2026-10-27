import { NextResponse, type NextRequest } from "next/server";
import { exchangeCode } from "~/server/ml/tokens";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expected = req.cookies.get("ml_oauth_state")?.value;
  if (!code || !state || !expected || state !== expected) {
    return NextResponse.json({ error: "Estado OAuth inválido" }, { status: 400 });
  }
  try {
    await exchangeCode(code);
  } catch {
    return NextResponse.json({ error: "No se pudo canjear el código" }, { status: 502 });
  }
  const res = NextResponse.redirect(new URL("/", req.nextUrl.origin), 302);
  res.cookies.delete("ml_oauth_state");
  return res;
}
