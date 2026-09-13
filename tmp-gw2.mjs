import { readFileSync } from 'node:fs';

const snap = JSON.parse(readFileSync('./data/latest.json','utf8'));
const d = await (await fetch('https://api.macpaw.com/ai/api/v1/model/info')).json();

const chat = d.data
  .filter(m => m?.model_info?.mode === 'chat')
  .map(m => m.model_info.key);

const canon = s => s.split('/').pop()
  .toLowerCase()
  .replace(/-\d{4}-\d{2}-\d{2}$/, '')
  .replace(/-\d{8}$/, '')
  .replace(/[.\-_]/g, '');

const byCanon = new Map();
for (const m of snap.models) {
  const k = canon(m.arena_model_name);
  if (!byCanon.has(k)) byCanon.set(k, m);
}

const hit = [], miss = [];
for (const key of [...new Set(chat)]) {
  const m = byCanon.get(canon(key));
  (m ? hit : miss).push(m ? `${String(m.arena_rank).padStart(4)}  ${key}  ->  ${m.arena_model_name}` : key);
}

console.log('chat models in gateway:', new Set(chat).size);
console.log('\nMATCHED', hit.length);
console.log(hit.sort((a,b)=>parseInt(a)-parseInt(b)).join('\n'));
console.log('\nUNMATCHED', miss.length);
console.log(miss.sort().join('\n'));
