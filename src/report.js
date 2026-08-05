#!/usr/bin/env node
/**
 * Match diagnostics. Writes match-report.txt.
 *
 *   node src/report.js           # orgs with at least 2 unmatched models
 *   node src/report.js anthropic # one org, everything
 *   node src/report.js --all     # every org
 *
 * The output pairs, per vendor, the Arena names that found no price against
 * the OpenRouter ids nobody claimed. Rules get written by reading those two
 * columns side by side — a name in the left column that obviously corresponds
 * to one on the right means canon() is missing a normalisation.
 */

import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchArena } from "./sources/arena.js";
import { fetchOpenRouter } from "./sources/openrouter.js";
import { normalize } from "./normalize.js";
import { canon, looseKeys } from "./match.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const arg = process.argv[2] ?? null;
const showAll = arg === "--all";
const onlyOrg = arg && !arg.startsWith("--") ? arg.toLowerCase() : null;

// OpenRouter prefixes don't always equal Arena's `organization` string.
const ORG_ALIASES = {
  google: ["google"],
  openai: ["openai"],
  anthropic: ["anthropic"],
  xai: ["x-ai"],
  meta: ["meta-llama"],
  alibaba: ["qwen", "alibaba"],
  deepseek: ["deepseek"],
  mistral: ["mistralai", "mistral"],
  moonshot: ["moonshotai", "moonshot"],
  zhipu: ["z-ai", "thudm", "zhipu"],
  nvidia: ["nvidia"],
  amazon: ["amazon"],
  microsoft: ["microsoft"],
  cohere: ["cohere"],
};

function orPrefixesFor(org) {
  const key = (org ?? "").toLowerCase();
  return ORG_ALIASES[key] ?? [key];
}

const arenaRows = await fetchArena();
const openrouter = await fetchOpenRouter();
const payload = normalize(arenaRows, openrouter);

// canonical -> raw openrouter id, plus which ones got claimed
const orByCanon = new Map();
for (const rec of Object.values(openrouter)) {
  const { id } = canon(rec.id);
  if (!orByCanon.has(id)) orByCanon.set(id, rec.id);
}
const claimed = new Set(payload.models.filter((m) => m.openrouter_id).map((m) => m.openrouter_id));

// group arena models by org
const orgs = new Map();
for (const m of payload.models) {
  const org = (m.organization ?? "unknown").toLowerCase();
  if (onlyOrg && org !== onlyOrg) continue;
  if (!orgs.has(org)) orgs.set(org, { total: 0, matched: 0, unmatched: [] });
  const g = orgs.get(org);
  g.total += 1;
  if (m.openrouter_id) g.matched += 1;
  else g.unmatched.push(m);
}

// why each model failed, keyed by arena name
const reasons = new Map(payload.pricing.unmatched_models.map((u) => [u.arena, u.reason]));

const lines = [];
lines.push(`arena published: ${payload.arena.published_at}`);
lines.push(
  `overall: ${payload.pricing.matched}/${payload.models.length} matched ` +
    `(${payload.pricing.matched_strict} strict, ${payload.pricing.matched_loose} loose, ` +
    `${payload.pricing.blocked_ambiguous} blocked), ${payload.pricing.unmatched} without a price`
);
lines.push(
  `top 50 by score: ${payload.pricing.coverage_top50}/50 priced`
);
lines.push(`openrouter catalogue: ${Object.keys(openrouter).length} models`);
lines.push("");

const sorted = [...orgs.entries()].sort((a, b) => b[1].unmatched.length - a[1].unmatched.length);

for (const [org, g] of sorted) {
  if (!showAll && !onlyOrg && g.unmatched.length < 2) continue;

  // unused openrouter ids belonging to this vendor
  const prefixes = orPrefixesFor(org);
  const unused = [...orByCanon.entries()]
    .filter(([, raw]) => !claimed.has(raw) && prefixes.some((p) => raw.startsWith(p + "/")))
    .map(([c]) => c)
    .sort();

  const loose = g.unmatched.length;
  lines.push(
    `=== ${org} — ${g.total} on arena, ${g.matched} matched, ${loose} unmatched`
  );
  lines.push("  ARENA without a price (canonical form):");
  for (const m of g.unmatched) {
    const c = canon(m.arena_model_name);
    const why = reasons.get(m.arena_model_name) ?? "?";
    lines.push(
      `    [${why}] ${m.arena_model_name.padEnd(42)} strict:${c.id.padEnd(32)} loose:${looseKeys(
        m.arena_model_name,
        m.organization
      ).join(" | ")}`
    );
  }
  lines.push(`  OPENROUTER unclaimed for this vendor (${unused.length}):`);
  for (const u of unused) lines.push(`    ${u}`);
  lines.push("");
}

const text = lines.join("\n");
await writeFile(join(ROOT, "match-report.txt"), text + "\n");

console.log(text.slice(0, 4000));
console.log(`\n[full report written to match-report.txt — ${lines.length} lines]`);
