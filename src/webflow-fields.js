#!/usr/bin/env node
/**
 * One-off: create the missing vendor-page fields in the Webflow "Models"
 * collection.
 *
 *   node --env-file-if-exists=.env src/webflow-fields.js
 *   node --env-file-if-exists=.env src/webflow-fields.js --dry-run
 *
 * Creates 31 PlainText fields backing four blocks of the vendor page:
 * "What X is best at" (3 cards x 2 fields), "What people build with X"
 * (4 cards x 3 fields), the CTA banner body, the FAQ (5 x question +
 * answer) and the two section titles.
 *
 * Only ever POSTs new fields. Fields that already exist (matched by slug)
 * are skipped, so the script is safe to re-run; nothing existing is ever
 * deleted or modified.
 *
 * Exit codes:
 *   0  success (every field exists afterwards)
 *   1  API failure, missing token, or any field failed to create
 */

const TOKEN = process.env.WEBFLOW_TOKEN;
if (!TOKEN) {
  console.error("set WEBFLOW_TOKEN first (via .env or the environment)");
  process.exit(1);
}

const API = "https://api.webflow.com/v2";
const COLLECTION_ID = "6a72e32efc969860203df096"; // Models

const DRY_RUN = process.argv.includes("--dry-run");

// No icon fields here on purpose. best-N-icon and use-N-icon were removed
// from the collection by hand — the cards no longer carry an icon. Listing
// them would recreate them on the next run, since this script's only
// reconciliation is "create what is missing".
function bestAtFields() {
  const out = [];
  for (const n of [1, 2, 3]) {
    out.push(
      { slug: `best-${n}-title`, displayName: `Best ${n} Title` },
      { slug: `best-${n}-body`, displayName: `Best ${n} Body` }
    );
  }
  return out;
}

function useCaseFields() {
  const out = [];
  for (const n of [1, 2, 3, 4]) {
    out.push(
      { slug: `use-${n}-tag`, displayName: `Use ${n} Tag` },
      { slug: `use-${n}-title`, displayName: `Use ${n} Title` },
      { slug: `use-${n}-body`, displayName: `Use ${n} Body` }
    );
  }
  return out;
}

// Slugs are what Webflow actually generated on the live run: it derives
// the slug from displayName and ignored the faq-N-q / faq-N-a we sent.
function faqFields() {
  const out = [];
  for (const n of [1, 2, 3, 4, 5]) {
    out.push(
      { slug: `faq-${n}-question`, displayName: `FAQ ${n} Question` },
      { slug: `faq-${n}-answer`, displayName: `FAQ ${n} Answer` }
    );
  }
  return out;
}

const FIELDS = [
  ...bestAtFields(),
  ...useCaseFields(),
  { slug: "banner-body", displayName: "Banner Body" },
  ...faqFields(),
  // Created by hand in the CMS. Listed so the script's picture matches the
  // collection; they report as "existing" and are never touched.
  { slug: "gateway-title", displayName: "Gateway title" },
  { slug: "build-title", displayName: "Build title" },
].map((f) => ({ ...f, type: "PlainText", isRequired: false }));

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

async function fetchSchema() {
  const collection = await api("GET", `/collections/${COLLECTION_ID}`);
  return collection.fields ?? [];
}

function pad(v, width) {
  const s = v == null ? "—" : String(v);
  return s.length > width ? s.slice(0, width - 1) + "…" : s.padEnd(width);
}

async function main() {
  console.log(DRY_RUN ? "mode: DRY RUN (no writes)" : "mode: LIVE (will create fields)");
  console.log(`collection: ${COLLECTION_ID} (Models)`);

  const before = await fetchSchema();
  const existingSlugs = new Set(before.map((f) => f.slug));
  console.log(`schema:     ${before.length} field(s) already defined\n`);

  const toCreate = FIELDS.filter((f) => !existingSlugs.has(f.slug));
  const existing = FIELDS.filter((f) => existingSlugs.has(f.slug));

  if (existing.length) {
    console.log(`already present, skipping (${existing.length}):`);
    for (const f of existing) console.log(`  = ${f.slug}`);
    console.log("");
  }

  if (toCreate.length === 0) {
    console.log("nothing to create — every field is already in the collection");
  } else {
    console.log(`${DRY_RUN ? "would create" : "to create"} (${toCreate.length}):`);
    for (const f of toCreate) {
      console.log(`  + ${pad(f.slug, 16)} ${pad(f.type, 10)} "${f.displayName}"`);
    }
    console.log("");
  }

  // requested slug -> id Webflow assigned, so the verification pass can
  // report the slug it actually generated even when it differs from ours.
  const createdIds = new Map();
  const failed = [];

  if (!DRY_RUN && toCreate.length > 0) {
    console.log("creating… (one request per field — there is no bulk fields API)");
    for (const f of toCreate) {
      try {
        const res = await api("POST", `/collections/${COLLECTION_ID}/fields`, {
          isRequired: f.isRequired,
          type: f.type,
          displayName: f.displayName,
          slug: f.slug,
        });
        const id = res.id ?? res.field?.id ?? null;
        const slug = res.slug ?? res.field?.slug ?? "?";
        if (id) createdIds.set(f.slug, id);
        console.log(`  + ${pad(f.slug, 16)} -> ${slug}`);
      } catch (err) {
        failed.push({ slug: f.slug, message: err.message });
        console.error(`  ! ${pad(f.slug, 16)} ${err.message}`);
      }
    }
    console.log("");
  }

  // Control read. Webflow normalises slugs on its own terms, so print what
  // the CMS actually holds rather than what we asked for — the template
  // has to bind against these strings.
  let after = before;
  if (!DRY_RUN && toCreate.length > 0) {
    console.log("re-reading schema…\n");
    after = await fetchSchema();
  }

  const bySlug = new Map(after.map((f) => [f.slug, f]));
  const byId = new Map(after.map((f) => [f.id, f]));

  console.log(`${pad("requested slug", 16)} ${pad("actual slug", 20)} ${pad("type", 10)} status`);
  console.log("-".repeat(62));

  let missing = 0;
  for (const f of FIELDS) {
    const id = createdIds.get(f.slug);
    const live = (id && byId.get(id)) || bySlug.get(f.slug) || null;

    let status;
    if (DRY_RUN) {
      status = live ? "exists" : "would create";
    } else if (failed.some((x) => x.slug === f.slug)) {
      status = "FAILED";
    } else if (!live) {
      status = "MISSING";
      missing++;
    } else if (createdIds.has(f.slug)) {
      status = live.slug === f.slug ? "created" : "created (slug changed)";
    } else {
      status = "existing";
    }

    console.log(
      `${pad(f.slug, 16)} ${pad(live?.slug, 20)} ${pad(live?.type, 10)} ${status}`
    );
  }

  const createdCount = DRY_RUN ? 0 : createdIds.size;
  const createdLabel = DRY_RUN ? `0 (${toCreate.length} dry)` : String(createdCount);
  console.log(
    `\nsummary: created=${createdLabel} existing=${existing.length} failed=${failed.length}`
  );

  if (failed.length) {
    console.log("\nfailures:");
    for (const f of failed) console.log(`  ${f.slug}: ${f.message}`);
  }

  if (failed.length > 0 || missing > 0) {
    throw new Error(
      `${failed.length} field(s) failed to create, ${missing} not present after the control read`
    );
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
