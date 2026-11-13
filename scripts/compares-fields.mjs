// Creates the static-table fields on the Compares collection. Skips existing ones.
// Dry run by default; pass --apply to create.
const TOKEN = process.env.WEBFLOW_TOKEN;
const COLLECTION = '6aef0ce9b43f0fc19ff8634c';
const APPLY = process.argv.includes('--apply');
if (!TOKEN) { console.error('WEBFLOW_TOKEN missing'); process.exit(1); }

const METRICS = ['model', 'provider', 'score', 'rank', 'votes', 'context', 'input price', 'output price', 'license'];
const WANT = [...['A', 'B'].flatMap((s) => METRICS.map((m) => `${s} ${m}`)), 'Data date'];

const api = async (path, opts = {}) => {
  const r = await fetch('https://api.webflow.com/v2' + path, {
    ...opts, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status + ' ' + path + ' ' + JSON.stringify(body));
  return body;
};

const col = await api('/collections/' + COLLECTION);
const have = new Set(col.fields.map((f) => f.displayName.trim().toLowerCase()));
const todo = WANT.filter((n) => !have.has(n.toLowerCase()));
console.log('existing fields:', col.fields.length, '| to create:', todo.length);
todo.forEach((n) => console.log('  +', n));

if (!APPLY) { console.log('\nDRY RUN, nothing created. Re-run with --apply.'); process.exit(0); }
for (const name of todo) {
  const f = await api('/collections/' + COLLECTION + '/fields', {
    method: 'POST', body: JSON.stringify({ type: 'PlainText', displayName: name, isRequired: false }) });
  console.log('created:', f.displayName, '->', f.slug);
}
