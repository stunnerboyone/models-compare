#!/usr/bin/env node
/**
 * Watches the vendor pages that document which models a product uses.
 *
 *   node src/watch.js            # fetch, compare, report
 *   node src/watch.js --accept   # record current state as the new baseline
 *
 * Exit 2 when something changed, so CI can alert.
 *
 * Why watch instead of parse: Copilot's and Perplexity's model lineups are
 * published as prose in help docs, restructured whenever marketing feels like
 * it, and qualified by surface, region and admin policy. A scraper would break
 * constantly and — worse — would break silently into plausible-looking wrong
 * data. Hashing the page can't tell us what changed, but it reliably tells us
 * *that* something changed, which is the part a human needs to know.
 *
 * The curated lists in config/vendors.json stay hand-written. This just stops
 * them from rotting unnoticed.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = join(ROOT, "data", "watch.json");

const accept = process.argv.includes("--accept");

const config = JSON.parse(await readFile(join(ROOT, "config", "vendors.json"), "utf8"));

const targets = [];
for (const [label, def] of Object.entries(config.vendors)) {
  for (const url of def.sources ?? []) targets.push({ label, url });
}

if (!targets.length) {
  console.log("no source URLs configured — add them under vendors[].sources");
  process.exit(0);
}

/**
 * Strip the parts of a page that change on every request (timestamps, CSRF
 * tokens, build ids, analytics blobs) so we only react to real edits.
 */
function fingerprint(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return {
    hash: createHash("sha256").update(text).digest("hex").slice(0, 16),
    length: text.length,
  };
}

const previous = existsSync(STATE)
  ? JSON.parse(await readFile(STATE, "utf8"))
  : { pages: {} };

const next = { checked_at: new Date().toISOString(), pages: {} };
const changes = [];
const failures = [];

for (const { label, url } of targets) {
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: "text/html", "user-agent": "llm-data-watch" },
    });
  } catch (err) {
    failures.push(`${label}: ${url} — ${err.message}`);
    continue;
  }

  if (!res.ok) {
    failures.push(`${label}: ${url} — HTTP ${res.status}`);
    // Keep the old baseline rather than losing it to a transient error.
    if (previous.pages[url]) next.pages[url] = previous.pages[url];
    continue;
  }

  const fp = fingerprint(await res.text());
  const before = previous.pages[url];

  next.pages[url] = { label, ...fp, seen_at: new Date().toISOString() };

  if (!before) {
    console.log(`NEW      ${label}  ${url}`);
    continue;
  }

  if (before.hash !== fp.hash) {
    const delta = fp.length - before.length;
    changes.push(
      `${label}: ${url}\n    content changed (${delta > 0 ? "+" : ""}${delta} chars) — recheck the model list`
    );
    // Carry the old baseline forward until a human accepts the change.
    if (!accept) next.pages[url] = { ...before, pending: fp.hash };
  } else {
    console.log(`same     ${label}  ${url}`);
  }
}

await mkdir(dirname(STATE), { recursive: true });
await writeFile(STATE, JSON.stringify(next, null, 2) + "\n");

for (const f of failures) console.log(`FAILED   ${f}`);

if (changes.length) {
  console.log("\nCHANGED:");
  for (const c of changes) console.log(`  - ${c}`);
  console.log(
    accept
      ? "\nbaseline updated"
      : "\nUpdate config/vendors.json, then run `node src/watch.js --accept`"
  );
}

if (changes.length && !accept) process.exit(2);
