#!/usr/bin/env node
/**
 * Sync data/latest.json into the Webflow "Model Versions" collection.
 *
 *   node --env-file-if-exists=.env src/webflow-sync.js
 *   node --env-file-if-exists=.env src/webflow-sync.js --dry-run
 *   node --env-file-if-exists=.env src/webflow-sync.js --report sync-report.json
 *
 * --report writes a machine-readable summary of the run (counts plus the
 * per-item detail behind them) for the CI notifier to format. It never
 * changes what goes to stdout.
 *
 * Only PATCHes items that already exist and only touches a fixed set of
 * fields (see FIELD_SLUGS). Never creates, deletes, or writes fields
 * that a human maintains — name, slug, shown-on, is-default,
 * version-label, price-input-manual, price-output-manual are all safe.
 *
 * Also reports, and only reports, when Arena has moved a base model into a
 * vendor's top-N and the CMS has not caught up (SUGGEST). Nothing is created
 * or replaced for it — that stays a human decision, made in Webflow.
 *
 * Exit codes:
 *   0  success (MISS entries are warnings, not errors)
 *   1  API failure, invalid latest.json, or missing token
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canon } from "./match.js";
import { VENDOR_BY_LABEL, pickVendorTop, rankValue } from "./webflow-vendors.js";

const TOKEN = process.env.WEBFLOW_TOKEN;
if (!TOKEN) {
  console.error("set WEBFLOW_TOKEN first (via .env or the environment)");
  process.exit(1);
}

const API = "https://api.webflow.com/v2";
const COLLECTION_ID = "6aa6df5545b8d20c8c2936d2"; // Model Versions
const MODELS_ID = "6a72e32efc969860203df096"; // Models — one item per vendor page

const DRY_RUN = process.argv.includes("--dry-run");

function parseReportFlag(argv) {
  const inline = argv.find((a) => a.startsWith("--report="));
  if (inline) {
    const path = inline.slice("--report=".length);
    if (path) return path;
  } else {
    const i = argv.indexOf("--report");
    if (i === -1) return null;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) return next;
  }
  console.error("--report needs a file path");
  process.exit(1);
}

const REPORT_PATH = parseReportFlag(process.argv);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LATEST = join(ROOT, "data", "latest.json");

const PROVIDER_MAP = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  meta: "Meta",
  deepseek: "DeepSeek",
  mistral: "Mistral AI",
  alibaba: "Alibaba Group",
  microsoft: "Microsoft",
  perplexity: "Perplexity AI, Inc",
};

const FIELD_SLUGS = [
  "arena-score",
  "arena-rank",
  "arena-votes",
  "arena-ci-lower",
  "arena-ci-upper",
  "arena-date-label",
  "score-label",
  "provider",
  "price-input",
  "price-output",
  "price-source",
  "context-window",
  "context-label",
  "released-at",
  "license",
];

// Webflow limits authenticated calls to 60/minute. One request per ~1.1s
// keeps us clear of that ceiling with headroom for the occasional burst.
const RATE_MS = 1100;
let lastCall = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttle() {
  const wait = lastCall + RATE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    await throttle();

    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 0) * 1000;
      const backoff = Math.max(retryAfter, (attempt + 1) * 2000);
      console.warn(`  429 rate limited, retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
      continue;
    }

    if (res.status === 401) throw new Error("401 — token rejected");
    if (res.status === 403)
      throw new Error("403 — token lacks the required scope (needs cms:read, cms:write)");
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new Error(`HTTP ${res.status} on ${method} ${path}: ${detail}`);
    }

    return res.json();
  }
}

async function readSnapshot() {
  let raw;
  try {
    raw = await readFile(LATEST, "utf8");
  } catch (err) {
    throw new Error(`cannot read data/latest.json — ${err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid latest.json — ${err.message}`);
  }
  if (!Array.isArray(doc.models) || doc.models.length === 0) {
    throw new Error("latest.json has no models");
  }
  return doc;
}

// Option fields (like `license`) come back from GET as the option's internal
// hash id, but PATCH accepts either id or name. Fetch the schema once so we
// can PATCH with id and compare id-to-id — otherwise every run would look
// like "d9ded6b7... -> Proprietary" and thrash the field forever.
async function fetchLicenseOptions() {
  const collection = await api("GET", `/collections/${COLLECTION_ID}`);
  const field = collection.fields?.find((f) => f.slug === "license");
  if (!field) {
    console.warn('warn: collection has no "license" field — license sync disabled');
    return null;
  }
  const options = field.validations?.options;
  if (!Array.isArray(options) || options.length === 0) {
    console.warn('warn: "license" field has no options — license sync disabled');
    return null;
  }
  const nameToId = new Map();
  const idToName = new Map();
  for (const opt of options) {
    nameToId.set(opt.name, opt.id);
    idToName.set(opt.id, opt.name);
  }
  return { nameToId, idToName };
}

async function fetchAllItems(collectionId = COLLECTION_ID) {
  const items = [];
  const limit = 100;
  let offset = 0;

  for (;;) {
    const page = await api(
      "GET",
      `/collections/${collectionId}/items?limit=${limit}&offset=${offset}`
    );
    const batch = page.items ?? [];
    items.push(...batch);

    const total = page.pagination?.total;
    offset += batch.length;

    if (batch.length === 0) break;
    if (typeof total === "number" && items.length >= total) break;
  }

  return items;
}

async function patchGroup(group, path, label) {
  if (group.length === 0) return 0;
  const chunkSize = 100;
  let count = 0;
  for (let i = 0; i < group.length; i += chunkSize) {
    const chunk = group.slice(i, i + chunkSize);
    const body = {
      items: chunk.map((m) => ({
        id: m.id,
        fieldData: Object.fromEntries(
          Object.entries(m.changes).map(([slug, { after }]) => [slug, after])
        ),
      })),
    };
    await api("PATCH", path, body);
    count += chunk.length;
    console.log(
      `  ${label} batch ${Math.floor(i / chunkSize) + 1}: ${chunk.length} item(s) patched`
    );
  }
  return count;
}

function mapProvider(org, warnings) {
  if (org == null) return null;
  const key = String(org).toLowerCase();
  if (PROVIDER_MAP[key]) return PROVIDER_MAP[key];
  warnings.push(`unknown organization "${org}" — capitalising as fallback`);
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// Human-readable twin of context-window. The unit is part of the value,
// not a static label in the template: the chip renders as
// "Context window  200K tokens".
function formatContextLabel(tokens) {
  if (tokens == null) return null;
  const n = Number(tokens);
  if (!Number.isFinite(n) || n < 0) return null;

  if (n >= 1_000_000) {
    // One decimal, and no trailing ".0" — JS number formatting drops it
    // for us, so 1e6 -> "1M" and 1.05e6 -> "1.1M".
    const m = Math.round(n / 100_000) / 10;
    return `${m}M tokens`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K tokens`;
  return `${n} tokens`;
}

// One decimal, no trailing ".0": 1497 -> "1497", 1505.5 -> "1505.5",
// 4.75 -> "4.8". Number formatting drops the ".0" for us, which toFixed(1)
// would not.
function oneDecimal(n) {
  return String(Math.round(n * 10) / 10);
}

// "1505.5 ±4.8" — score plus the half-width of its confidence interval.
// Arena's interval is asymmetric, so ± is an approximation for the chip;
// arena-score, arena-ci-lower and arena-ci-upper keep the exact numbers
// for anyone who needs them.
function formatScoreLabel(score, lower, upper) {
  if (score == null) return null;
  const s = Number(score);
  if (!Number.isFinite(s)) return null;

  const lo = Number(lower);
  const hi = Number(upper);
  const haveBounds =
    lower != null &&
    upper != null &&
    Number.isFinite(lo) &&
    Number.isFinite(hi) &&
    hi >= lo;

  if (!haveBounds) return oneDecimal(s);
  return `${oneDecimal(s)} ±${oneDecimal((hi - lo) / 2)}`;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// "2026-09-11" -> "11 Sep 2026". Deliberately string surgery rather than
// Date + toLocaleDateString: the latter depends on the host's ICU locale
// data, and `new Date("2026-09-11")` parses as UTC midnight, so getDate()
// west of Greenwich would report the 10th. CI and a laptop must agree.
function formatArenaDate(value) {
  if (value == null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (!m) return null;

  const [, year, month, day] = m;
  const monthIndex = Number(month) - 1;
  const dayNum = Number(day);
  if (monthIndex < 0 || monthIndex > 11 || dayNum < 1 || dayNum > 31) return null;

  return `${dayNum} ${MONTHS[monthIndex]} ${year}`;
}

function toIso(value) {
  if (value == null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// arenaDateLabel is snapshot-level, not per-model: it is the publish date
// of the whole Arena cut, formatted and validated once by the caller.
function buildFieldData(model, itemName, warnings, licenseOptions, arenaDateLabel) {
  const fd = {};
  const set = (slug, value) => {
    if (value === null || value === undefined) return;
    fd[slug] = value;
  };

  set("arena-score", model.arena_score);
  set("arena-rank", model.arena_rank);
  set("arena-votes", model.arena_votes);
  set("arena-ci-lower", model.categories?.overall?.score_lower);
  set("arena-ci-upper", model.categories?.overall?.score_upper);
  set(
    "score-label",
    formatScoreLabel(
      model.arena_score,
      model.categories?.overall?.score_lower,
      model.categories?.overall?.score_upper
    )
  );
  set("arena-date-label", arenaDateLabel);

  set("provider", mapProvider(model.organization, warnings));

  set("price-input", model.price_input_per_mtok);
  set("price-output", model.price_output_per_mtok);
  set("price-source", model.price_source);

  set("context-window", model.context_length);
  set("context-label", formatContextLabel(model.context_length));
  set("released-at", toIso(model.released_at));

  if (model.license != null && licenseOptions) {
    // Anything that isn't "Proprietary" is treated as "Open-weight": MIT,
    // Apache, Llama Community, Modified MIT and so on all describe open
    // weights and the CMS only offers those two buckets. Log the mapping
    // so it's visible in the diff, but not as an error.
    const target = model.license === "Proprietary" ? "Proprietary" : "Open-weight";
    if (target !== model.license) {
      warnings.push(`"${itemName}" — mapped license "${model.license}" -> "${target}"`);
    }
    const id = licenseOptions.nameToId.get(target);
    if (id) {
      set("license", id);
    } else {
      const allowed = [...licenseOptions.nameToId.keys()].join(", ");
      warnings.push(
        `"${itemName}" — target license "${target}" not in CMS options (${allowed}), skipping license field`
      );
    }
  }

  return fd;
}

function valuesEqual(a, b, slug) {
  if (a === b) return true;
  if (a == null || b == null) return false;

  if (slug === "released-at") {
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    return !Number.isNaN(ta) && !Number.isNaN(tb) && ta === tb;
  }

  if (typeof a === "number" || typeof b === "number") {
    return Number(a) === Number(b);
  }

  return String(a) === String(b);
}

function diffFields(current, next) {
  const changes = {};
  for (const slug of FIELD_SLUGS) {
    if (!(slug in next)) continue; // never null out a field we don't have data for
    const before = current?.[slug];
    const after = next[slug];
    if (!valuesEqual(before, after, slug)) {
      changes[slug] = { before, after };
    }
  }
  return changes;
}

function fmt(v, slug, licenseIdToName) {
  if (v == null) return "—";
  const readable =
    slug === "license" && licenseIdToName?.has(v) ? licenseIdToName.get(v) : String(v);
  return readable.length > 40 ? readable.slice(0, 37) + "..." : readable;
}

// A MISS means a CMS item still points at an Arena name this cut does not
// have. The next question is always "what replaced it", and the answer is
// usually a sibling: same canonical_id, different reasoning mode — e.g.
// claude-fable-5 gone, claude-fable-5-high still listed. Surfacing those
// turns the alert from "something is wrong" into "set this key instead".
const CANDIDATE_LIMIT = 5;

// Snapshots built before pricing was attached have no canonical_id, so
// derive it the same way match.js does rather than reporting nothing.
function canonicalOf(model) {
  return model.canonical_id ?? canon(model.arena_model_name).id;
}

function describeCandidate(model) {
  const mode = model.reasoning_mode ?? "base";
  const rank = model.arena_rank != null ? `rank ${model.arena_rank}` : "unranked";
  return `${model.arena_model_name} (reasoning: ${mode}, ${rank})`;
}

function findCandidates(key, models) {
  const keyCanon = canon(key).id;
  let hits = keyCanon ? models.filter((m) => canonicalOf(m) === keyCanon) : [];

  // Nothing shares the canonical id — an outright rename, or a key the
  // canonicaliser cannot reduce. Fall back to a prefix sweep in both
  // directions, with a floor on the shorter side so a stub of a key cannot
  // drag in a whole family.
  if (hits.length === 0) {
    const needle = String(key).toLowerCase().trim();
    hits = models.filter((m) => {
      const name = String(m.arena_model_name ?? "").toLowerCase();
      if (!name || name === needle) return false;
      if (Math.min(name.length, needle.length) < 6) return false;
      return name.startsWith(needle) || needle.startsWith(name);
    });
  }

  return hits
    .slice()
    .sort((a, b) => (a.arena_rank ?? Infinity) - (b.arena_rank ?? Infinity))
    .slice(0, CANDIDATE_LIMIT)
    .map(describeCandidate);
}

// The sync only ever updates items that already exist, so a model Arena has
// just promoted into a vendor's top-N is invisible to it: the page keeps
// showing the models it already lists, with correct numbers, while a stronger
// one sits outside the CMS. This finds those and says so — nothing here
// creates or replaces anything.
//
// N is the number of items already on the vendor's page, not a constant: the
// seed starts a page at three, a human may have grown it to four, and either
// way the question is "are these the N best this vendor has".
function buildSuggestions(vendorItems, items, models, warnings) {
  const suggestions = [];

  // Rank comes from this cut rather than the CMS field, which is only as
  // fresh as the last successful sync.
  const rankByKey = new Map();
  for (const m of models) {
    if (m.arena_model_name) rankByKey.set(m.arena_model_name, m.arena_rank ?? null);
  }

  for (const vendor of vendorItems) {
    const label = vendor.fieldData?.name;
    if (!label) continue;

    const spec = VENDOR_BY_LABEL.get(label);
    if (!spec) {
      warnings.push(
        `vendor "${label}" in Models has no organization mapping in webflow-vendors.js — top-N check skipped`
      );
      continue;
    }

    const cms = items.filter((it) => {
      const shown = it.fieldData?.["shown-on"];
      return Array.isArray(shown) && shown.includes(vendor.id);
    });
    // An empty page is a seeding job, not a staleness problem.
    if (cms.length === 0) continue;

    // Same selection the seed creates from, price filter included: a model
    // with no price is not something to put on a page, so it is not something
    // to suggest either.
    const top = pickVendorTop(models, spec, { limit: cms.length });
    const topKeys = new Set(top.map((m) => m.arena_model_name));
    const cmsKeys = new Set(
      cms.map((it) => it.fieldData?.["arena-model-name"]).filter(Boolean)
    );

    const add = top
      .filter((m) => !cmsKeys.has(m.arena_model_name))
      .map((m) => ({
        key: m.arena_model_name,
        rank: m.arena_rank ?? null,
        score: m.arena_score ?? null,
      }));
    if (add.length === 0) continue;

    // Everything on the page that the top-N does not contain, worst first.
    // An item whose key is gone from Arena ranks as unknown and therefore
    // sorts first, which is right: it is the most replaceable thing there.
    const replaceCandidates = cms
      .filter((it) => !topKeys.has(it.fieldData?.["arena-model-name"]))
      .map((it) => {
        const key = it.fieldData?.["arena-model-name"] ?? null;
        const rank = rankByKey.has(key)
          ? rankByKey.get(key)
          : (it.fieldData?.["arena-rank"] ?? null);
        return { name: it.fieldData?.name ?? it.id, key, rank };
      })
      .sort((a, b) => rankValue(b.rank) - rankValue(a.rank));

    suggestions.push({ vendor: label, add, replace_candidates: replaceCandidates });
  }

  return suggestions;
}

function formatRank(rank) {
  return rank != null ? `rank ${rank}` : "unranked";
}

function formatAddition(addition) {
  return `${addition.key} (${formatRank(addition.rank)})`;
}

// The weakest page entry is what a new model would displace, so it travels
// with the suggestion — otherwise the reader has to open the CMS to find out
// what is now the weakest thing on the page.
function formatWeakest(replaceCandidates) {
  const weakest = replaceCandidates[0];
  if (!weakest) return "";
  return ` — weakest in CMS: ${weakest.name} (${formatRank(weakest.rank)})`;
}

function countAdditions(suggestions) {
  return suggestions.reduce((n, s) => n + s.add.length, 0);
}

async function writeReport(path, report) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(report, null, 2) + "\n");
  console.log(`report: ${target}`);
}

async function main() {
  console.log(DRY_RUN ? "mode: DRY RUN (no writes)" : "mode: LIVE (will patch CMS)");

  const snapshot = await readSnapshot();
  const bySlug = new Map();
  for (const m of snapshot.models) {
    if (m.arena_model_name) bySlug.set(m.arena_model_name, m);
  }
  console.log(
    `snapshot: ${snapshot.models.length} models, ${bySlug.size} keyed by arena_model_name`
  );

  const licenseOptions = await fetchLicenseOptions();
  const licenseIdToName = licenseOptions?.idToName ?? null;

  const items = await fetchAllItems();
  console.log(`cms:      ${items.length} items in Model Versions`);

  const skipped = [];
  const missed = [];
  const matched = [];
  const warnings = [];

  // The top-N check is the secondary job here. If the Models collection
  // cannot be read, warn and still sync every metric.
  let vendorItems = [];
  try {
    vendorItems = await fetchAllItems(MODELS_ID);
    console.log(`vendors:  ${vendorItems.length} items in Models`);
  } catch (err) {
    warnings.push(
      `cannot read the Models collection (${err.message}) — vendor top-N check skipped`
    );
  }

  // Formatted once, not per item: it is one value for the whole cut, so a
  // bad date is one warning rather than the same line repeated per model.
  const arenaDateLabel = formatArenaDate(snapshot.arena?.published_at);
  if (!arenaDateLabel) {
    warnings.push(
      `WARN: arena.published_at is missing or unparseable (${JSON.stringify(
        snapshot.arena?.published_at ?? null
      )}) — arena-date-label not written`
    );
  }

  for (const item of items) {
    const name = item.fieldData?.name ?? item.id;
    const key = item.fieldData?.["arena-model-name"];

    if (!key || !String(key).trim()) {
      skipped.push({ name, reason: "no arena-model-name set in the CMS" });
      continue;
    }

    const model = bySlug.get(key);
    if (!model) {
      missed.push({ name, key, candidates: findCandidates(key, snapshot.models) });
      continue;
    }

    if (model.reasoning_mode !== null) {
      warnings.push(
        `WARN: "${name}" is bound to a non-base variant (reasoning_mode=${model.reasoning_mode}); site convention is base variants only`
      );
    }

    // /items/live can only patch items that have been published at least
    // once. Treat an item as published only when both signals agree; if
    // they contradict, fall back to the plain /items endpoint since it
    // never 409s on unpublished drafts.
    const isPublished = item.isDraft !== true && Boolean(item.lastPublished);

    const next = buildFieldData(model, name, warnings, licenseOptions, arenaDateLabel);
    const changes = diffFields(item.fieldData, next);
    matched.push({ id: item.id, name, next, changes, isPublished });
  }

  const toUpdate = matched.filter((m) => Object.keys(m.changes).length > 0);
  const unchanged = matched.length - toUpdate.length;

  if (skipped.length) {
    console.log(`\nskipped: no key (${skipped.length})`);
    for (const sk of skipped) console.log(`  - ${sk.name}`);
  }

  if (missed.length) {
    console.log(`\nMISS: cms items whose arena-model-name is not in the snapshot (${missed.length})`);
    for (const m of missed) console.log(`  - ${m.name}  [key: ${m.key}]`);
  }

  const suggestions = buildSuggestions(vendorItems, items, snapshot.models, warnings);

  if (suggestions.length) {
    console.log(
      `\nSUGGEST: newer models in vendor top-N not in CMS (${countAdditions(suggestions)})`
    );
    for (const s of suggestions) {
      for (const addition of s.add) {
        console.log(
          `  ${s.vendor}: + ${formatAddition(addition)}${formatWeakest(s.replace_candidates)}`
        );
      }
    }
  }

  if (warnings.length) {
    console.log("\nwarnings:");
    for (const w of warnings) console.log(`  ${w}`);
  }

  if (toUpdate.length === 0) {
    console.log("\nnothing to update");
  } else {
    console.log(`\nchanges: ${toUpdate.length} item(s)`);
    for (const m of toUpdate) {
      console.log(`  ${m.name}`);
      for (const [slug, { before, after }] of Object.entries(m.changes)) {
        console.log(
          `    ${slug.padEnd(16)} ${fmt(before, slug, licenseIdToName)}  ->  ${fmt(after, slug, licenseIdToName)}`
        );
      }
    }
  }

  let updated = 0;
  if (!DRY_RUN && toUpdate.length > 0) {
    console.log("\npatching…");
    // Route by publish state. Patching a draft via /items doesn't
    // publish it — the item stays a draft until a human hits Publish.
    const liveGroup = toUpdate.filter((m) => m.isPublished);
    const draftGroup = toUpdate.filter((m) => !m.isPublished);

    updated += await patchGroup(liveGroup, `/collections/${COLLECTION_ID}/items/live`, "live");
    updated += await patchGroup(draftGroup, `/collections/${COLLECTION_ID}/items`, "draft");
  }

  const updatedLabel = DRY_RUN ? `${toUpdate.length} (dry)` : String(updated);
  console.log(
    `\nsummary: matched=${matched.length} updated=${updatedLabel} unchanged=${unchanged} skipped=${skipped.length} missed=${missed.length}`
  );

  if (REPORT_PATH) {
    // `updated` counts items actually written, so it stays 0 on a dry run
    // while updated_items lists what would have been written — dry_run is
    // what tells those two cases apart.
    await writeReport(REPORT_PATH, {
      generated_at: new Date().toISOString(),
      dry_run: DRY_RUN,
      matched: matched.length,
      updated,
      unchanged,
      skipped: skipped.length,
      missed: missed.length,
      updated_items: toUpdate.map((m) => ({
        name: m.name,
        fields: Object.keys(m.changes),
      })),
      missed_items: missed,
      skipped_items: skipped,
      suggestions,
    });
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
