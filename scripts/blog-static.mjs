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
  const stats = { TABLE: 0, CODE: 0, BANNER: 0 };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
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
  return { html: out.join(''), stats };
}

const api = async (path, opts = {}) => {
  const r = await fetch('https://api.webflow.com/v2' + path, {
    ...opts, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status + ' ' + path + ' ' + JSON.stringify(body));
  return body;
};

if (DUMP && (APPLY || LIVE)) { console.error('--dump is for dry runs of staged content only'); process.exit(1); }
if (!DUMP && !TOKEN) { console.error('WEBFLOW_TOKEN missing'); process.exit(1); }

const page = TEMPLATES ? readFileSync(TEMPLATES, 'utf8') : await (await fetch(SITE + '/sandbox?nc=' + Date.now())).text();
const templates = loadTemplates(page);
console.log('banner templates:', Object.keys(templates).join(', ') || 'NONE');

mkdirSync('tmp/blog-static', { recursive: true });
const report = { staged: [], live: [], warnings: [] };

// Staged and live are converted separately, each from its own content, so an editor's
// unpublished changes are never pushed to the site by this script.
function run(label, items) {
  const updates = [];
  for (const item of items) {
    const slug = item.fieldData.slug;
    if (ONLY && slug !== ONLY) continue;
    const src = item.fieldData[FIELD] || '';
    const warnings = [];
    const { html, stats } = convert(src, templates, (w) => warnings.push(w));
    const left = (html.match(/(?:START|END)(?:\s|&nbsp;)+(?:TABLE|CODE|BANNER)/g) || []).length;
    if (left) warnings.push(left + ' marker(s) left');
    console.log(label.padEnd(6), (html === src ? 'same   ' : 'convert'), slug, '| tables', stats.TABLE, 'code', stats.CODE,
      'banners', stats.BANNER, warnings.length ? '| WARN: ' + warnings.join('; ') : '');
    warnings.forEach((w) => report.warnings.push(label + ' ' + slug + ': ' + w));
    if (label === 'staged') writeFileSync('tmp/blog-static/' + slug + '.html', html);
    if (html !== src) { updates.push({ id: item.id, fieldData: { [FIELD]: html } }); report[label].push(slug); }
  }
  return updates;
}

const stagedItems = DUMP
  ? JSON.parse(readFileSync(DUMP, 'utf8')).map((x) => ({ id: x.id, fieldData: { slug: x.slug, [FIELD]: x.article } }))
  : (await api('/collections/' + C_BLOGS + '/items?limit=100')).items;
const liveItems = LIVE ? (await api('/collections/' + C_BLOGS + '/items/live?limit=100')).items : [];

const stagedUpdates = run('staged', stagedItems);
const liveUpdates = run('live', liveItems);
console.log('\nto update: staged', stagedUpdates.length, LIVE ? '| live ' + liveUpdates.length : '');

if (!APPLY) {
  console.log('DRY RUN, nothing written. Converted HTML is in tmp/blog-static/.');
} else {
  if (stagedUpdates.length) {
    await api('/collections/' + C_BLOGS + '/items', { method: 'PATCH', body: JSON.stringify({ items: stagedUpdates }) });
    console.log('patched staged:', stagedUpdates.length);
  }
  if (liveUpdates.length) {
    const res = await api('/collections/' + C_BLOGS + '/items/live', { method: 'PATCH', body: JSON.stringify({ items: liveUpdates }) });
    console.log('patched live:', (res.items || []).length);
  }
  if (!stagedUpdates.length && !liveUpdates.length) console.log('nothing to update');
}
if (REPORT) writeFileSync(REPORT, JSON.stringify({ applied: APPLY, ...report }, null, 2));
