#!/usr/bin/env node
/**
 * One-shot: seed Webflow "Model Versions" with draft items for each
 * vendor's top 3 base models pulled from data/latest.json, and flag
 * whether each one is reachable through the MacPaw AI gateway.
 *
 *   node --env-file-if-exists=.env src/webflow-seed.js
 *   node --env-file-if-exists=.env src/webflow-seed.js --dry-run
 *
 * Writes identity fields only — name, slug, arena-model-name,
 * version-label, shown-on, is-default, available-in-setapp. Metrics
 * (score, rank, votes, CI, prices, license, released-at, context-window)
 * are left blank and get filled by webflow-sync.js on the next run.
 *
 * Selection is driven by Arena rank alone; gateway availability is a
 * label, not a filter. The page shows each vendor's strongest models
 * even if Setapp doesn't carry them all today.
 *
 * Idempotent. A re-run creates nothing and only appends missing vendor
 * ids to shown-on (Copilot/ChatGPT overlap). Existing items are never
 * overwritten — not shown-on values already present, not is-default,
 * not available-in-setapp.
 *
 * Exit codes:
 *   0  success
 *   1  API failure, invalid latest.json, or missing token
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchGatewayChatModels } from "./sources/gateway.js";

const TOKEN = process.env.WEBFLOW_TOKEN;
if (!TOKEN) {
  console.error("set WEBFLOW_TOKEN first (via .env or the environment)");
  process.exit(1);
}

const API = "https://api.webflow.com/v2";
const MODEL_VERSIONS_ID = "6aa6df5545b8d20c8c2936d2";
const MODELS_ID = "6a72e32efc969860203df096";

const DRY_RUN = process.argv.includes("--dry-run");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LATEST = join(ROOT, "data", "latest.json");

// Vendor label (the item's name in the Models CMS) -> Arena organization.
// namePrefix is an optional escape hatch: Arena bundles some non-Llama
// models under organization "meta" (muse-spark-*), so Llama explicitly
// restricts to arena_model_name starting with "llama". Add the field to
// any other vendor that ends up in the same situation.
const VENDORS = [
  { label: "ChatGPT",    org: "openai" },
  { label: "Claude",     org: "anthropic" },
  { label: "Gemini",     org: "google" },
  { label: "DeepSeek",   org: "deepseek" },
  { label: "Grok",       org: "xai" },
  { label: "Llama",      org: "meta", namePrefix: "llama" },
  { label: "Mistral",    org: "mistral" },
  { label: "Qwen",       org: "alibaba" },
  { label: "Copilot",    org: "openai" },
  { label: "Perplexity", org: "perplexity" },
];

const BRAND_MAP = {
  gpt: "GPT",
  glm: "GLM",
  qwen: "Qwen",
  llama: "Llama",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  gemini: "Gemini",
  grok: "Grok",
  claude: "Claude",
  o3: "o3",
  o4: "o4",
};

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

async function fetchAll(collectionId) {
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

function capToken(t) {
  const lower = t.toLowerCase();
  if (BRAND_MAP[lower]) return BRAND_MAP[lower];
  if (/^v\d/i.test(t)) return "V" + t.slice(1);
  if (/^\d/.test(t)) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * "claude-opus-4-6" -> "Claude Opus 4.6"
 * "gpt-5.5"         -> "GPT-5.5"
 * "grok-4-6"        -> "Grok 4.6"
 * "deepseek-v4"     -> "DeepSeek V4"
 */
