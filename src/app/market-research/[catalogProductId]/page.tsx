import { MarketPage } from "~/app/_components/market/MarketPage";

export default async function Page({ params }: { params: Promise<{ catalogProductId: string }> }) {
  const { catalogProductId } = await params;
  return <MarketPage catalogProductId={decodeURIComponent(catalogProductId)} />;
}
