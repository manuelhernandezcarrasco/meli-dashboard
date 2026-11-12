import { redirect } from "next/navigation";

export default function StockIndex() {
  redirect("/stock/products");
}
