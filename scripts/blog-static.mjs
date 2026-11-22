// Turns the text markers in Blogs articles (==> START TABLE/CODE/BANNER <==) into
// static HTML stored in the CMS, so tables, code and banners are in the page source
// instead of being built in the browser.
// Dry run by default: writes tmp/blog-static/<slug>.html and changes nothing.
//   --apply         write the result back to the CMS
//   --live          also process the published (live) version of each article
//   --report <file> write a JSON summary of what was converted
//   --only <slug>   limit to one article
//   --dump <file>   read articles from a JSON dump instead of the API (dry run only)
//   --templates <file>  read banner templates from a saved /sandbox page
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const TOKEN = process.env.WEBFLOW_TOKEN;
const C_BLOGS = '6a58c12878eab930e2cbcb6e';
const FIELD = 'article';
const SITE = 'https://ai.setapp.com';
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const LIVE = process.argv.includes('--live');
const ONLY = arg('--only');
const DUMP = arg('--dump');
const TEMPLATES = arg('--templates');
const REPORT = arg('--report');
const RETRY_MS = Number(process.env.BLOG_STATIC_RETRY_MS || 3000);

const START = /={2,}>\s*START\s+([A-Z0-9_-]+)\s*<={2,}/i;
const END = /={2,}>\s*END\s+([A-Z0-9_-]+)\s*<={2,}/i;
const PARAM = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*([\s\S]*)$/;
const PARAM_KEYS = ['visual', 'theme', 'frame', 'layout', 'audience'];
const DEFAULTS = { visual: 'dominoes', theme: 'dark', frame: 'none', layout: 'split', audience: 'users' };
const MODIFIERS = { theme: { light: 'is-light' }, frame: { neon: 'is-neon' }, layout: { hero: 'is-hero', wide: 'is-wide' } };
const LINKS = {
  users: 'https://setapp.com/membership/join',
  'ai-plus': 'https://app.setapp.com/ai-plus',
  vendors: 'https://app.setapp.com/ai-vendor-request',
};
// SEO: the "FAQ" label is not a heading, each question under it is an H2 without <strong>.
const FAQ_TITLE = /^(faqs?|frequently asked questions)\s*:?$/i;
// The label is an embed so that CSS can find it and size the questions that follow.
const FAQ_LABEL = (h) => '<div data-rt-embed-type="true"><p class="faq-label">' + h + '</p></div>';
// FAQPage JSON-LD built from the questions and answers of the article, kept as the last block.
const FAQ_SCHEMA = /application\/ld\+json[\s\S]*FAQPage/;
const faqSchema = (faq) => '<div data-rt-embed-type="true"><script type="application/ld+json">' + JSON.stringify({
  '@context': 'https://schema.org', '@type': 'FAQPage',
  mainEntity: faq.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a.join(' ') } })),
}).replace(/</g, '\\u003c') + '</script></div>';
const unbold = (h) => h.replace(/<\/?(?:strong|b)\b[^>]*>/gi, '');
const VOID = new Set(['img', 'br', 'hr', 'input', 'source', 'wbr']);

const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
// Text as a reader sees it. Zero-width joiners are what Webflow puts in empty paragraphs.
const rawText = (html) => decode(html.replace(/<[^>]*>/g, '')).replace(/[‍​﻿]/g, '');
const text = (html) => rawText(html).replace(/ /g, ' ').trim();

// Splits rich text into its top-level blocks (<p>…</p>, <ul>…</ul>, <figure>…</figure>, …).
function splitBlocks(html) {
  const out = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let depth = 0, start = 0, m, tag = null;
  while ((m = re.exec(html))) {
    const name = m[2].toLowerCase();
    if (VOID.has(name) || m[3] === '/') continue;
    if (!m[1]) {
      if (depth === 0) {
        if (m.index > start) out.push({ tag: null, html: html.slice(start, m.index) });
        start = m.index; tag = name;
      }
      depth++;
    } else {
      depth--;
      if (depth === 0) { out.push({ tag, html: html.slice(start, re.lastIndex) }); start = re.lastIndex; }
      if (depth < 0) throw new Error('unbalanced HTML near: ' + html.slice(Math.max(0, m.index - 60), m.index + 40));
    }
  }
  if (depth !== 0) throw new Error('unclosed <' + tag + '> in article');
  if (start < html.length) out.push({ tag: null, html: html.slice(start) });
  return out;
}

const inner = (block) => block.html.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '');
// A marker block is a run of paragraphs; an editor may also have used Shift+Enter inside one.
const linesOf = (block) => (block.tag === 'p' ? inner(block).split(/<br\s*\/?>/i) : [block.html]);

