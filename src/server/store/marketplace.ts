import type { Marketplace } from "../../../generated/prisma";

export type { Marketplace };

/** The only marketplace with a connector today. A new one is a new value in the Prisma enum plus a DataSource. */
export const MERCADOLIBRE: Marketplace = "mercadolibre";
