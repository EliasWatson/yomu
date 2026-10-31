import fs from 'fs';
const j = JSON.parse(fs.readFileSync(process.argv[2]||'jmdict-eng.json','utf8'));
const N=1024; const h=s=>{let x=2166136261;for(const c of s){x^=c.codePointAt(0);x=Math.imul(x,16777619)>>>0}return x%N};
const shards=Array.from({length:N},()=>({}));
let n=0;
for(const e of j.words){
  const common = e.kanji.some(k=>k.common)||e.kana.some(k=>k.common);
  const senses=e.sense.map(s=>[s.partOfSpeech, s.gloss.map(g=>g.text).join('; '), (s.misc||[]).filter(m=>['uk','col','sl','arch','hon','hum','pol','vulg','abbr','obs'].includes(m))]);
  const rec={k:e.kanji.map(k=>k.text),r:e.kana.map(k=>k.text),c:common?1:0,s:senses};
  const keys=new Set([...rec.k,...rec.r]);
  for(const key of keys){const sh=shards[h(key)];(sh[key]??=[]).push(rec)}
  n++;
}
fs.mkdirSync('public/dict/jm',{recursive:true});
let tot=0;
for(let i=0;i<N;i++){
  for(const k in shards[i]) shards[i][k].sort((a,b)=>b.c-a.c);
  const s=JSON.stringify(shards[i]); tot+=s.length;
  fs.writeFileSync(`public/dict/jm/${i}.json`,s);
}
fs.writeFileSync('public/dict/tags.json',JSON.stringify(j.tags));
console.log(n,'entries',(tot/1e6).toFixed(1),'MB', j.dictDate);
