import { notFound } from "next/navigation";

import { InvoiceReviewPage } from "~/app/_components/stock/invoices/InvoiceReviewPage";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoiceId = Number(id);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) notFound();
  return <InvoiceReviewPage invoiceId={invoiceId} />;
}
