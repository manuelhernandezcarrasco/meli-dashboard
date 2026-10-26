import { HydrateClient } from "~/trpc/server";

export default function Home() {
  return (
    <HydrateClient>
      <main className="flex min-h-screen items-center justify-center bg-slate-900 text-white">
        <h1 className="text-3xl font-bold">PnL Diario ML</h1>
      </main>
    </HydrateClient>
  );
}
