#!/usr/bin/env node
/**
 * Entry point.
 *
 *   node src/snapshot.js            # fetch, validate, write data/
 *   node src/snapshot.js --dry-run  # fetch, validate, print — write nothing
 *   WITH_OPENROUTER=1 node src/snapshot.js
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
import { normalize } from "./normalize.js";
import { validate, diffReport } from "./validate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const LATEST = join(DATA, "latest.json");

const dryRun = process.argv.includes("--dry-run");
const withOpenRouter = process.env.WITH_OPENROUTER === "1";

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
  if (withOpenRouter) {
    try {
      openrouter = await fetchOpenRouter();
      console.log(`fetched ${Object.keys(openrouter).length} openrouter models`);
    } catch (err) {
      // Pricing is a nice-to-have. Never let it kill the arena snapshot.
      console.warn(`warn: openrouter fetch failed, continuing without it — ${err.message}`);
    }
  }

  const payload = normalize(arenaRows, openrouter);
  validate(payload);

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
