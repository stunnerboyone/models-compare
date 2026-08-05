/**
 * models.dev — official vendor pricing and release dates.
 *
 * https://models.dev/api.json — public, no auth, one request for everything.
 * Open source (github.com/sst/models.dev), data kept as TOML and validated.
 *
 * The catalogue lists ~150 providers, and most of them are resellers. The same
 * model can appear at wildly different prices:
 *
 *   google         gemini-3-pro-preview   $2 / $12     <- the vendor's own price
 *   qihang-ai      gemini-3-pro-preview   $0.57 / $3.43
 *   orcarouter     gemini-3-pro-preview   $4 / $18
 *
 * So "official price" means: the entry under the provider id that *is* the
 * vendor. Everything else is ignored. That whitelist lives in
 * config/price-sources.json so a vendor can be added without touching code.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const URL = "https://models.dev/api.json";

async function whitelist() {
  const cfg = JSON.parse(
    await readFile(join(ROOT, "config", "price-sources.json"), "utf8")
  );
  return cfg.first_party ?? [];
}

export async function fetchModelsDev() {
  const allowed = await whitelist();

  const res = await fetch(URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`models.dev: HTTP ${res.status}`);

  const db = await res.json();
  if (!db || typeof db !== "object") {
    throw new Error("models.dev: unexpected payload");
  }

  const out = {};
  const missing = [];

  for (const provider of allowed) {
    const p = db[provider];
    if (!p) {
      missing.push(provider);
      continue;
    }

    for (const [id, m] of Object.entries(p.models ?? {})) {
      const input = m.cost?.input;
      const output = m.cost?.output;

      // Some providers list a model without pricing, and some list $0 for
      // bundled plans. Neither is a real price — skip rather than publish it.
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      if (input === 0 && output === 0) continue;

      // First provider in the whitelist wins, so ordering there is priority.
      if (out[id]) continue;

      out[id] = {
        id,
        provider,
        name: m.name ?? null,
        price_input_per_mtok: input,
        price_output_per_mtok: output,
        context_length: m.limit?.context ?? m.context ?? null,
        max_output: m.limit?.output ?? null,
        released_at: m.release_date ?? null,
        knowledge_cutoff: m.knowledge ?? null,
      };
    }
  }

  if (missing.length) {
    console.warn(
      `warn: models.dev has no provider(s) ${missing.join(", ")} — check config/price-sources.json`
    );
  }

  return out;
}
