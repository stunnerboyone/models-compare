#!/usr/bin/env node
/**
 * Push config/vendor-content.json into the Webflow "Models" collection.
 *
 *   node --env-file-if-exists=.env src/webflow-content.js
 *   node --env-file-if-exists=.env src/webflow-content.js --dry-run
 *
 * Twin of webflow-sync.js, for the vendor-page text fields instead of
 * Model Versions metrics: same api()/throttle, same .env loading, same
 * draft-vs-live PATCH split.
 *
 * config/vendor-content.json shape:
 *   { "<vendor slug>": { "<field slug>": "<value>", ... }, ... }
 * The top-level key is the item's `slug` in Models (chatgpt, claude, ...).
 *
 * Only PATCHes fields that are present in the file, and only when the
 * value actually differs from what's live. Fields the file doesn't
 * mention are left completely alone. Never creates or deletes items, and
 * never touches name, slug, provider, logo or sort-order even if asked.
 *
 * Validation runs before any write, dry-run included:
 *   - every vendor slug in the file must exist in the CMS
 *   - every field slug in the file must exist in the collection schema
 *   - the file must not touch a protected field
 * Any violation prints the offending list and exits 1 rather than
 * silently skipping a vendor or field.
 *
 * Exit codes:
 *   0  success
 *   1  API failure, invalid input file, missing token, or validation failure
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
const COLLECTION_ID = "6a72e32efc969860203df096"; // Models

const DRY_RUN = process.argv.includes("--dry-run");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_PATH = join(ROOT, "config", "vendor-content.json");

// Human-maintained fields. Never written, even if a caller's content file
// asks for one — those are edited by hand in the CMS, not from a snapshot.
const PROTECTED_FIELDS = new Set(["name", "slug", "provider", "logo", "sort-order"]);

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

async function readContent() {
  let raw;
  try {
    raw = await readFile(CONTENT_PATH, "utf8");
  } catch (err) {
    throw new Error(`cannot read config/vendor-content.json — ${err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid vendor-content.json — ${err.message}`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("vendor-content.json must be an object of { vendorSlug: { fieldSlug: value } }");
  }
  for (const [vendor, fields] of Object.entries(doc)) {
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
      throw new Error(`vendor-content.json: "${vendor}" must map to an object of field slugs`);
    }
  }
  return doc;
}

async function fetchSchemaFieldSlugs() {
  const collection = await api("GET", `/collections/${COLLECTION_ID}`);
  const fields = collection.fields ?? [];
  return new Set(fields.map((f) => f.slug));
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

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function diffFields(current, next) {
  const changes = {};
  for (const [slug, after] of Object.entries(next)) {
    const before = current?.[slug];
    if (!valuesEqual(before, after)) {
      changes[slug] = { before, after };
    }
  }
  return changes;
}

function fmt(v) {
  if (v == null) return "—";
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
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

async function main() {
  console.log(DRY_RUN ? "mode: DRY RUN (no writes)" : "mode: LIVE (will patch CMS)");

  const content = await readContent();
  const vendorSlugs = Object.keys(content);
  console.log(`content:  ${vendorSlugs.length} vendor(s) in vendor-content.json`);

  // --- validation, before any write ---

  const usedFieldSlugs = new Set();
  for (const fields of Object.values(content)) {
    for (const slug of Object.keys(fields)) usedFieldSlugs.add(slug);
  }

  const protectedUsed = [...usedFieldSlugs].filter((s) => PROTECTED_FIELDS.has(s));
  if (protectedUsed.length > 0) {
    console.error(`error: vendor-content.json touches protected field(s): ${protectedUsed.join(", ")}`);
    console.error("       name, slug, provider, logo, sort-order are human-maintained and never patched here");
    process.exit(1);
  }

  const schemaFieldSlugs = await fetchSchemaFieldSlugs();
  const unknownFields = [...usedFieldSlugs].filter((s) => !schemaFieldSlugs.has(s));
  if (unknownFields.length > 0) {
    console.error(`error: vendor-content.json references field(s) not in the Models schema: ${unknownFields.join(", ")}`);
    process.exit(1);
  }

  const items = await fetchAllItems();
  console.log(`cms:      ${items.length} items in Models`);

  const bySlug = new Map();
  for (const item of items) {
    const slug = item.fieldData?.slug;
    if (slug) bySlug.set(slug, item);
  }

  const missingVendors = vendorSlugs.filter((v) => !bySlug.has(v));
  if (missingVendors.length > 0) {
    console.error(`error: vendor slug(s) not found in Models: ${missingVendors.join(", ")}`);
    process.exit(1);
  }

  // --- match + diff ---

  const matched = vendorSlugs.map((vendor) => {
    const item = bySlug.get(vendor);
    const next = content[vendor];
    const changes = diffFields(item.fieldData, next);
    const isPublished = item.isDraft !== true && Boolean(item.lastPublished);
    return { vendor, id: item.id, changes, isPublished };
  });

  const toUpdate = matched.filter((m) => Object.keys(m.changes).length > 0);
  const unchanged = matched.length - toUpdate.length;

  if (toUpdate.length === 0) {
    console.log("\nnothing to update");
  } else {
    console.log(`\nchanges: ${toUpdate.length} vendor(s)`);
    for (const m of toUpdate) {
      console.log(`  ${m.vendor}`);
      for (const [slug, { before, after }] of Object.entries(m.changes)) {
        console.log(`    ${slug.padEnd(16)} ${fmt(before)}  ->  ${fmt(after)}`);
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
    `\nsummary: matched=${matched.length} updated=${updatedLabel} unchanged=${unchanged} missing=${missingVendors.length}`
  );
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
