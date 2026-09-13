import { readFileSync } from 'node:fs';

const arena = new Set(
  JSON.parse(readFileSync('./data/latest.json','utf8')).models.map(m => m.arena_model_name)
);

const d = await (await fetch('https://api.macpaw.com/ai/api/v1/model/info')).json();

const keys = [...new Set(d.data.map(m => m?.model_info?.key).filter(Boolean))];
const norm = k => k.split('/').pop();
const hit = [], miss = [];
for (const k of keys) (arena.has(norm(k)) ? hit : miss).push(k);

console.log('gateway keys:', keys.length);
console.log('\nHIT', hit.length);
console.log(hit.sort().join('\n'));
console.log('\nMISS', miss.length);
console.log(miss.sort().join('\n'));
