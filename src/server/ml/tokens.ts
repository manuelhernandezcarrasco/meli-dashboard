import { env } from "~/env";
import { db } from "~/server/db";
import { mlFetch, type TokenAuth } from "./http";

const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  userId: number;
  expiresAt: Date;
}

export async function getTokens(ownerId: string): Promise<StoredTokens | null> {
  const row = await db.mlToken.findUnique({ where: { ownerId } });
  if (!row) return null;
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    userId: Number(row.userId),
    expiresAt: row.expiresAt,
  };
}

export async function saveTokens(ownerId: string, t: StoredTokens): Promise<void> {
  const data = {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    userId: BigInt(t.userId),
    expiresAt: t.expiresAt,
  };
  await db.mlToken.upsert({
    where: { ownerId },
    create: { ownerId, ...data },
    update: data,
  });
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  user_id?: number | string;
  expires_in?: number;
}

async function requestToken(
  ownerId: string,
  form: Record<string, string>,
  fallbackUserId?: number,
): Promise<StoredTokens> {
  const tok = (await mlFetch("POST", TOKEN_URL, {
    form: {
      ...form,
      client_id: env.ML_CLIENT_ID,
      client_secret: env.ML_CLIENT_SECRET,
    },
  })) as TokenResponse | null;
  if (!tok?.access_token || !tok.refresh_token) {
    throw new Error("Mercado Libre no devolvió tokens válidos");
  }
  const stored: StoredTokens = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    userId: Number(tok.user_id ?? fallbackUserId ?? 0),
    expiresAt: new Date(Date.now() + (tok.expires_in ?? 21600) * 1000),
  };
  // ML refresh tokens are single use: persist the new one before anyone uses the access token.
  await saveTokens(ownerId, stored);
  return stored;
}

/** Exchanges an authorization code for tokens and stores them. */
export async function exchangeCode(ownerId: string, code: string): Promise<void> {
  await requestToken(ownerId, {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.ML_REDIRECT_URI,
  });
}

const refreshing = new Map<string, Promise<void>>();

/** Serialized per owner: concurrent callers share a single refresh. */
export function refreshTokens(ownerId: string): Promise<void> {
  const running = refreshing.get(ownerId);
  if (running) return running;
  const p = (async () => {
    try {
      const t = await getTokens(ownerId);
      if (!t?.refreshToken) {
        throw new Error("No hay refresh_token. Vinculá tu cuenta de Mercado Libre");
      }
      await requestToken(
        ownerId,
        { grant_type: "refresh_token", refresh_token: t.refreshToken },
        t.userId,
      );
    } finally {
      refreshing.delete(ownerId);
    }
  })();
  refreshing.set(ownerId, p);
  return p;
}

const NOT_LINKED = "Falta vincular Mercado Libre";

/** Returns a valid access token, refreshing when it expires within 5 minutes. */
export async function ensureToken(ownerId: string): Promise<string> {
  let t = await getTokens(ownerId);
  if (!t) throw new Error(NOT_LINKED);
  if (t.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS) {
    await refreshTokens(ownerId);
    t = await getTokens(ownerId);
    if (!t) throw new Error(NOT_LINKED);
  }
  return t.accessToken;
}

export async function isLinked(ownerId: string): Promise<boolean> {
  return (await getTokens(ownerId)) !== null;
}

export const tokenAuthFor = (ownerId: string): TokenAuth => ({
  getAccessToken: () => ensureToken(ownerId),
  refresh: () => refreshTokens(ownerId),
});
