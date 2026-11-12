// ==UserScript==
// @name         PnL market collector
// @namespace    pnl-diario-ml
// @version      1.0.0
// @description  Reads "+N vendidos" and the seller name from competitor listings for the market-research chart.
// @match        http://localhost:3000/market-research/*
// @match        https://*.onrender.com/market-research/*
// @grant        GM_xmlhttpRequest
// @connect      mercadolibre.com.ar
// @connect      articulo.mercadolibre.com.ar
// @connect      www.mercadolibre.com.ar
// ==/UserScript==

// Runs in YOUR browser: Mercado Libre serves these listing pages to real browsers but blocks servers.
// The app page asks for a list of listings via window.postMessage; this script fetches each one slowly,
// parses the sales bucket + seller, and posts the results back. Nothing leaves the browser except to
// mercadolibre.com.ar (listings) and back to the app page you already have open.
// To use another app domain, add an @match line above (Tampermonkey: Edit -> add line).
(() => {
  "use strict";
  const MIN_DELAY_MS = 1500;
  const MAX_DELAY_MS = 3000;
  const FLUSH_EVERY = 5;
  const MAX_CONSECUTIVE_BLOCKS = 2;

  const send = (msg) => window.postMessage({ source: "pnl-collector", ...msg }, window.location.origin);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = () => MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);

  const fetchHtml = (url) =>
    new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout: 20000,
        onload: (r) => resolve({ html: r.responseText ?? "", finalUrl: r.finalUrl ?? url, status: r.status }),
        onerror: () => reject(new Error("network")),
        ontimeout: () => reject(new Error("timeout")),
      });
    });

  const SOLD_RE = /(\d[\d.,]*)\s*(mil)?\s*vendidos?/i;
  const toCount = (m) => {
    const n = parseInt(m[1].replace(/[.,]/g, ""), 10);
    return Number.isFinite(n) ? (m[2] ? n * 1000 : n) : null;
  };

  /** -> { sold, nickname } | null when the page is a block/login wall or has no recognisable header. */
  function parseListing(html, finalUrl) {
    if (/account-verification|negative_traffic|\/registration|\/login/.test(finalUrl)) return null;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const subtitle = doc.querySelector(".ui-pdp-subtitle");
    if (!subtitle || !doc.querySelector("h1")) return null;
    const m = SOLD_RE.exec(subtitle.textContent ?? "");
    // "Nuevo" with no "vendidos" means no sales yet; any other subtitle layout is not trusted.
    if (!m && !/nuevo|usado/i.test(subtitle.textContent ?? "")) return null;
    const sold = m ? toCount(m) : 0;
    if (sold == null) return null;

    const link =
      doc.querySelector(".ui-pdp-seller__link-trigger") ??
      doc.querySelector(".ui-pdp-seller__header__title") ??
      doc.querySelector('a[href*="/perfil/"]');
    let nickname = (link?.textContent ?? "").replace(/^\s*Vendido por\s*/i, "").trim();
    if (!nickname) {
      const t = /Vendido por\s*([\w.\-]+)/i.exec(doc.body?.textContent ?? "");
      nickname = t ? t[1] : "";
    }
    return { sold, nickname: nickname || null };
  }

  let runId = 0;

  async function collect(items) {
    const mine = ++runId; // a newer request cancels this one
    let done = 0;
    let blocks = 0;
    let batch = [];
    const flush = () => {
      if (batch.length) send({ type: "results", items: batch });
      batch = [];
    };
    send({ type: "progress", done, total: items.length });
    for (const it of items) {
      if (mine !== runId) return;
      try {
        const { html, finalUrl } = await fetchHtml(it.permalink);
        const parsed = parseListing(html, finalUrl);
        if (parsed) {
          blocks = 0;
          batch.push({ itemId: it.itemId, ...parsed });
        } else if (++blocks >= MAX_CONSECUTIVE_BLOCKS) {
          console.warn("[pnl-collector] Mercado Libre pages not readable (login wall?). Stopping.");
          break;
        }
      } catch (e) {
        console.warn("[pnl-collector] fetch failed", it.itemId, e);
      }
      done++;
      send({ type: "progress", done, total: items.length });
      if (batch.length >= FLUSH_EVERY) flush();
      if (done < items.length) await sleep(jitter());
    }
    if (mine !== runId) return;
    flush();
    send({ type: "done" });
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const m = e.data;
    if (!m || m.source !== "pnl-app") return;
    if (m.type === "ping") send({ type: "hello" });
    else if (m.type === "collect" && Array.isArray(m.items)) {
      const items = m.items
        .filter((i) => typeof i?.itemId === "string" && /^https:\/\/[\w.-]*mercadolibre\.com\.ar\//.test(String(i.permalink)))
        .slice(0, 100);
      void collect(items);
    }
  });

  send({ type: "hello" });
})();
