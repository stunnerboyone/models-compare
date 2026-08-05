#!/usr/bin/env node
/**
 * Entry point.
 *
 *   node src/snapshot.js            # fetch, validate, write data/
 *   node src/snapshot.js --dry-run  # fetch, validate, print — write nothing
 *   WITHOUT_PRICING=1 node src/snapshot.js   # arena only
 *
 * Exit codes:
 *   0  ok (whether or not anything changed)
 *   1  fetch or validation failed — nothing was written
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchArena, arenaMeta } from "./sources/arena.js";
import { fetchOpenRouter } from "./sources/openrouter.js";
import { fetchModelsDev } from "./sources/modelsdev.js";
import { normalize } from "./normalize.js";
import { validate, diffReport } from "./validate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const LATEST = join(DATA, "latest.json");

const dryRun = process.argv.includes("--dry-run");
// Pricing is on by default. WITHOUT_PRICING=1 to skip it.
const withPricing = process.env.WITHOUT_PRICING !== "1";

async function readLatest() {
  if (!existsSync(LATEST)) return null;
  try {
    return JSON.parse(await readFile(LATEST, "utf8"));
  } catch {
    console.warn("warn: data/latest.json is unreadable, treating as first run");
    return null;
  }
}

/** ignore volatile fields when deciding whether anything actually changed */
function fingerprint(payload) {
  return JSON.stringify({
    published_at: payload.arena.published_at,
    models: payload.models.map((m) => [
      m.arena_model_name,
      m.arena_score,
      m.arena_rank,
      m.arena_votes,
      m.price_input_per_mtok ?? null,
      m.price_output_per_mtok ?? null,
      m.price_source ?? null,
    ]),
  });
}

async function main() {
  console.log(
    `source: ${arenaMeta.dataset} / ${arenaMeta.config} / ${arenaMeta.split} / category=${arenaMeta.category}`
  );

  const arenaRows = await fetchArena();
  console.log(`fetched ${arenaRows.length} arena rows`);

  let openrouter = null;
  if (withPricing) {
    try {
      openrouter = await fetchOpenRouter();
      console.log(`fetched ${Object.keys(openrouter).length} openrouter models`);
    } catch (err) {
      // Pricing is a nice-to-have. Never let it kill the arena snapshot.
      console.warn(`warn: openrouter fetch failed, continuing without it — ${err.message}`);
    }
  }

  let official = null;
  if (withPricing) {
    try {
      official = await fetchModelsDev();
      console.log(`fetched ${Object.keys(official).length} first-party models from models.dev`);
    } catch (err) {
      console.warn(`warn: models.dev fetch failed, falling back to OpenRouter prices — ${err.message}`);
    }
  }

  const payload = normalize(arenaRows, openrouter, official);
  validate(payload);

  if (payload.pricing) {
    const p = payload.pricing;
    const top = Math.min(50, payload.models.length);
    console.log(
      `pricing: ${p.matched}/${payload.models.length} matched ` +
        `(${p.matched_strict} strict, ${p.matched_loose} loose, ${p.blocked_ambiguous} blocked as ambiguous)`
    );
    console.log(
      `         ${p.official} at the vendor's official price, ${p.matched - p.official} via OpenRouter`
    );
    console.log(
      `         ${p.coverage_top50}/${top} of the top ${top} by score — this is the number that matters`
    );
    // A matched model priced at zero usually means a free routing variant
    // slipped through and the real price is being hidden.
    const zero = payload.models.filter(
      (m) => m.price_match && m.price_input_per_mtok === 0
    );
    if (zero.length) {
      console.log(
        `WARN     ${zero.length} matched model(s) priced at $0 — check for :free variants`
      );
    }

    const unmatched = p.unmatched;
    if (unmatched && process.env.SHOW_UNMATCHED === "1") {
      for (const u of payload.pricing.unmatched_models) {
        console.log(`  no price: ${u.arena}  (canonical: ${u.canonical})`);
      }
    }
  }

  const prev = await readLatest();
  const report = diffReport(prev, payload);

  if (report.first_run) {
    console.log("first run — no diff to report");
  } else {
    for (const c of report.changes) console.log(`CHANGE  ${c}`);
    for (const w of report.warnings) console.log(`WARN    ${w}`);
    if (!report.changes.length && !report.warnings.length) {
      console.log("no notable changes");
    }
  }

  console.log(
    `\ntop 5 by arena score (published ${payload.arena.published_at}):`
  );
  for (const m of payload.models.slice(0, 5)) {
    console.log(
      `  #${String(m.arena_rank).padStart(2)}  ${m.arena_model_name.padEnd(32)} ${m.arena_score}  (${m.organization})`
    );
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written");
    return;
  }

  const unchanged = prev && fingerprint(prev) === fingerprint(payload);
  if (unchanged) {
    console.log("\nno data change since last snapshot — not writing");
    return;
  }

  await mkdir(join(DATA, "snapshots"), { recursive: true });

  const json = JSON.stringify(payload, null, 2) + "\n";
  await writeFile(LATEST, json);
  await writeFile(
    join(DATA, "snapshots", `${payload.arena.published_at}.json`),
    json
  );

  console.log(`\nwrote data/latest.json and data/snapshots/${payload.arena.published_at}.json`);

  // Surfaced to the workflow so the alert step knows what to say.
  if (process.env.GITHUB_OUTPUT) {
    const summary = [...report.changes, ...report.warnings].join("; ") || "routine update";
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `changed=true\nsummary=${summary.replace(/\n/g, " ").slice(0, 900)}\n`,
      { flag: "a" }
    );
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
