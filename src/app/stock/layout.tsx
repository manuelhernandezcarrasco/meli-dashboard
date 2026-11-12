import type { ReactNode } from "react";

import { StockTabs } from "~/app/_components/shell/StockTabs";

export default function StockLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1280px] px-4 pt-[22px] pb-12">
      <h1 className="m-0 mb-3 text-[22px] font-semibold tracking-tight">Stock</h1>
      <StockTabs />
      {children}
    </div>
  );
}
