"use client";

import { useEffect, useRef } from "react";

import { MARKET_TTL_MS, type MarketState } from "~/lib/market";
import { api } from "~/trpc/react";

export const MARKET_POLL_MS = 2000;

/** Client surface of the `market` router (T12). Typed locally so this compiles before the router is merged. */
type Input = { catalogProductId: string };
type MarketApi = {
  useUtils(): { market: { get: { setData(input: Input, data: MarketState): void } } };
  market: {
    get: {
      useQuery(
        input: Input,
        opts: { refetchInterval: (q: { state: { data: MarketState | undefined } }) => number | false },
      ): { data: MarketState | undefined; error: { message: string } | null; isError: boolean };
    };
    touch: {
      useMutation(opts: { onSuccess: (s: MarketState) => void }): { mutate(input: Input): void; isPending: boolean };
    };
  };
};

/**
 * Client half of the refresh policy: touch on mount, touch every MARKET_TTL_MS while mounted,
 * poll `get` every 2 s only while the job is running. Nothing runs once unmounted.
 */
export function useMarketResearch(catalogProductId: string) {
  const mapi = api as unknown as MarketApi;
  const utils = mapi.useUtils();
  const input = { catalogProductId };

  const get = mapi.market.get.useQuery(input, {
    refetchInterval: (q) => (q.state.data?.status === "running" ? MARKET_POLL_MS : false),
  });
  const touch = mapi.market.touch.useMutation({
    onSuccess: (s) => utils.market.get.setData({ catalogProductId }, s),
  });

  const touchRef = useRef(touch.mutate);
  touchRef.current = touch.mutate;

  useEffect(() => {
    touchRef.current({ catalogProductId });
    const t = setInterval(() => touchRef.current({ catalogProductId }), MARKET_TTL_MS);
    return () => clearInterval(t);
  }, [catalogProductId]);

  return {
    state: get.data,
    error: get.isError ? (get.error?.message ?? "Error") : null,
    retry: () => touch.mutate({ catalogProductId }),
    retrying: touch.isPending,
  };
}
