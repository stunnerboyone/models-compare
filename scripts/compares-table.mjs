// Fills the static comparison-table fields on Compares from Models + Model Versions.
// Dry run by default; pass --apply to write staged + live.
const TOKEN = process.env.WEBFLOW_TOKEN;
const C_COMPARES = '6aef0ce9b43f0fc19ff8634c';
const C_MODELS = '6a72e32efc969860203df096';
const C_VERSIONS = '6aa6df5545b8d20c8c2936d2';
const APPLY = process.argv.includes('--apply');
if (!TOKEN) { console.error('WEBFLOW_TOKEN missing'); process.exit(1); }

const api = async (path, opts = {}) => {
  const r = await fetch('https://api.webflow.com/v2' + path, {
    ...opts, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status + ' ' + path + ' ' + JSON.stringify(body));
  return body;
};
const schema = async (id) => (await api('/collections/' + id)).fields;
const items = async (id) => (await api('/collections/' + id + '/items?limit=100')).items;
const finder = (fields, label) => (name) => {
  const f = fields.find((x) => x.displayName.trim().toLowerCase() === name.toLowerCase());
  if (!f) throw new Error(label + ': field not found: ' + name + ' (have: ' + fields.map((x) => x.displayName).join(', ') + ')');
  return f;
};

const [fC, fM, fV] = await Promise.all([schema(C_COMPARES), schema(C_MODELS), schema(C_VERSIONS)]);
const [iC, iM, iV] = await Promise.all([items(C_COMPARES), items(C_MODELS), items(C_VERSIONS)]);
const c = finder(fC, 'Compares'), v = finder(fV, 'Model Versions');

const S = {
  modelA: c('Model A').slug, modelB: c('Model B').slug,
  shownOn: v('Shown on').slug, isDefault: v('Is default').slug, provider: v('Provider').slug,
  score: v('Arena score').slug, rank: v('Arena rank').slug, votes: v('Arena votes').slug,
  ctx: v('Context label').slug, pin: v('Price input').slug, pout: v('Price output').slug,
  pinM: v('Price input manual').slug, poutM: v('Price output manual').slug,
  date: v('Arena date label').slug,
};
const licField = v('License');
const licOptions = new Map((licField.validations?.options || []).map((o) => [o.id, o.name]));
const license = (val) => (licOptions.size ? licOptions.get(val) : val) || '';

const vendorName = new Map(iM.map((m) => [m.id, m.fieldData.name]));
const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));
const rankOf = (x) => num(x.fieldData[S.rank]) ?? 1e9;

function pick(vendorId, avoidId) {
  const list = iV.filter((x) => (x.fieldData[S.shownOn] || []).includes(vendorId) && x.id !== avoidId)
    .sort((a, b) => rankOf(a) - rankOf(b));
  return list.find((x) => x.fieldData[S.isDefault]) || list[0] || null;
}
const money = (n) => (n == null ? '—' : '$' + n.toFixed(2) + ' / 1M');
function fmt(x) {
  const d = x.fieldData;
  const score = num(d[S.score]), rank = num(d[S.rank]), votes = num(d[S.votes]);
  return {
    model: d.name, provider: d[S.provider] || '',
    score: score == null ? '—' : score.toLocaleString('en-US', { maximumFractionDigits: 1 }),
    rank: rank == null ? '—' : '#' + rank,
    votes: votes == null ? '—' : votes.toLocaleString('en-US'),
    context: d[S.ctx] || '—',
    'input price': money(num(d[S.pinM]) ?? num(d[S.pin])),
    'output price': money(num(d[S.poutM]) ?? num(d[S.pout])),
    license: license(d[licField.slug]) || '—',
    date: d[S.date] || '',
  };
}

const updates = [];
for (const item of iC) {
  const d = item.fieldData;
  const a = pick(d[S.modelA]);
  const b = pick(d[S.modelB], a && a.id);
  if (!a || !b) { console.log('SKIP', d.name, '- no model for', !a ? vendorName.get(d[S.modelA]) : vendorName.get(d[S.modelB])); continue; }
  const A = fmt(a), B = fmt(b);
  const fieldData = { [c('Data date').slug]: A.date || B.date };
  for (const [side, M] of [['A', A], ['B', B]]) {
    for (const k of ['model', 'provider', 'score', 'rank', 'votes', 'context', 'input price', 'output price', 'license']) {
      fieldData[c(`${side} ${k}`).slug] = M[k];
    }
  }
  console.log(d.name.padEnd(20), '|', `${A.model} ${A.score} ${A.rank} ${A['input price']}`, '||', `${B.model} ${B.score} ${B.rank} ${B['input price']}`, '|', fieldData[c('Data date').slug]);
  updates.push({ id: item.id, fieldData });
}

console.log('\nitems to update:', updates.length, 'of', iC.length);
if (!APPLY) { console.log('DRY RUN, nothing written. Re-run with --apply.'); process.exit(0); }
await api('/collections/' + C_COMPARES + '/items', { method: 'PATCH', body: JSON.stringify({ items: updates }) });
console.log('patched staged');
const res = await api('/collections/' + C_COMPARES + '/items/live', { method: 'PATCH', body: JSON.stringify({ items: updates }) });
console.log('patched live:', (res.items || []).length, 'item(s)');