function loadTemplates(page) {
  const map = {};
  const re = /<div\b[^>]*data-block-template="banner"[^>]*>/g;
  let m;
  while ((m = re.exec(page))) {
    const variant = (m[0].match(/data-block-variant="([^"]+)"/) || [])[1] || '';
    const tagRe = /<(\/?)div\b[^>]*>/g;
    tagRe.lastIndex = m.index;
    let depth = 0, t;
    while ((t = tagRe.exec(page))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) { map[variant] = page.slice(m.index, tagRe.lastIndex); break; }
    }
  }
  return map;
}

function buildBanner(lines, templates, warn) {
  const params = { ...DEFAULTS };
  let i = 0;
  for (; i < lines.length; i++) {
    const m = text(lines[i]).match(PARAM);
    if (!m || !PARAM_KEYS.includes(m[1].toLowerCase())) break;
    params[m[1].toLowerCase()] = m[2].trim().toLowerCase();
  }
  const data = { title: '', text: [], label: '', href: '', blank: false };
  for (const line of lines.slice(i)) {
    const t = text(line);
    if (!t) continue;
    if (/^button\s*:/i.test(t)) {
      const a = line.match(/<a\b[^>]*>/i);
      if (a) {
        data.href = decode((a[0].match(/href="([^"]*)"/i) || [])[1] || '');
        data.blank = /target="_blank"/i.test(a[0]);
      }
      data.label = t.replace(/^button\s*:\s*/i, '');
      continue;
    }
    if (!data.title) data.title = t; else data.text.push(t);
  }
  if (!data.title && !data.text.length && !data.label) return null;
  if (!data.href) data.href = LINKS[params.audience] || LINKS.users;

  let tpl = templates[params.visual];
  if (!tpl) { warn('no banner variant "' + params.visual + '", using dominoes'); tpl = templates.dominoes; }
  if (!tpl) throw new Error('banner templates not found on /sandbox');

  let html = tpl.replace(/ data-block-(?:template|variant)="[^"]*"/g, '');
  const classes = Object.keys(MODIFIERS).map((k) => MODIFIERS[k][params[k]]).filter(Boolean);
  html = html.replace(/^<div\b([^>]*?)class="([^"]*)"/, (_, pre, cls) =>
    '<div' + pre + 'class="' + [cls, ...classes].join(' ') + '" data-visual="' + escAttr(params.visual) + '"');
  const fill = (name, value) => {
    const re = new RegExp('<div data-block-field="' + name + '"([^>]*)>[^<]*</div>');
    if (!re.test(html)) throw new Error('banner template has no "' + name + '" field');
    html = html.replace(re, value ? '<div$1>' + value + '</div>' : '');
  };
  fill('title', esc(data.title));
  fill('text', data.text.map(esc).join('<br>'));
  const btn = /<a data-block-field="button"[^>]*?(class="[^"]*")[^>]*>[^<]*<\/a>/;
  if (!btn.test(html)) throw new Error('banner template has no button');
  html = html.replace(btn, (_, cls) => (data.label
    ? '<a href="' + escAttr(data.href) + '"' + (data.blank ? ' target="_blank" rel="noopener"' : '') + ' ' + cls + '>' + esc(data.label) + '</a>'
    : ''));
  return html;
}

function buildTable(lines) {
  const rows = lines
    .map((l) => {
      const cells = l.split('|').map((c) => c.replace(/[‍​]/g, '').replace(/^(?:\s|&nbsp;)+|(?:\s|&nbsp;)+$/g, ''));
      if (cells.length && !text(cells[0])) cells.shift();
      if (cells.length && !text(cells[cells.length - 1])) cells.pop();
      return cells;
    })
    .filter((c) => c.length > 1 && !/^[-:\s]+$/.test(c.map(text).join('')) && c.some((x) => text(x)));
  if (rows.length < 2) return null;
  const head = rows[0];
  const clean = (c) => c.replace(/<\/?strong>/g, '');
  const th = head.map((c) => '<th>' + clean(c) + '</th>').join('');
  const body = rows.slice(1).map((r) => '<tr>' + head.map((h, i) =>
    '<td data-label="' + escAttr(text(h)) + '">' + (r[i] || '') + '</td>').join('') + '</tr>').join('');
  return '<div class="inline-table"><table><thead><tr>' + th + '</tr></thead><tbody>' + body + '</tbody></table></div>';
}

function buildCode(lines) {
  const out = lines.map((l) => rawText(l).replace(/ /g, ' ').replace(/\s+$/, ''));
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  if (!out.length) return null;
  return '<div class="inline-code"><pre><code>' + esc(out.join('\n')) + '</code></pre></div>';
}

