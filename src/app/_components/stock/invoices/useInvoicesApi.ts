import { api } from "~/trpc/react";
import type { InvoicesApi } from "./types";

/** The only place that casts the router; see InvoicesApi in ./types. */
export const useInvoicesApi = (): InvoicesApi =>
  (api as unknown as { stockInvoices: InvoicesApi }).stockInvoices;
