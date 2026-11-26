// Fills the SEO text and FAQ fields on Compares from data/compare-content.json.
// Dry run by default.
//   --create-fields  create the missing CMS fields (seo-text, faq-1-q … faq-5-a)
//   --apply          write the staged items
//   --live           write the live items too (a live PATCH also updates the staged item)
//   --only <slug>    one pair only
import { readFileSync } from 'node:fs';

const TOKEN = process.env.WEBFLOW_TOKEN;
if (!TOKEN) { console.error('WEBFLOW_TOKEN is not set'); process.exit(1); }
const COLLECTION = '6aef0ce9b43f0fc19ff8634c'; // Compares
const API = 'https://api.webflow.com/v2';
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const only = has('--only') ? args[args.indexOf('--only') + 1] : null;
const data = JSON.parse(readFileSync(new URL('../data/compare-content.json', import.meta.url), 'utf8'));

const FIELDS = [{ slug: 'seo-text', type: 'RichText' }];
for (let i = 1; i <= 5; i++) FIELDS.push({ slug: `faq-${i}-q`, type: 'PlainText' }, { slug: `faq-${i}-a`, type: 'PlainText' });

async function api(path, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API + path, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  }
}

const collection = await api(`/collections/${COLLECTION}`);
const existing = new Set(collection.fields.map((f) => f.slug));
const missing = FIELDS.filter((f) => !existing.has(f.slug));
if (missing.length) {
  console.log('missing fields:', missing.map((f) => f.slug).join(', '));
  if (!has('--create-fields')) { console.log('Run with --create-fields to create them.'); process.exit(0); }
  for (const f of missing) {
    const made = await api(`/collections/${COLLECTION}/fields`, { method: 'POST', body: JSON.stringify({ type: f.type, displayName: f.slug, isRequired: false }) });
    console.log('created field', made.slug, made.type);
    if (made.slug !== f.slug) { console.error(`field slug is "${made.slug}", expected "${f.slug}"`); process.exit(1); }
  }
} else console.log('fields: all present');

const items = [];
for (let offset = 0; ; offset += 100) {
  const page = await api(`/collections/${COLLECTION}/items?limit=100&offset=${offset}`);
  items.push(...page.items);
  if (page.items.length < 100) break;
}
const bySlug = new Map(items.map((it) => [it.fieldData.slug, it]));

const updates = [];
for (const [slug, entry] of Object.entries(data)) {
  if (only && slug !== only) continue;
  const item = bySlug.get(slug);
  if (!item) { console.log('!! no CMS item for', slug); continue; }
  if (entry.faq.length !== 5) { console.log('!! expected 5 FAQ entries for', slug); continue; }
  const want = { 'seo-text': entry.seo };
  entry.faq.forEach((x, i) => { want[`faq-${i + 1}-q`] = x.q; want[`faq-${i + 1}-a`] = x.a; });
  const changed = Object.keys(want).filter((k) => (item.fieldData[k] || '') !== want[k]);
  console.log(changed.length ? 'update' : 'same  ', slug, changed.length ? `(${changed.length} fields)` : '');
  if (changed.length) updates.push({ id: item.id, fieldData: want });
}

console.log(`\nto update: ${updates.length}`);
if (!updates.length) process.exit(0);
if (!has('--apply')) { console.log('DRY RUN, nothing written.'); process.exit(0); }
const path = has('--live') ? `/collections/${COLLECTION}/items/live` : `/collections/${COLLECTION}/items`;
await api(path, { method: 'PATCH', body: JSON.stringify({ items: updates }) });
console.log(has('--live') ? `patched live: ${updates.length}` : `patched staged: ${updates.length}`);
