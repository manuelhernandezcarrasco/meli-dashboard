#!/usr/bin/env node
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck: plain Node tool (also imported by the tests) that walks Prisma's untyped DMMF
// Generates docs/database/SCHEMA.md (ERDs per domain + data dictionary) from prisma/schema.prisma.
//
//   pnpm db:docs           rewrite the file
//   pnpm db:docs --check   exit 1 if the file is stale (the test suite runs the same check)
//
// Descriptions come from the `///` comments in the schema, so documenting a model there is the
// only thing needed to document it here. Domains are listed in DOMAINS below.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_FILE = path.join(root, "prisma/schema.prisma");
export const OUT_FILE = path.join(root, "docs/database/SCHEMA.md");

/** Domains in "order of concept": who -> what they bring -> what the marketplace says -> what we derive. */
export const DOMAINS = [
  {
    title: "1. Tenancy and connection",
    blurb: "Who the data belongs to and how the app reaches each marketplace on their behalf.",
    models: ["Account", "MarketplaceConnection"],
  },
  {
    title: "2. Business master data (Excel uploads and person decisions)",
    blurb:
      "What the business knows and Mercado Libre does not: product costs, previous close, mappings, direct sales, restocking, and the yes/no answers on title matches. Replaced by each upload, never overwritten by a sync.",
    models: ["Account", "Upload", "Product", "PnlClosing", "CostOverride", "ProductMapping", "DirectSale", "StockReceipt", "MatchDecision"],
  },
  {
    title: "3. Marketplace facts",
    blurb:
      "What a marketplace API returns, normalized: listings, orders and their lines, payments with their taxes, shipments, seller nicknames. Every table carries `marketplace` in its key (ids from different marketplaces can collide). Written by the sync with idempotent bulk upserts; the order tables also record which months are final.",
    models: ["Account", "Listing", "ListingVariation", "Seller", "Shipment", "Order", "OrderItem", "Payment", "PaymentTax", "OrderPayment", "OrderPeriod"],
  },
  {
    title: "4. Derived read models",
    blurb:
      "Rebuildable from sections 2 and 3. SaleLine is the table statistics should query; Snapshot is the dashboard exactly as the UI receives it; MarketScan/MarketOffer keep every pull of a catalog product's offers so prices can be charted over time.",
    models: ["Account", "SaleLine", "Snapshot", "MarketScan", "MarketOffer", "CompetitorSale", "Seller"],
  },
  {
    title: "5. Inventory (stock module)",
    blurb:
      "The app is the source of truth for stock and weighted-average cost. StockMovement is an append-only ledger; InventoryProduct.onHand/unitCost are caches of it. Purchase invoices feed the ledger after review, ListingLink ties marketplace listings to products (combos supported), pushes to the marketplace are logged, and alerts and returns need a person's decision. Design: docs/tickets/stock/PLAN.md.",
    models: [
      "Account", "InventoryProduct", "StockMovement", "ProductCostEntry", "PurchaseInvoice", "PurchaseInvoiceLine",
      "ListingLink", "ListingLinkComponent", "ListingSyncState", "MlPushLog", "StockAlert", "ReturnCase",
      "WebhookEvent", "InventorySettings", "OrderItem",
    ],
  },
];

const MERMAID_TYPE = {
  String: "string",
  Int: "int",
  BigInt: "bigint",
  Float: "float",
  Decimal: "decimal",
  Boolean: "boolean",
  DateTime: "datetime",
  Json: "json",
};

/** @param {any} m */
const isDeprecated = (m) => /^@deprecated/.test(m.documentation ?? "");

function loadDatamodel() {
  const require = createRequire(import.meta.url);
  const { Prisma } = require(path.join(root, "generated/prisma"));
  return Prisma.dmmf.datamodel;
}

