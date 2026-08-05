#!/usr/bin/env node
/**
 * What goes on each /models/<vendor> page.
 *
 *   node src/vendors.js            # every vendor
 *   node src/vendors.js claude     # one
 *   node src/vendors.js --votes    # order by vote count instead of rank
 *   node src/vendors.js --check    # validate curated lists, exit 1 on problems
 *
 * Membership comes from config/vendors.json. Reads data/latest.json, so run
 * snapshot.js first.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const byVotes = argv.includes("--votes");
const checkOnly = argv.includes("--check");
const TOP_N = 10;
const only = argv.find((a) => !a.startsWith("--"))?.toLowerCase() ?? null;

const data = JSON.parse(await readFile(join(ROOT, "data", "latest.json"), "utf8"));
const config = JSON.parse(await readFile(join(ROOT, "config", "vendors.json"), "utf8"));

const isCurrent = (m) => Boolean(m.price_match) || (m.arena_rank ?? 1e9) <= 100;
const byName = new Map(data.models.map((m) => [m.arena_model_name, m]));

const problems = [];
// current models excluded by a family filter — worth eyeballing in case the
// prefix list is missing a product line
const skipped = new Map();

function membersOf(label, def) {
  if (def.mode === "org") {
    const hit = (m, list) =>
      list.some((p) => m.arena_model_name.toLowerCase().startsWith(p.toLowerCase()));

    const models = data.models.filter((m) => {
      if ((m.organization ?? "").toLowerCase() !== def.org) return false;
      if (!isCurrent(m)) return false;
      // The nav is organised by product family, Arena by company. Meta ships
      // Llama alongside other lines; Google ships Gemini alongside Gemma.
      if (def.include?.length && !hit(m, def.include)) return false;
      if (def.exclude?.length && hit(m, def.exclude)) return false;
      return true;
    });

    if (def.include?.length) {
      const dropped = data.models.filter(
        (m) =>
          (m.organization ?? "").toLowerCase() === def.org &&
          isCurrent(m) &&
          !models.includes(m)
      );
      if (dropped.length) {
        skipped.set(label, dropped.map((m) => m.arena_model_name));
      }
    }

    return models;
  }

  // curated
  const out = [];
  for (const name of def.models ?? []) {
    const m = byName.get(name);
    if (!m) {
      problems.push(`${label}: "${name}" is not in the current leaderboard`);
      continue;
    }
    out.push(m);
  }

  if (!def.models?.length) {
    problems.push(`${label}: curated list is empty — the page has no table yet`);
  } else if (!def.verified_at) {
    problems.push(`${label}: never verified — set verified_at`);
  } else {
    const age = (Date.now() - Date.parse(def.verified_at)) / 86400000;
    const limit = config.stale_after_days ?? 60;
    if (age > limit) {
      problems.push(
        `${label}: last verified ${Math.round(age)} days ago (limit ${limit}) — recheck the vendor's docs`
      );
    }
  }

  return out;
}

const entries = Object.entries(config.vendors).filter(([l]) => !only || l === only);

for (const [label, def] of entries) {
  const models = membersOf(label, def).sort((a, b) =>
    byVotes
      ? (b.arena_votes ?? 0) - (a.arena_votes ?? 0)
      : (a.arena_rank ?? 1e9) - (b.arena_rank ?? 1e9)
  );

  if (checkOnly) continue;

  const origin = def.mode === "org" ? `arena org: ${def.org}` : "hand-curated";
  console.log(`\n### ${label}  (${origin}) — ${models.length} models`);

  if (def.note) console.log(`  ! ${def.note}`);

  if (!models.length) {
    console.log("  (nothing to show)");
    continue;
  }

  console.log(
    `  ${"rank".padStart(4)}  ${"model".padEnd(38)} ${"score".padStart(7)} ${"votes".padStart(8)}  ${"released".padEnd(11)}price`
  );
  for (const m of models.slice(0, TOP_N)) {
    const price =
      m.price_input_per_mtok != null
        ? `$${m.price_input_per_mtok}/$${m.price_output_per_mtok}`
        : "—";
    console.log(
      `  ${String(m.arena_rank).padStart(4)}  ${m.arena_model_name.padEnd(38)} ` +
        `${String(m.arena_score).padStart(7)} ${String(m.arena_votes ?? "—").padStart(8)}  ` +
        `${(m.released_at ?? "—").padEnd(11)}${price}`
    );
  }
  if (models.length > TOP_N) console.log(`  ... and ${models.length - TOP_N} more`);
}

if (skipped.size && !checkOnly) {
  console.log("\nExcluded by family filter (same company, different product line):");
  for (const [label, names] of skipped) {
    console.log(`  ${label}: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ` +${names.length - 8}` : ""}`);
  }
}

if (problems.length) {
  console.log("\nPROBLEMS:");
  for (const p of problems) console.log(`  - ${p}`);
}

if (!checkOnly) {
  console.log(
    "\nVote counts accumulate over a model's lifetime, so an older model can" +
      "\noutvote a better new one. Rank reflects quality now; votes reflect exposure."
  );
}

if (checkOnly && problems.length) process.exit(1);
