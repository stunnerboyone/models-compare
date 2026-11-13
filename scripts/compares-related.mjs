// Fills Related (multi-ref) and Matchups subtitle on the Compares collection.
// Dry run by default; pass --apply to write to the live items.
const TOKEN = process.env.WEBFLOW_TOKEN;
const COLLECTION = '6aef0ce9b43f0fc19ff8634c';
const APPLY = process.argv.includes('--apply');
if (!TOKEN) { console.error('WEBFLOW_TOKEN missing'); process.exit(1); }

const ORDER = ['ChatGPT vs Claude','ChatGPT vs Gemini','ChatGPT vs Grok','ChatGPT vs DeepSeek','ChatGPT vs Copilot',
  'Claude vs Gemini','Claude vs Grok','Claude vs DeepSeek','Claude vs Copilot','Gemini vs Grok','Gemini vs DeepSeek',
  'Gemini vs Copilot','Grok vs DeepSeek','Grok vs Copilot','DeepSeek vs Copilot'];

const api = async (path, opts = {}) => {
  const r = await fetch('https://api.webflow.com/v2' + path, {
    ...opts, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status + ' ' + path + ' ' + JSON.stringify(body));
  return body;
};

const col = await api('/collections/' + COLLECTION);
const field = (name) => {
  const f = col.fields.find((x) => x.displayName.trim().toLowerCase() === name.toLowerCase());
  if (!f) throw new Error('field not found: ' + name + ' (have: ' + col.fields.map((x) => x.displayName).join(', ') + ')');
  return f;
};
const fRelated = field('Related'), fSub = field('Matchups subtitle');
console.log('fields:', fRelated.slug, '(' + fRelated.type + ')', '|', fSub.slug, '(' + fSub.type + ')');

const { items } = await api('/collections/' + COLLECTION + '/items?limit=100');
const byName = new Map(items.map((i) => [i.fieldData.name.trim(), i]));
const missing = ORDER.filter((n) => !byName.has(n));
if (missing.length) throw new Error('items not found in CMS: ' + missing.join(', '));
console.log('items:', items.length);

const vendors = (n) => n.split(/\s+vs\s+/i).map((s) => s.trim());
const updates = ORDER.map((name) => {
  const [a, b] = vendors(name);
  const others = ORDER.filter((n) => n !== name);
  const withA = others.filter((n) => vendors(n).includes(a)).slice(0, 2);
  const withB = others.filter((n) => vendors(n).includes(b) && !withA.includes(n)).slice(0, 2);
  const related = [...withA, ...withB];
  const item = byName.get(name);
  console.log(name.padEnd(22), '->', related.join(' | '));
  return { id: item.id, fieldData: {
    [fRelated.slug]: related.map((n) => byName.get(n).id),
    [fSub.slug]: `Other comparisons involving ${a} and ${b} — same benchmarks, different pairs.`,
  } };
});

if (!APPLY) { console.log('\nDRY RUN, nothing written. Re-run with --apply.'); process.exit(0); }
await api('/collections/' + COLLECTION + '/items', { method: 'PATCH', body: JSON.stringify({ items: updates }) });
console.log('patched staged');
const res = await api('/collections/' + COLLECTION + '/items/live', { method: 'PATCH', body: JSON.stringify({ items: updates }) });
console.log('\npatched live:', (res.items || []).length, 'item(s)');
