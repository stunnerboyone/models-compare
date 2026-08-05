#!/usr/bin/env node
/**
 * Discovers what the Webflow token can see: sites, collections, fields.
 * Read-only — makes no changes.
 *
 *   WEBFLOW_TOKEN=xxx node src/webflow-inspect.js
 *   WEBFLOW_TOKEN=xxx node src/webflow-inspect.js <collection_id>   # field detail
 *
 * Run this before building the sync. The site id and collection ids aren't
 * visible in the Designer, and the sync needs both. Field slugs matter too:
 * Webflow generates them from the display name and they don't always match
 * what you typed.
 */

const TOKEN = process.env.WEBFLOW_TOKEN;
if (!TOKEN) {
  console.error("set WEBFLOW_TOKEN first");
  process.exit(1);
}

const API = "https://api.webflow.com/v2";

async function api(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json" },
  });

  if (res.status === 401) throw new Error("401 — token rejected");
  if (res.status === 403)
    throw new Error("403 — token lacks the required scope (needs cms:read, cms:write)");
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);

  return res.json();
}

const target = process.argv[2] ?? null;

if (target) {
  const c = await api(`/collections/${target}`);
  console.log(`${c.displayName}  (${c.slug})`);
  console.log(`  id: ${c.id}`);
  console.log(`\n  ${"slug".padEnd(26)} ${"type".padEnd(16)} required  name`);
  for (const f of c.fields ?? []) {
    console.log(
      `  ${f.slug.padEnd(26)} ${String(f.type).padEnd(16)} ${f.isRequired ? "yes     " : "no      "}  ${f.displayName}`
    );
  }
  console.log(
    "\nThe sync writes by field slug, not display name — copy these exactly."
  );
} else {
  const { sites } = await api("/sites");
  if (!sites?.length) {
    console.log("token sees no sites — is it a site token for the right workspace?");
    process.exit(1);
  }

  for (const s of sites) {
    console.log(`\nSITE  ${s.displayName}`);
    console.log(`  id:        ${s.id}`);
    console.log(`  domain:    ${s.shortName}.webflow.io`);

    const { collections } = await api(`/sites/${s.id}/collections`);
    if (!collections?.length) {
      console.log("  (no collections yet — create them in the Designer first)");
      continue;
    }

    console.log(`\n  ${"collection".padEnd(28)} ${"slug".padEnd(20)} id`);
    for (const c of collections) {
      console.log(`  ${c.displayName.padEnd(28)} ${c.slug.padEnd(20)} ${c.id}`);
    }
  }

  console.log("\nRun again with a collection id to list its fields.");
}
