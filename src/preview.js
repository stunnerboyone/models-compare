#!/usr/bin/env node
/**
 * Throwaway preview. NOT part of the pipeline.
 *
 *   node src/preview.js              # current models only — the realistic view
 *   node src/preview.js openai       # one organization
 *   node src/preview.js --per 20     # more rows per vendor
 *   node src/preview.js --rank 200   # widen which vendors count as relevant
 *   node src/preview.js --all        # every model ever benchmarked
 *
 * "Current" is derived, not given: Arena publishes no release dates. A model
 * counts as current if OpenRouter still serves it, or if it sits in the global
 * top 100 without a price — that combination means it launched too recently to
 * have reached the resale catalogue (qwen3.8-max, gemini-3-pro). Absent from
 * OpenRouter *and* ranked low means retired.
 *
 * This is a preview heuristic. The authoritative answer is the is-deprecated
 * switch in the CMS, which is a human call.
 *
 * Purpose: show the content team the actual shape of the data so they can
 * argue about columns and about which versions to hide, before anyone builds
 * anything in Webflow. Grouping here is by Arena's `organization` field —
 * the real site groups by the Vendor reference in the CMS.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const showAll = argv.includes("--all");
const perIdx = argv.indexOf("--per");
const PER_VENDOR = perIdx !== -1 ? Number(argv[perIdx + 1]) || 12 : 12;
const rankIdx = argv.indexOf("--rank");
// A vendor earns a page if it has at least one model this high on the board.
const VENDOR_RANK_CUTOFF = rankIdx !== -1 ? Number(argv[rankIdx + 1]) || 100 : 100;
const numericArgs = new Set([String(PER_VENDOR), String(VENDOR_RANK_CUTOFF)]);
const only =
  argv.find((a) => !a.startsWith("--") && !numericArgs.has(a))?.toLowerCase() ?? null;

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const data = JSON.parse(await readFile(join(ROOT, "data", "latest.json"), "utf8"));

const byOrg = new Map();
for (const m of data.models) {
  const org = m.organization ?? "unknown";
  if (only && org.toLowerCase() !== only) continue;
  if (!byOrg.has(org)) byOrg.set(org, []);
  byOrg.get(org).push(m);
}

// Arena tracks models back to 2023 — vicuna, koala, alpaca and friends sit at
// rank 330+ and will never appear on a page. Showing them makes the table look
// like a wall of missing data when the models that matter are largely fine.
// Two separate cuts, because they answer different questions.
//
// Which vendors get a page? Ones with a model near the top of the board.
// Arena tracks 27 organisations; most are research labs whose best entry sits
// at rank 300, and a page for them is never getting built.
//
// Which versions go in the table? The vendor's most recent handful. Everything
// below that is 2023-era and dead everywhere, not just missing a price here.
const isCurrent = (m) =>
  Boolean(m.price_match) || (m.arena_rank ?? 1e9) <= VENDOR_RANK_CUTOFF;

const trimmed = new Map();
for (const [org, models] of byOrg) {
  const sorted = models.sort((a, b) => (a.arena_rank ?? 1e9) - (b.arena_rank ?? 1e9));
  const current = showAll ? sorted : sorted.filter(isCurrent);
  if (!current.length) continue;

  // A vendor earns a page if something of theirs is near the top of the board.
  const relevantVendor =
    showAll || only || sorted.some((m) => (m.arena_rank ?? 1e9) <= VENDOR_RANK_CUTOFF);
  if (!relevantVendor) continue;

  trimmed.set(org, showAll ? current : current.slice(0, PER_VENDOR));
}

// Biggest vendors first — that's where the column problem is worst.
const orgs = [...trimmed.entries()].sort((a, b) => b[1].length - a[1].length);

const shown = orgs.flatMap(([, m]) => m);
const priced = shown.filter((m) => m.price_match).length;
const loose = shown.filter((m) => m.price_match === "loose").length;

const section = ([org, models]) => `
<section>
  <h2>${esc(org || "other / community")} <span class="count">${
    models.length
  } shown${showAll ? "" : ` · ${byOrg.get(org).length} on the leaderboard`}</span></h2>
  <table>
    <thead>
      <tr><th>Model</th><th>Arena Score</th><th>Rank</th><th>Released</th><th>Context</th><th>$ / 1M in</th><th>$ / 1M out</th></tr>
    </thead>
    <tbody>
      ${models
        .map((m) => {
          const noPrice = m.price_input_per_mtok == null;
          return `<tr${noPrice ? ' class="nomatch"' : ""}>
        <td class="name">${esc(m.arena_model_name)}${
            m.reasoning_mode ? `<span class="mode">${esc(m.reasoning_mode)}</span>` : ""
          }</td>
        <td class="num">${m.arena_score ?? "—"}</td>
        <td class="num">${m.arena_rank ?? "—"}</td>
        <td class="num">${esc(m.released_at ?? "—")}</td>
        <td class="num">${m.context_length ? (m.context_length / 1000).toFixed(0) + "K" : "—"}</td>
        <td class="num${m.price_source === "openrouter" ? " resold" : ""}">${
          m.price_input_per_mtok != null ? "$" + m.price_input_per_mtok.toFixed(2) : "—"
        }</td>
        <td class="num${m.price_source === "openrouter" ? " resold" : ""}">${
          m.price_output_per_mtok != null ? "$" + m.price_output_per_mtok.toFixed(2) : "—"
        }${m.price_match === "loose" ? '<span class="star">*</span>' : ""}</td>
      </tr>`;
        })
        .join("\n      ")}
    </tbody>
  </table>
</section>`;

const html = `<!doctype html>
<meta charset="utf-8">
<title>LLM data preview</title>
<style>
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 900px;
         margin: 3rem auto; padding: 0 1.5rem; color: #1a1a1a; }
  .note { background: #fff8e1; border-left: 3px solid #e6a700; padding: .8rem 1rem;
          margin-bottom: 2.5rem; font-size: 14px; }
  h1 { font-size: 1.6rem; margin-bottom: .3rem; }
  .meta { color: #666; font-size: 14px; margin-bottom: 1rem; }
  .stats { display: flex; flex-wrap: wrap; gap: 1.4rem; padding: .8rem 0;
           border-top: 1px solid #eee; border-bottom: 1px solid #eee;
           margin-bottom: 2rem; font-size: 13px; color: #555; }
  .stats strong { color: #1a1a1a; font-size: 15px; }
  .stats em { color: #a06000; font-style: normal; }
  h2 { font-size: 1.1rem; margin: 2.5rem 0 .6rem; text-transform: capitalize; }
  .count { font-weight: 400; color: #888; font-size: .8rem; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid #eee; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #666; }
  .name { font-family: ui-monospace, monospace; font-size: 13px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .nomatch { background: #fff5f5; }
  td.resold { color: #a06000; }
  td.resold::after { content: " (OR)"; font-size: 10px; }
  .star { color: #a06000; }
  .nomatch .name::after { content: " no price match"; color: #c00; font-size: 11px;
                          font-family: ui-sans-serif, sans-serif; }
  .mode { display: inline-block; margin-left: .4rem; padding: .05rem .35rem;
          background: #eef2ff; color: #4453b8; border-radius: 3px; font-size: 11px;
          font-family: ui-sans-serif, sans-serif; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #eee;
           color: #666; font-size: 13px; }
</style>

<h1>LLM data — preview</h1>
<p class="meta">Arena data published ${esc(data.arena.published_at)}</p>

<div class="stats">
  <span><strong>${shown.length}</strong> models shown${
    showAll
      ? ""
      : ` — current versions from ${orgs.length} vendors, of ${data.models.length} tracked`
  }</span>
  <span><strong>${priced}</strong> with a price</span>
  <span><strong>${shown.filter((m) => m.price_source === "official").length}</strong> at official vendor price</span>
  <span><strong>${shown.filter((m) => m.price_source === "openrouter").length}</strong> via OpenRouter <em>&dagger;</em></span>
  <span><strong>${loose}</strong> matched loosely <em>*</em></span>
  <span><strong>${shown.length - priced}</strong> without a price</span>
</div>

<div class="note">
  <strong>This is a data preview, not the design.</strong> It shows every version
  Arena currently lists per vendor, unfiltered. The real pages will hide
  deprecated versions and use the approved layout. Two things to decide from this:
  which columns stay, and whether <code>-thinking</code> variants get their own row.
  Rows shaded red have no price. At this filter level that means the model is
  newer than the pricing source, not that it's obsolete — those were filtered out. Prices marked with * were matched by a relaxed name rule and are worth
  a spot-check. Run with <code>--all</code> to include models back to 2023;
  those sit at rank 300+ and are dead everywhere, not just here.
</div>

${
  data.pricing
    ? `<div class="note" style="background:#eef4ff;border-color:#4453b8">
  <strong>Pricing is in USD per 1M tokens.</strong> Unmarked prices are the vendor's
  own list price from models.dev and can be published as such. Prices marked
  &dagger; come from OpenRouter and include its service fee, so they sit slightly
  above the vendor's price and need labelling. A <span class="star">*</span> means
  the model name was matched by a relaxed rule — worth a spot-check.
</div>`
    : ""
}

${orgs.map(section).join("\n")}

<footer>
  Model rankings from <a href="https://arena.ai/leaderboard">Arena</a>, CC-BY-4.0.
  Attribution like this is required on any published page.
</footer>
`;

const out = join(ROOT, "preview.html");
await writeFile(out, html);
console.log(
  `wrote preview.html — ${shown.length} of ${data.models.length} models` +
    `${showAll ? "" : ` (top ${PER_VENDOR} per vendor)`}` +
    ` across ${orgs.length}${showAll || only ? "" : ` of ${byOrg.size}`} organizations`
);
console.log(`  ${priced} priced, ${loose} of those matched loosely, ${shown.length - priced} without a price`);
