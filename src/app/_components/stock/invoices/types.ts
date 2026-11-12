import type { InvoiceListRow, InvoiceReview, InvoiceReviewLine, ProductFill } from "~/lib/stock-contracts";

/**
 * UI view of the S9 payloads. `stock-contracts.ts` (owned by S0) does not carry the current stock/cost,
 * the skipped flag, suggestions or the applied date that the review screen needs; they are optional
 * here and the screen degrades gracefully when S9 does not send them.
 */
export interface ReviewLine extends InvoiceReviewLine {
  skipped?: boolean;
  stockNow?: number | null;
  costNow?: number | null;
  suggestions?: { productId: number; name: string; willFill?: Partial<ProductFill> }[];
}
export interface Review extends Omit<InvoiceReview, "lines"> {
  lines: ReviewLine[];
  appliedAt?: string | null;
}
export interface ListRow extends InvoiceListRow {
  appliedAt?: string | null;
}

export type LineKey = { invoiceId: number; lineNo: number };

/**
 * Typed seam over `api.stockInvoices` (S9 router: list, getDraft, setFeeFactor, matchLine,
 * createProductFromLine, skipLine, confirm, discard). Until S9 is merged the generated router type is
 * empty, so the hooks are typed here; swap for the inferred types after integration.
 */
export interface InvoicesApi {
  list: { useQuery: () => QueryResult<ListRow[]> };
  getDraft: { useQuery: (i: { invoiceId: number }) => QueryResult<Review> };
  setFeeFactor: Mutation<{ invoiceId: number; feeFactor: number | null }>;
  matchLine: Mutation<LineKey & { productId: number }>;
  createProductFromLine: Mutation<LineKey & { product: object }>;
  skipLine: Mutation<LineKey>;
  confirm: Mutation<{ invoiceId: number }>;
  discard: Mutation<{ invoiceId: number }>;
}
export interface QueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  error: { message: string } | null;
  refetch: () => unknown;
}
export interface Mutation<I> {
  useMutation: (o?: { onSuccess?: () => void }) => {
    mutate: (i: I, o?: { onSuccess?: () => void; onSettled?: () => void }) => void;
    isPending: boolean;
    error: { message: string } | null;
    reset: () => void;
  };
}
