import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { OUT_FILE, generate } from "../../../scripts/db-docs.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

/** Guards that keep the database documentation honest. They fail loudly instead of letting docs rot. */
describe("database documentation", () => {
  it("docs/database/SCHEMA.md is generated from the current prisma/schema.prisma", () => {
    expect(fs.readFileSync(OUT_FILE as string, "utf8"), "run `pnpm db:docs` and commit the result").toBe(generate());
  });

  it("every model has a description in the schema", () => {
    const missing = [...read("prisma/schema.prisma").matchAll(/^(?:(\/\/\/[^\n]*\n)+)?model (\w+) \{/gm)]
      .filter((m) => !m[1])
      .map((m) => m[2]);
    expect(missing, "add a /// comment above these models").toEqual([]);
  });

  it("every migration is mentioned in docs/database/CHANGELOG.md", () => {
    const changelog = read("docs/database/CHANGELOG.md");
    const migrations = fs
      .readdirSync(path.join(root, "prisma/migrations"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(migrations.filter((m) => !changelog.includes(m)), "add an entry per migration").toEqual([]);
  });

  it("nothing in src reads or writes the deprecated legacy tables", () => {
    const legacy = /\b(?:db|tx|prisma)\.(apiCache|mlToken|userWorkbook|marketResearch)\b/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && legacy.test(fs.readFileSync(p, "utf8"))) offenders.push(path.relative(root, p));
      }
    };
    walk(path.join(root, "src"));
    expect(offenders).toEqual([]);
  });
});