/** `@@index([a, b(sort: Desc)])` and `@@id` lines per model, read from the schema text. */
/** @param {string} schemaText */
function indexesFromSchema(schemaText) {
  /** @type {Record<string, string[]>} */
  const out = {};
  const blocks = schemaText.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm);
  for (const [, name, body] of blocks) {
    const idx = [];
    for (const m of body.matchAll(/@@index\(\[([^\]]*)\](?:,\s*type:\s*(\w+))?[^)]*\)/g)) {
      const cols = m[1].split(/,\s*(?![^()]*\))/).map((c) => c.trim().replace(/\(sort:\s*Desc\)/, " DESC").replace(/\(ops:[^)]*\)\)?/, ""));
      idx.push(`${m[2] ? `${m[2]} ` : ""}(${cols.join(", ")})`);
    }
    out[name] = idx;
  }
  return out;
}

/** @param {any} model */
function fieldKeys(model) {
  const pk = new Set(model.primaryKey?.fields ?? model.fields.filter((f) => f.isId).map((f) => f.name));
  const fk = new Set(model.fields.flatMap((f) => f.relationFromFields ?? []));
  return { pk, fk };
}

/** @param {any} f */
function attrType(f) {
  return f.kind === "enum" ? f.type : (MERMAID_TYPE[f.type] ?? f.type.toLowerCase());
}

/** One mermaid erDiagram for a set of models. */
/**
 * @param {any} datamodel
 * @param {string[]} names
 */
function erDiagram(datamodel, names) {
  const models = names.map((n) => datamodel.models.find((m) => m.name === n)).filter(Boolean);
  const inSet = new Set(names);
  const lines = ["erDiagram"];
  const seen = new Set();
  for (const m of models) {
    for (const f of m.fields) {
      if (f.kind !== "object" || !f.relationFromFields?.length || !inSet.has(f.type)) continue;
      const { pk } = fieldKeys(m);
      const oneToOne = f.relationFromFields.length === pk.size && f.relationFromFields.every((x) => pk.has(x));
      const parentSide = f.isRequired ? "||" : "|o";
      const childSide = oneToOne ? "o|" : "o{";
      const key = `${f.type}|${m.name}|${f.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  ${f.type} ${parentSide}--${childSide} ${m.name} : ${f.name}`);
    }
  }
  for (const m of models) {
    const { pk, fk } = fieldKeys(m);
    lines.push(`  ${m.name} {`);
    for (const f of m.fields) {
      if (f.kind === "object") continue;
      const keys = [pk.has(f.name) ? "PK" : null, fk.has(f.name) ? "FK" : null].filter(Boolean).join(", ");
      lines.push(`    ${attrType(f)} ${f.name}${keys ? ` ${keys}` : ""}${f.isRequired ? "" : ' "null"'}`);
    }
    lines.push("  }");
  }
  return lines.join("\n");
}

/** @param {any} f */
const sqlType = (f) => {
  if (f.kind === "enum") return `enum ${f.type}`;
  const [n, args] = f.nativeType ?? [];
  if (n && args?.length) return `${n.toLowerCase()}(${args.join(",")})`;
  return (n ?? f.type).toLowerCase();
};

const cell = (s) => String(s ?? "").replace(/\\n/g, " ").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();

/**
 * @param {any} datamodel
 * @param {any} model
 * @param {Record<string, string[]>} indexes
 */
