"use client";

import { TRPCClientError } from "@trpc/client";
import { useEffect, useState } from "react";

import { api } from "~/trpc/react";
import { Dashboard } from "./Dashboard";
import { RefreshButton } from "./RefreshButton";

export { Dashboard };

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-[1280px] px-4 pt-[22px] pb-12" aria-busy="true">
      <div className="h-8 w-72 animate-pulse rounded-lg bg-line" />
      <div className="mt-6 grid grid-cols-2 gap-2.5 min-[1000px]:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="h-[84px] animate-pulse rounded-xl border border-line bg-card" />
        ))}
      </div>
      <div className="mt-3 grid gap-3 min-[1000px]:grid-cols-[1.6fr_1fr]">
        <div className="h-[310px] animate-pulse rounded-xl border border-line bg-card" />
        <div className="h-[310px] animate-pulse rounded-xl border border-line bg-card" />
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" className="mb-3 rounded-xl border border-neg bg-negbg px-4 py-2.5 text-[13px] text-neg">
      No se pudo actualizar los datos: {message}. Se muestran los últimos datos disponibles.
    </div>
  );
}

function cooldownFromError(e: unknown): number | null {
  if (e instanceof TRPCClientError && e.data && typeof e.data === "object" &&
      (e.data as { code?: string }).code === "TOO_MANY_REQUESTS") {
    const n = /(\d+)/.exec(e.message);
    return n ? Number(n[1]) : 30;
  }
  return null;
}

function ConnectScreen() {
  return (
    <div className="mx-auto flex max-w-[480px] flex-col items-center px-4 pt-24 text-center">
      <h1 className="text-xl font-semibold">Conectá tu cuenta de Mercado Libre</h1>
      <p className="mt-2 text-[13px] text-muted">
        Para ver tus dashboards necesitamos acceso a tu cuenta. Hasta entonces no se muestra ningún dato.
      </p>
      <a
        href="/api/auth/login"
        className="mt-6 rounded-xl bg-ink px-5 py-2.5 text-[13px] font-medium text-card"
      >
        Conectar Mercado Libre
      </a>
    </div>
  );
}

/** Page container: tRPC queries + refresh button around the presentational dashboard. */
export function DashboardPage() {
  const utils = api.useUtils();
  const conn = api.dashboard.connection.useQuery();
  const connected = conn.data?.connected === true;
  const q = api.dashboard.get.useQuery(undefined, { enabled: connected, refetchInterval: 60_000 });
  const status = api.dashboard.status.useQuery(undefined, { enabled: connected, refetchInterval: 60_000 });
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [tick, setTick] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = api.dashboard.refresh.useMutation({
    onSuccess: async () => {
      setMsg(null);
      await Promise.all([utils.dashboard.get.invalidate(), utils.dashboard.status.invalidate()]);
    },
    onError: (e) => {
      const s = cooldownFromError(e);
      if (s !== null) {
        setCooldownUntil(Date.now() + s * 1000);
        setMsg(`Espere ${s} s`);
      } else {
        setMsg("No se pudo actualizar");
      }
    },
  });

  const statusCooldown = status.data?.cooldownSeconds ?? 0;
  useEffect(() => {
    if (statusCooldown > 0) setCooldownUntil(Date.now() + statusCooldown * 1000);
  }, [statusCooldown, status.dataUpdatedAt]);

  const active = cooldownUntil > Date.now();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setTick((n) => n + 1);
      if (Date.now() >= cooldownUntil) setMsg(null);
    }, 1000);
    return () => clearInterval(t);
  }, [active, cooldownUntil]);
  void tick;
  const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));

  if (conn.data && !conn.data.connected) return <ConnectScreen />;
  if (!conn.data && !conn.isError) return <DashboardSkeleton />;

  if (!q.data) {
    return q.isError ? (
      <div className="mx-auto max-w-[1280px] px-4 pt-[22px]">
        <ErrorBanner message={q.error.message} />
      </div>
    ) : (
      <DashboardSkeleton />
    );
  }

  return (
    <Dashboard
      data={q.data}
      demo={status.data?.source === "demo"}
      banner={q.isError ? <ErrorBanner message={q.error.message} /> : null}
      actions={
        <RefreshButton
          onClick={() => refresh.mutate()}
          pending={refresh.isPending}
          cooldown={left}
          message={msg}
        />
      }
    />
  );
}
