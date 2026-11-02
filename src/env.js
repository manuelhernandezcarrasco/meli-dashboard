import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    ML_CLIENT_ID: z.string().min(1),
    ML_CLIENT_SECRET: z.string().min(1),
    ML_REDIRECT_URI: z.string().url(),
    DATA_SOURCE: z.enum(["demo", "live"]).default("demo"),
    BASE_PNL_PATH: z.string().min(1),
    VENTAS_DIRECTAS_PATH: z.string().optional(),
    CLERK_SECRET_KEY: z.string().min(1),
  },
  client: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    ML_CLIENT_ID: process.env.ML_CLIENT_ID,
    ML_CLIENT_SECRET: process.env.ML_CLIENT_SECRET,
    ML_REDIRECT_URI: process.env.ML_REDIRECT_URI,
    DATA_SOURCE: process.env.DATA_SOURCE,
    BASE_PNL_PATH: process.env.BASE_PNL_PATH,
    VENTAS_DIRECTAS_PATH: process.env.VENTAS_DIRECTAS_PATH,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
