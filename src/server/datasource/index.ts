import { env } from "~/env";
import type { Base } from "~/lib/contracts";
import { MlClient } from "~/server/ml/client";
import { DemoDataSource } from "./demo";
import { LiveDataSource } from "./live";
import type { DataSource } from "./types";

/** `DemoDataSource` (needs the SKU base) or `LiveDataSource`, per `DATA_SOURCE`. */
export function getDataSource(
  ownerId: string,
  base: Base,
  now: Date = new Date(),
): DataSource {
  return env.DATA_SOURCE === "live"
    ? new LiveDataSource(new MlClient(ownerId))
    : new DemoDataSource({ base, now });
}

export type { DataSource, Workbooks } from "./types";