function convert(html, templates, warn) {
  const blocks = splitBlocks(html);
  const out = [];
  const stats = { TABLE: 0, CODE: 0, BANNER: 0, FAQ: 0 };
  let inFaq = false;
  const faq = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.tag === 'div' && FAQ_SCHEMA.test(b.html)) continue;
    const t = b.tag === 'h2' || b.tag === 'h3' || b.tag === 'p' ? text(b.html) : '';
    if ((b.tag === 'h2' || b.tag === 'p') && FAQ_TITLE.test(t)) {
      out.push(FAQ_LABEL(unbold(inner(b)))); inFaq = true; stats.FAQ++; continue;
    }
    if (b.tag === 'div' && /class=["']faq-label["']/.test(b.html)) inFaq = true;
    else if (b.tag === 'h2' && !t.endsWith('?')) inFaq = false;
    else if (inFaq && (b.tag === 'h3' || b.tag === 'h2')) {
      const fixed = '<h2>' + unbold(inner(b)) + '</h2>';
      if (fixed !== b.html) stats.FAQ++;
      faq.push({ q: text(fixed), a: [] });
      out.push(fixed); continue;
    }
    if (inFaq && faq.length && (b.tag === 'p' || b.tag === 'ul' || b.tag === 'ol') && !START.test(text(b.html))) {
      const a = text(b.html.replace(/<\/(?:li|p)>|<br\s*\/?>/gi, ' ')).replace(/\s+/g, ' ');
      if (a) faq[faq.length - 1].a.push(a);
    }
    const start = b.tag === 'p' ? text(b.html).match(START) : null;
    if (!start) { out.push(b.html); continue; }
    const type = start[1].toUpperCase();
    let j = i;
    while (j < blocks.length && !END.test(text(blocks[j].html))) j++;
    if (j === blocks.length) { warn('unclosed ' + type + ' block, left as is'); out.push(b.html); continue; }
    // Text sharing a paragraph with a marker (Shift+Enter) is not part of the block:
    // what precedes START stays a paragraph above it, what follows END a paragraph below.
    const all = blocks.slice(i, j + 1).flatMap(linesOf);
    const first = all.findIndex((l) => START.test(text(l)));
    let last = -1;
    all.forEach((l, k) => { if (k > first && END.test(text(l))) last = k; });
    if (last === -1) last = all.length;
    const before = [], after = [];
    all.slice(0, first).forEach((l) => { if (text(l)) before.push(l); });
    all.slice(last + 1).forEach((l) => { if (text(l)) after.push(l); });
    const lines = all.slice(first + 1, last);
    let built = null;
    if (type === 'TABLE') built = buildTable(lines);
    else if (type === 'CODE') built = buildCode(lines);
    else if (type === 'BANNER') built = buildBanner(lines, templates, warn);
    else warn('unknown block type ' + type + ', left as is');
    if (!built) { if (type in stats) warn('empty ' + type + ' block, left as is'); out.push(b.html); continue; }
    if (before.length) out.push('<p>' + before.join('<br>') + '</p>');
    out.push('<div data-rt-embed-type="true">' + built + '</div>');
    if (after.length) out.push('<p>' + after.join('<br>') + '</p>');
    stats[type]++;
    i = j;
  }
  const answered = faq.filter((x) => x.a.length);
  if (answered.length) out.push(faqSchema(answered));
  return { html: out.join(''), stats };
}

// Retries on rate limits, server errors and dropped connections: a failed write between the
// live PATCH and the staged restore below would leave an editor's draft overwritten.
const api = async (path, opts = {}) => {
  for (let attempt = 1; ; attempt++) {
    let failure;
    try {
      const r = await fetch('https://api.webflow.com/v2' + path, {
        ...opts, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } });
      const body = await r.json().catch(() => ({}));
      if (r.ok) return body;
      failure = new Error(r.status + ' ' + path + ' ' + JSON.stringify(body));
      failure.retry = r.status === 429 || r.status >= 500;
    } catch (e) {
      failure = new Error('network error on ' + path + ': ' + e.message);
      failure.retry = true;
    }
    if (!failure.retry || attempt >= 4) throw failure;
    await new Promise((res) => setTimeout(res, RETRY_MS * attempt));
  }
};

if (DUMP && (APPLY || LIVE)) { console.error('--dump is for dry runs of staged content only'); process.exit(1); }
if (!DUMP && !TOKEN) { console.error('WEBFLOW_TOKEN missing'); process.exit(1); }

let page;
if (TEMPLATES) page = readFileSync(TEMPLATES, 'utf8');
else {
  const r = await fetch(SITE + '/sandbox?nc=' + Date.now());
  if (!r.ok) throw new Error('GET /sandbox: HTTP ' + r.status);
  page = await r.text();
}
const templates = loadTemplates(page);
console.log('banner templates:', Object.keys(templates).join(', ') || 'NONE');

