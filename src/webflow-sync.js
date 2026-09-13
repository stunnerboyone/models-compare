#!/usr/bin/env node
/**
 * Sync data/latest.json into the Webflow "Model Versions" collection.
 *
 *   node --env-file-if-exists=.env src/webflow-sync.js
 *   node --env-file-if-exists=.env src/webflow-sync.js --dry-run
 *
 * Only PATCHes items that already exist and only touches a fixed set of
 * fields (see FIELD_SLUGS). Never creates, deletes, or writes fields
 * that a human maintains — name, slug, shown-on, is-default,
 * version-label, price-input-manual, price-output-manual are all safe.
 *
 * Exit codes:
 *   0  success (MISS entries are warnings, not errors)
 *   1  API failure, invalid latest.json, or missing token
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = process.env.WEBFLOW_TOKEN;
if (!TOKEN) {
  console.error("set WEBFLOW_TOKEN first (via .env or the environment)");
  process.exit(1);
}

const API = "https://api.webflow.com/v2";
const COLLECTION_ID = "6aa6df5545b8d20c8c2936d2"; // Model Versions

const DRY_RUN = process.argv.includes("--dry-run");

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
  "provider",
  "price-input",
  "price-output",
  "price-source",
  "context-window",
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

async function fetchAllItems() {
  const items = [];
  const limit = 100;
  let offset = 0;

  for (;;) {
    const page = await api(
      "GET",
      `/collections/${COLLECTION_ID}/items?limit=${limit}&offset=${offset}`
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

function toIso(value) {
  if (value == null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function buildFieldData(model, itemName, warnings, licenseOptions) {
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

  set("provider", mapProvider(model.organization, warnings));

  set("price-input", model.price_input_per_mtok);
  set("price-output", model.price_output_per_mtok);
  set("price-source", model.price_source);

  set("context-window", model.context_length);
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

  for (const item of items) {
    const name = item.fieldData?.name ?? item.id;
    const key = item.fieldData?.["arena-model-name"];

    if (!key || !String(key).trim()) {
      skipped.push(name);
      continue;
    }

    const model = bySlug.get(key);
    if (!model) {
      missed.push({ name, key });
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

    const next = buildFieldData(model, name, warnings, licenseOptions);
    const changes = diffFields(item.fieldData, next);
    matched.push({ id: item.id, name, next, changes, isPublished });
  }

  const toUpdate = matched.filter((m) => Object.keys(m.changes).length > 0);
  const unchanged = matched.length - toUpdate.length;

  if (skipped.length) {
    console.log(`\nskipped: no key (${skipped.length})`);
    for (const n of skipped) console.log(`  - ${n}`);
  }

  if (missed.length) {
    console.log(`\nMISS: cms items whose arena-model-name is not in the snapshot (${missed.length})`);
    for (const m of missed) console.log(`  - ${m.name}  [key: ${m.key}]`);
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
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