function humanName(arenaName) {
  const raw = arenaName.split("-").filter(Boolean);
  if (raw.length === 0) return arenaName;

  const parts = [];
  let i = 0;
  while (i < raw.length) {
    if (i > 0 && /^\d+(\.\d+)*$/.test(raw[i])) {
      const nums = [];
      while (i < raw.length && /^\d+(\.\d+)*$/.test(raw[i])) {
        nums.push(raw[i]);
        i++;
      }
      parts.push(nums.join("."));
    } else {
      parts.push(raw[i]);
      i++;
    }
  }

  const brandLower = parts[0].toLowerCase();
  const brand = BRAND_MAP[brandLower] ?? capToken(parts[0]);
  const rest = parts.slice(1).map(capToken);
  if (rest.length === 0) return brand;

  // GPT keeps a hyphen ("GPT-5.5"); the rest use spaces ("Claude Opus 4.6").
  const sep = brandLower === "gpt" ? "-" : " ";
  return brand + sep + rest.join(" ");
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Strip a trailing date suffix — "-YYYY-MM-DD" or "-YYYYMMDD".
 * Everything else is left alone. This is deliberately conservative:
 * naive fuzzy matching collapsed "gpt-4o", "gpt-4o-2024-08-06" and
 * "gpt-4o-2024-11-20" onto each other, which cross-wired scores.
 */
function canonicalize(name) {
  return name.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
}

function pickTop3(models, { org, namePrefix }) {
  let list = models
    .filter((m) => m.organization === org)
    .filter((m) => m.reasoning_mode === null)
    .filter((m) => m.price_input_per_mtok != null);
  if (namePrefix) {
    list = list.filter((m) => m.arena_model_name?.startsWith(namePrefix));
  }
  return list
    .sort((a, b) => (a.arena_rank ?? Infinity) - (b.arena_rank ?? Infinity))
    .slice(0, 3);
}

function buildMatcher(gatewayKeys, snapshotModels) {
  if (!gatewayKeys) return null;

  const arenaByCanon = new Map();
  for (const m of snapshotModels) {
    const name = m.arena_model_name;
    if (!name) continue;
    const c = canonicalize(name);
    if (!arenaByCanon.has(c)) arenaByCanon.set(c, []);
    arenaByCanon.get(c).push(name);
  }

  const gwByCanon = new Map();
  for (const k of gatewayKeys) {
    const c = canonicalize(k);
    if (!gwByCanon.has(c)) gwByCanon.set(c, []);
    gwByCanon.get(c).push(k);
  }

  return { gatewayKeys, arenaByCanon, gwByCanon };
}

/**
 * true   found in gateway (exact or unique date-stripped match)
 * false  gateway answered but this model is not there
 * null   gateway unavailable — do not touch the field
 */
function checkAvailability(matcher, arenaName, warnings) {
  if (!matcher) return null;
  if (matcher.gatewayKeys.has(arenaName)) return true;

  const c = canonicalize(arenaName);
  const gwMatches = matcher.gwByCanon.get(c) ?? [];
  if (gwMatches.length === 0) return false;

  const arenaMatches = matcher.arenaByCanon.get(c) ?? [];
  if (arenaMatches.length === 1) return true;

  warnings.push(
    `ambiguous gateway match for "${arenaName}": multiple Arena models canonicalize to "${c}" — ${arenaMatches.join(", ")}; treating as not available`
  );
  return false;
}

function availabilityTag(availability) {
  if (availability === true) return " [in setapp]";
  if (availability === false) return " [not in setapp]";
  return " [unknown]";
}

async function main() {
  console.log(DRY_RUN ? "mode: DRY RUN (no writes)" : "mode: LIVE (will create drafts)");

  const snapshot = await readSnapshot();
  console.log(`snapshot: ${snapshot.models.length} models`);

  const warnings = [];

  let gatewayKeys = null;
  try {
    gatewayKeys = await fetchGatewayChatModels();
    console.log(`gateway:  ${gatewayKeys.size} chat models`);
  } catch (err) {
    warnings.push(`gateway unavailable: ${err.message} — availability will be left unset`);
    console.log(`gateway:  unavailable (${err.message})`);
  }
  const matcher = buildMatcher(gatewayKeys, snapshot.models);

  const vendorItems = await fetchAll(MODELS_ID);
  const vendorIdByLabel = new Map();
  for (const v of vendorItems) {
    const name = v.fieldData?.name;
    if (name) vendorIdByLabel.set(name, v.id);
  }
  console.log(`vendors:  ${vendorIdByLabel.size} in Models`);

  const existingItems = await fetchAll(MODEL_VERSIONS_ID);
  const existingByKey = new Map();
  for (const it of existingItems) {
    const key = it.fieldData?.["arena-model-name"];
    if (key) existingByKey.set(key, it);
  }
  console.log(`cms:      ${existingItems.length} items in Model Versions`);

  // Resolve every vendor once so we don't run pickTop3 twice or reprint
  // the "vendor not found" warning from two code paths.
  const selections = [];
  for (const vendor of VENDORS) {
    const vendorId = vendorIdByLabel.get(vendor.label);
    if (!vendorId) {
      warnings.push(`vendor "${vendor.label}" not found in Models collection — skipping`);
      continue;
    }
    const top = pickTop3(snapshot.models, vendor);
    if (top.length < 3) {
      warnings.push(
        `vendor "${vendor.label}" (${vendor.org}): only ${top.length} base model(s) with price after filtering`
      );
    }
    selections.push({ ...vendor, vendorId, top });
  }

  /**
   * arena_model_name -> { model, vendorIds:Set<string>, isDefault, availability }
   * Deduplicates aliases: one CMS item per arena_model_name, with a
   * union of vendor ids for the ChatGPT/Copilot case.
   */
  const plan = new Map();
  for (const { vendorId, top } of selections) {
    top.forEach((m, i) => {
      const key = m.arena_model_name;
      let entry = plan.get(key);
      if (!entry) {
        entry = {
          model: m,
          vendorIds: new Set(),
          isDefault: false,
          availability: checkAvailability(matcher, key, warnings),
        };
        plan.set(key, entry);
      }
      entry.vendorIds.add(vendorId);
      if (i === 0) entry.isDefault = true;
    });
  }

  const creates = [];
  const links = [];
  let existingUntouched = 0;

  for (const [key, entry] of plan) {
    const existing = existingByKey.get(key);
    if (existing) {
      const current = Array.isArray(existing.fieldData?.["shown-on"])
        ? existing.fieldData["shown-on"]
        : [];
      const missing = [...entry.vendorIds].filter((id) => !current.includes(id));
      if (missing.length === 0) {
        existingUntouched++;
      } else {
        links.push({
          id: existing.id,
          name: existing.fieldData?.name ?? key,
          currentShownOn: current,
          addVendorIds: missing,
        });
      }
    } else {
      const name = humanName(key);
      const fieldData = {
        name,
        slug: slugify(name),
        "arena-model-name": key,
        "version-label": name,
        "shown-on": [...entry.vendorIds],
        "is-default": entry.isDefault,
      };
      if (entry.availability !== null) {
        fieldData["available-in-setapp"] = entry.availability;
      }
      creates.push({ arena: key, availability: entry.availability, fieldData });
    }
  }

  console.log("\nvendor selections:");
  for (const { label, org, top } of selections) {
    console.log(`  ${label} (${org}): ${top.length} model(s)`);
    top.forEach((m, i) => {
      const entry = plan.get(m.arena_model_name);
      const tag = availabilityTag(entry?.availability ?? null);
      console.log(
        `    #${i + 1}  rank=${m.arena_rank}  score=${m.arena_score}  ${m.arena_model_name} -> ${humanName(m.arena_model_name)}${tag}`
      );
    });
  }

  if (warnings.length) {
    console.log("\nwarnings:");
    for (const w of warnings) console.log(`  WARN: ${w}`);
  }

  console.log(
    `\nplan: create=${creates.length}  link=${links.length}  existing=${existingUntouched}`
  );

  if (creates.length) {
    console.log("\ncreate:");
    for (const c of creates) {
      const isDef = c.fieldData["is-default"] ? " [default]" : "";
      const vendors = c.fieldData["shown-on"].length;
      const tag = availabilityTag(c.availability);
      console.log(
        `  + ${c.fieldData.name.padEnd(28)} (${c.arena})  shown-on:${vendors}${isDef}${tag}`
      );
    }
  }

  if (links.length) {
    console.log("\nlink (append to shown-on):");
    for (const l of links) {
      console.log(`  ~ ${l.name.padEnd(28)} +${l.addVendorIds.length} vendor(s)`);
    }
  }

  let created = 0;
  let linked = 0;

  if (!DRY_RUN) {
    if (creates.length) {
      console.log("\ncreating drafts…");
      const chunkSize = 100;
      for (let i = 0; i < creates.length; i += chunkSize) {
        const chunk = creates.slice(i, i + chunkSize);
        const body = {
          items: chunk.map((c) => ({ isDraft: true, fieldData: c.fieldData })),
        };
        await api("POST", `/collections/${MODEL_VERSIONS_ID}/items`, body);
        created += chunk.length;
        console.log(`  batch ${Math.floor(i / chunkSize) + 1}: ${chunk.length} draft(s) created`);
      }
    }

    if (links.length) {
      console.log("\nlinking…");
      const chunkSize = 100;
      for (let i = 0; i < links.length; i += chunkSize) {
        const chunk = links.slice(i, i + chunkSize);
        const body = {
          items: chunk.map((l) => ({
            id: l.id,
            fieldData: {
              "shown-on": [...new Set([...l.currentShownOn, ...l.addVendorIds])],
            },
          })),
        };
        await api("PATCH", `/collections/${MODEL_VERSIONS_ID}/items`, body);
        linked += chunk.length;
        console.log(`  batch ${Math.floor(i / chunkSize) + 1}: ${chunk.length} item(s) linked`);
      }
    }
  }

  const createdLabel = DRY_RUN ? `${creates.length} (dry)` : String(created);
  const linkedLabel = DRY_RUN ? `${links.length} (dry)` : String(linked);
  console.log(
    `\nsummary: created=${createdLabel} linked=${linkedLabel} existing=${existingUntouched} warnings=${warnings.length}`
  );
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