mkdirSync('tmp/blog-static', { recursive: true });
const report = { staged: [], live: [], warnings: [] };

// Returns Map(id -> { slug, src, html }) for the given items, logging one line per article.
function run(label, items, quiet) {
  const out = new Map();
  for (const item of items) {
    const slug = item.fieldData.slug;
    if (ONLY && slug !== ONLY) continue;
    const src = item.fieldData[FIELD] || '';
    const warnings = [];
    let html = src, stats = { TABLE: 0, CODE: 0, BANNER: 0, FAQ: 0 };
    // One article that cannot be parsed must not stop the others: it is left as is and reported.
    try { ({ html, stats } = convert(src, templates, (w) => warnings.push(w))); }
    catch (e) { html = src; warnings.push('skipped, ' + e.message); }
    const left = (html.match(/(?:START|END)(?:\s|&nbsp;)+(?:TABLE|CODE|BANNER)/g) || []).length;
    if (left) warnings.push(left + ' marker(s) left');
    if (!quiet) {
      console.log(label.padEnd(6), (html === src ? 'same   ' : 'convert'), slug, '| tables', stats.TABLE, 'code', stats.CODE,
        'banners', stats.BANNER, 'faq', stats.FAQ, warnings.length ? '| WARN: ' + warnings.join('; ') : '');
      warnings.forEach((w) => report.warnings.push(label + ' ' + slug + ': ' + w));
      if (label === 'staged') writeFileSync('tmp/blog-static/' + slug + '.html', html);
    }
    out.set(item.id, { slug, src, html });
  }
  return out;
}

const PAGE = 100;
async function listAll(path) {
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const batch = (await api(path + '?limit=' + PAGE + '&offset=' + offset)).items || [];
    all.push(...batch);
    if (batch.length < PAGE) return all;
  }
}
async function patchAll(path, updates) {
  let n = 0;
  for (let i = 0; i < updates.length; i += PAGE) {
    const res = await api(path, { method: 'PATCH', body: JSON.stringify({ items: updates.slice(i, i + PAGE) }) });
    n += (res.items || []).length;
  }
  return n;
}
const asUpdate = (id, html) => ({ id, fieldData: { [FIELD]: html } });
const stagedPath = '/collections/' + C_BLOGS + '/items';
const livePath = '/collections/' + C_BLOGS + '/items/live';

let staged = run('staged', DUMP
  ? JSON.parse(readFileSync(DUMP, 'utf8')).map((x) => ({ id: x.id, fieldData: { slug: x.slug, [FIELD]: x.article } }))
  : await listAll(stagedPath));
const live = run('live', LIVE ? await listAll(livePath) : []);

const liveIds = [...live].filter(([, v]) => v.html !== v.src).map(([id]) => id);
const stagedOnly = [...staged].filter(([id, v]) => v.html !== v.src && !liveIds.includes(id)).map(([id]) => id);
liveIds.forEach((id) => report.live.push(live.get(id).slug));
[...staged].forEach(([, v]) => { if (v.html !== v.src) report.staged.push(v.slug); });
console.log('\nto update: staged', report.staged.length, LIVE ? '| live ' + liveIds.length : '');

if (!APPLY) {
  console.log('DRY RUN, nothing written. Converted HTML is in tmp/blog-static/.');
} else if (!liveIds.length && !stagedOnly.length) {
  console.log('nothing to update');
} else {
  if (liveIds.length) {
    // Webflow writes a live PATCH into the staged item as well (checked on the API: only the
    // fields sent, single and bulk endpoints alike). An editor's unpublished draft of the
    // article would be replaced by the published text, so the staged text is read again
    // right before the write, kept in a backup file, and put back afterwards.
    staged = run('staged', await listAll(stagedPath), true);
    mkdirSync('tmp/blog-static/backup', { recursive: true });
    for (const id of liveIds) {
      const st = staged.get(id);
      if (st) writeFileSync('tmp/blog-static/backup/' + st.slug + '.staged.html', st.src);
    }
    console.log('patched live:', await patchAll(livePath, liveIds.map((id) => asUpdate(id, live.get(id).html))));
    const restore = liveIds.filter((id) => staged.has(id) && staged.get(id).html !== live.get(id).html);
    if (restore.length) {
      console.log('restored staged drafts:', await patchAll(stagedPath, restore.map((id) => asUpdate(id, staged.get(id).html))),
        '(' + restore.map((id) => staged.get(id).slug).join(', ') + ')');
    }
  }
  if (stagedOnly.length) {
    console.log('patched staged:', await patchAll(stagedPath, stagedOnly.map((id) => asUpdate(id, staged.get(id).html))));
  }
}
if (REPORT) writeFileSync(REPORT, JSON.stringify({ applied: APPLY, ...report }, null, 2));