function dictionary(datamodel, model, indexes) {
  const { pk, fk } = fieldKeys(model);
  const rows = model.fields
    .filter((f) => f.kind !== "object")
    .map((f) => {
      const keys = [pk.has(f.name) ? "PK" : null, fk.has(f.name) ? "FK" : null].filter(Boolean).join(" ");
      return `| \`${f.name}\` | ${sqlType(f)} | ${f.isRequired ? "" : "null"} | ${keys} | ${cell(f.documentation)} |`;
    });
  const rel = model.fields
    .filter((f) => f.kind === "object" && f.relationFromFields?.length)
    .map((f) => `\`(${f.relationFromFields.join(", ")})\` → \`${f.type}\` (on delete ${f.relationOnDelete ?? "restrict"})`);
  const idx = indexes[model.name] ?? [];
  return [
    `#### ${model.name}`,
    "",
    cell(model.documentation) || "_No description: add a `///` comment above the model in `prisma/schema.prisma`._",
    "",
    "| Column | Type | Null | Key | Description |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    ...(rel.length ? [`Foreign keys: ${rel.join("; ")}.`, ""] : []),
    ...(idx.length ? [`Extra indexes: ${idx.map((i) => `\`${i}\``).join(", ")}.`, ""] : []),
  ].join("\n");
}

/**
 * @param {any} datamodel Prisma DMMF datamodel
 * @param {string} schemaText contents of schema.prisma
 */
export function renderSchemaDoc(datamodel, schemaText) {
  const indexes = indexesFromSchema(schemaText);
  const live = datamodel.models.filter((m) => !isDeprecated(m));
  const legacy = datamodel.models.filter(isDeprecated);
  const parts = [
    "<!-- GENERATED FILE: do not edit. Source: prisma/schema.prisma. Regenerate with `pnpm db:docs`. -->",
    "",
    "# Database schema",
    "",
    `${live.length} tables in ${DOMAINS.length} domains (PostgreSQL, managed with Prisma). Diagrams and the data dictionary below are generated from \`prisma/schema.prisma\`; the reasoning behind the design is in [ANALYSIS.md](ANALYSIS.md) and the history of changes in [CHANGELOG.md](CHANGELOG.md).`,
    "",
    "Reading the diagrams: `||--o{` is one-to-many, `||--o|` one-to-one, `PK`/`FK` mark key columns, `null` marks nullable columns. Every business table carries `accountId` as the first column of its primary key.",
    "",
  ];
  const placed = new Set();
  for (const d of DOMAINS) {
    d.models.forEach((n) => placed.add(n));
    parts.push(`## ${d.title}`, "", d.blurb, "", "```mermaid", erDiagram(datamodel, d.models), "```", "");
    parts.push("### Data dictionary", "");
    for (const n of d.models) {
      if (n === "Account" && d.title.startsWith("2")) continue;
      if (n === "Account" && !d.title.startsWith("1")) continue;
      if (n === "Seller" && d.title.startsWith("4")) continue; // documented in section 3
      const m = datamodel.models.find((x) => x.name === n);
      if (m) parts.push(dictionary(datamodel, m, indexes));
    }
  }
  const missing = live.filter((m) => !placed.has(m.name)).map((m) => m.name);
  if (missing.length) {
    parts.push("## Ungrouped tables", "", `Add these to \`DOMAINS\` in \`scripts/db-docs.mjs\`: ${missing.join(", ")}.`, "");
    for (const n of missing) parts.push(dictionary(datamodel, live.find((m) => m.name === n), indexes));
  }
  parts.push("## Enums", "");
  for (const e of datamodel.enums) {
    parts.push(`- \`${e.name}\`: ${e.values.map((v) => `\`${v.name}\``).join(", ")}${e.documentation ? ` — ${cell(e.documentation)}` : ""}`);
  }
  parts.push("", "## Full diagram", "", "Every table in one picture (large; use the domain diagrams above to read it).", "", "```mermaid", erDiagram(datamodel, live.map((m) => m.name)), "```", "");
  if (legacy.length) {
    parts.push(
      "## Deprecated tables",
      "",
      "Kept for one release so the backfill can be verified or re-run, then dropped (see [MIGRATION.md](MIGRATION.md)). Nothing may read or write them.",
      "",
      ...legacy.map((m) => `- \`${m.name}\`: ${cell(m.documentation).replace(/^@deprecated\s*/, "")}`),
      "",
    );
  }
  return parts.join("\n");
}

export function generate() {
  return renderSchemaDoc(loadDatamodel(), fs.readFileSync(SCHEMA_FILE, "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = generate();
  if (process.argv.includes("--check")) {
    const cur = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : "";
    if (cur !== next) {
      console.error("docs/database/SCHEMA.md is out of date. Run `pnpm db:docs` and commit the result.");
      process.exit(1);
    }
    console.log("docs/database/SCHEMA.md is up to date.");
  } else {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, next);
    console.log(`Wrote ${path.relative(root, OUT_FILE)}`);
  }
}
