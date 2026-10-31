'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('yomu:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { localStorage.setItem('yomu:' + k, JSON.stringify(v)); }
};
const app = $('#app');

/* ---------- settings ---------- */
const settings = Object.assign({ size: 19, furi: true, theme: 'auto', vert: false }, LS.get('settings', {}));
function applySettings() {
  document.documentElement.style.setProperty('--fs', settings.size + 'px');
  document.documentElement.dataset.theme = settings.theme;
  document.body.classList.toggle('nofuri', !settings.furi);
  document.body.classList.toggle('vert', settings.vert);
  $('#set-size').value = settings.size; $('#set-furi').checked = settings.furi;
  $('#set-theme').value = settings.theme; $('#set-vert').checked = settings.vert;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  $('meta[name=theme-color]').content = bg || '#faf7f0';
  LS.set('settings', settings);
}
$('#set-size').oninput = e => { settings.size = +e.target.value; applySettings(); };
$('#set-furi').onchange = e => { settings.furi = e.target.checked; applySettings(); };
$('#set-theme').onchange = e => { settings.theme = e.target.value; applySettings(); };
$('#set-vert').onchange = e => { settings.vert = e.target.checked; applySettings(); };
$('#btn-settings').onclick = e => { e.stopPropagation(); $('#settings').classList.toggle('hidden'); };
document.addEventListener('click', e => { if (!e.target.closest('#settings,#btn-settings')) $('#settings').classList.add('hidden'); });
$('#btn-words').onclick = () => location.hash = '#/words';

/* ---------- fetching ---------- */
async function proxied(url, type = 'text') {
  let r;
  // Syosetu blocks some Cloudflare egress IPs; a fresh request often lands on a different one.
  for (let i = 0; i < 6; i++) {
    r = await fetch('/api/fetch?url=' + encodeURIComponent(url) + (i ? '&retry=' + i : ''));
    if (r.ok || (r.status !== 403 && r.status < 500)) break;
    await new Promise(s => setTimeout(s, 300 * i));
  }
  if (!r.ok) throw new Error(`Syosetu returned ${r.headers.get('X-Upstream-Status') || r.status}`);
  return type === 'json' ? r.json() : r.text();
}
const parseHTML = html => new DOMParser().parseFromString(html, 'text/html');
function parseNcode(input) {
  input = input.trim();
  const m = input.match(/(?:(novel18)\.syosetu\.com\/)?\b(n\d{4}[a-z]{1,3})\b(?:\/(\d+))?/i);
  if (!m) return null;
  return { host: m[1] || /novel18/.test(input) ? (m[1] ? 'novel18' : 'ncode') : 'ncode', ncode: m[2].toLowerCase(), ep: m[3] ? +m[3] : null };
}
const hostFor = n => (LS.get('host:' + n) === 'novel18' ? 'novel18' : 'ncode') + '.syosetu.com';

/* ---------- tokenizer + dictionary ---------- */
let tokenizerP = null;
function getTokenizer(onProgress) {
  if (tokenizerP) return tokenizerP;
  tokenizerP = new Promise((res, rej) => {
    // track download progress of dictionary files
    const total = 12; let done = 0; const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (...a) { this.addEventListener('loadend', () => { done++; onProgress && onProgress(done / total); }); return origOpen.apply(this, a); };
    kuromoji.builder({ dicPath: '/dict/kuromoji/' }).build((err, t) => { XMLHttpRequest.prototype.open = origOpen; err ? (tokenizerP = null, rej(err)) : res(t); });
  });
  return tokenizerP;
}
const SHARDS = 1024; const shardCache = new Map();
function shardOf(s) { let x = 2166136261; for (const c of s) { x ^= c.codePointAt(0); x = Math.imul(x, 16777619) >>> 0; } return x % SHARDS; }
function loadShard(i) { if (!shardCache.has(i)) shardCache.set(i, fetch(`/dict/jm/${i}.json`).then(r => r.json()).catch(() => (shardCache.delete(i), {}))); return shardCache.get(i); }
async function lookup(word) { if (!word) return []; return (await loadShard(shardOf(word)))[word] || []; }
let tagsP = fetch('/dict/tags.json').then(r => r.json()).catch(() => ({}));

const kata2hira = s => s.replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff々〆ヶ\u{20000}-\u{2fa1f}]/u;
const hasKanji = s => KANJI.test(s);

// split surface into [text, reading|null] pairs so okurigana is not duplicated
function alignFurigana(surface, readingKata) {
  const reading = kata2hira(readingKata || '');
  if (!hasKanji(surface) || !reading || reading === '*') return [[surface, null]];
  const parts = []; let cur = '', curK = null;
  for (const ch of surface) { const k = KANJI.test(ch); if (curK === null || k === curK) cur += ch; else { parts.push([cur, curK]); cur = ch; } curK = k; }
  parts.push([cur, curK]);
  const re = new RegExp('^' + parts.map(([t, k]) => k ? '(.+?)' : '(' + kata2hira(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')').join('') + '$');
  const m = reading.match(re);
  if (!m) return [[surface, reading]];
  return parts.map(([t, k], i) => [t, k ? m[i + 1] : null]);
}
function rubyHTML(surface, reading) {
  return alignFurigana(surface, reading).map(([t, r]) => r ? `<ruby>${esc(t)}<rt class="g">${esc(r)}</rt></ruby>` : esc(t)).join('');
}

/* ---------- grouping tokens into words (verb + auxiliaries) ---------- */
function isAux(t, prev, next) {
  if (t.pos === '助動詞') return true;
  if ((t.pos === '動詞' || t.pos === '形容詞') && (t.pos_detail_1 === '非自立' || t.pos_detail_1 === '接尾')) return true;
  if (t.pos === '名詞' && t.pos_detail_1 === '接尾' && t.pos_detail_2 === '助動詞語幹') return true;  // そう
  if (t.pos === '助詞' && t.pos_detail_1 === '接続助詞' && /^(て|で|ば)$/.test(t.surface_form)) return true;
  return false;
}
function groupTokens(tokens) {
  const groups = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]; const g = [t];
    const head = t.pos === '動詞' || t.pos === '形容詞' || (t.pos === '助動詞' && false) ||
      (t.pos === '名詞' && (t.pos_detail_1 === 'サ変接続' || t.pos_detail_1 === '形容動詞語幹'));
    if (head) {
      while (i + 1 < tokens.length) {
        const n = tokens[i + 1];
        const sahen = g.length === 1 && t.pos === '名詞' && n.pos === '動詞' && n.basic_form === 'する';
        const keiyodo = g.length === 1 && t.pos_detail_1 === '形容動詞語幹' && n.pos === '助動詞' && /^(だ|な|に)$/.test(n.surface_form);
        if (t.pos === '名詞' && g.length === 1 && !sahen && !keiyodo) break;
        if (sahen || keiyodo || isAux(n)) { g.push(n); i++; } else break;
      }
      // don't end a word with a dangling て/ば that isn't followed by an aux
    }
    groups.push(g);
  }
  return groups;
}
const AUX_LABEL = {
  'ない': 'negative', 'ぬ': 'negative', 'ん': 'negative', 'ず': 'negative (classical)', 'た': 'past', 'だ': 'past',
  'ます': 'polite', 'れる': 'passive / potential / honorific', 'られる': 'passive / potential / honorific',
  'せる': 'causative', 'させる': 'causative', 'たい': 'want to', 'たがる': 'wants to (3rd person)', 'う': 'volitional / presumptive',
  'よう': 'volitional / presumptive', 'まい': 'negative volitional', 'らしい': 'seems', 'そう': 'looks like / I hear',
  'いる': '-te iru: ongoing / resulting state', 'しまう': '-te shimau: completely / regrettably', 'おく': '-te oku: in advance',
  'くる': '-te kuru: start to / come', 'いく': '-te iku: go on to', 'ある': '-te aru: has been done', 'みる': '-te miru: try',
  'くれる': '-te kureru: does for me', 'もらう': '-te morau: have someone do', 'あげる': '-te ageru: do for someone',
  'やる': '-te yaru: do for someone', 'ちゃう': '= -te shimau', 'じゃう': '= -de shimau', 'てる': '= -te iru', 'する': 'する verb',
  'ば': 'conditional (if)', 'て': 'te-form', 'で': 'te-form', 'やすい': 'easy to', 'にくい': 'hard to', 'すぎる': 'too much', 'なさい': 'command (polite)',
  'べし': 'should', 'です': 'polite copula', 'ござる': 'humble/polite (gozaru)', 'き': 'past (classical)'
};
function conjHint(g) {
  if (g.length < 2 && !(g[0].conjugated_form && /仮定|命令|未然ウ/.test(g[0].conjugated_form))) return '';
  const head = g[0]; const parts = [];
  for (const t of g.slice(1)) { const l = AUX_LABEL[t.basic_form] || AUX_LABEL[t.surface_form]; if (l) parts.push(l); else parts.push(t.basic_form); }
  if (head.conjugated_form && head.conjugated_form.startsWith('命令')) parts.unshift('imperative');
  return `<b>${esc(g.map(t => t.surface_form).join(''))}</b> = <b>${esc(head.basic_form)}</b>${parts.map(p => ' + ' + esc(p)).join('')}`;
}
const POS_EN = { '名詞': 'noun', '動詞': 'verb', '形容詞': 'i-adjective', '副詞': 'adverb', '助詞': 'particle', '助動詞': 'auxiliary', '連体詞': 'pre-noun adjectival', '接続詞': 'conjunction', '感動詞': 'interjection', '記号': 'symbol', '接頭詞': 'prefix', 'フィラー': 'filler' };
const POS2_EN = { '固有名詞': 'proper noun', '代名詞': 'pronoun', '数': 'number', 'サ変接続': 'する-noun', '形容動詞語幹': 'na-adjective', '副詞可能': 'adverbial noun', '人名': 'person name', '地域': 'place', '非自立': 'dependent', '接尾': 'suffix', '格助詞': 'case', '係助詞': 'binding', '終助詞': 'sentence-ending', '接続助詞': 'conjunctive', '副助詞': 'adverbial' };

/* ---------- rendering paragraphs ---------- */
let TOK = [];  // token groups by id, for popups
function renderText(tokenizer, text) {
  const tokens = tokenizer.tokenize(text);
  let html = '';
  const groups = groupTokens(tokens);
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const surface = g.map(t => t.surface_form).join('');
    if (/^[\s　、。「」『』（）()！？!?…‥・―─ー〜~\-—*＊]+$/.test(surface)) { html += esc(surface); continue; }
    const id = TOK.length; TOK.push({ g, next: groups.slice(gi + 1, gi + 4).map(x => x.map(t => t.surface_form).join('')) });
    html += `<span class="w" data-t="${id}">${g.map(t => rubyHTML(t.surface_form, t.reading)).join('')}</span>`;
  }
  return html;
}
function renderNode(tokenizer, node) {
  // node: <p> element from syosetu. Respect author ruby; tokenize the rest.
  let html = ''; let buf = '';
  const flush = () => { if (buf) { html += renderText(tokenizer, buf); buf = ''; } };
  for (const c of node.childNodes) {
    if (c.nodeType === 3) buf += c.textContent;
    else if (c.nodeName === 'RUBY') {
      flush();
      const rt = [...c.querySelectorAll('rt')].map(x => x.textContent).join('');
      const base = [...c.childNodes].filter(x => !/^(RT|RP)$/.test(x.nodeName)).map(x => x.textContent).join('');
      const id = TOK.length; TOK.push({ author: { base, rt }, next: [] });
      html += `<span class="w" data-t="${id}"><ruby>${esc(base)}<rt>${esc(rt)}</rt></ruby></span>`;
    } else if (c.nodeName === 'BR') { flush(); html += '<br>'; }
    else if (c.nodeName === 'IMG') { flush(); html += `<img src="${esc(c.getAttribute('src'))}" style="max-width:100%" alt="">`; }
    else buf += c.textContent;
  }
  flush();
  return html;
}

/* ---------- popup ---------- */
const popup = $('#popup'); let selEl = null;
function closePopup() { popup.classList.add('hidden'); selEl && selEl.classList.remove('sel'); selEl = null; }
document.addEventListener('keydown', e => e.key === 'Escape' && closePopup());
async function showPopup(el) {
  selEl && selEl.classList.remove('sel'); selEl = el; el.classList.add('sel');
  const info = TOK[+el.dataset.t]; const tags = await tagsP;
  let headword, reading, posLine = '', conj = '', cands = [];
  if (info.author) {
    headword = info.author.base; reading = info.author.rt; cands = [headword, kata2hira(reading)];
    posLine = '<span class="pos">author ruby</span>';
  } else {
    const g = info.g; const h = g[0];
    headword = h.basic_form !== '*' ? h.basic_form : h.surface_form;
    if (g.length > 1 && g[0].pos === '名詞' && g[1].basic_form === 'する') headword = h.surface_form + 'する';
    reading = h.reading ? kata2hira(h.reading) : '';
    if (h.pos === '動詞' || h.pos === '形容詞') { const r = h.pronunciation && h.reading; }
    posLine = `<span class="pos">${esc(POS_EN[h.pos] || h.pos)}${POS2_EN[h.pos_detail_1] ? ' · ' + esc(POS2_EN[h.pos_detail_1]) : ''}</span>` +
      (h.conjugated_type && h.conjugated_type !== '*' ? `<span class="pos">${esc(h.conjugated_type)}</span>` : '');
    conj = conjHint(g);
    const surf = g.map(t => t.surface_form).join('');
    // longest-match compound lookups first (e.g. 異世界 + 転生)
    const seq = [h.surface_form]; let acc = h.surface_form;
    if (g.length === 1) for (const n of info.next) { acc += n; seq.unshift(acc); }
    cands = [...seq.slice(0, -1), headword, h.surface_form, surf, h.basic_form.replace(/する$/, '')];
    if (headword !== h.surface_form) {
      try { const ts = (await getTokenizer()).tokenize(headword); if (ts.every(t => t.reading)) reading = kata2hira(ts.map(t => t.reading).join('')); } catch { }
    }
  }
  cands = [...new Set(cands.filter(Boolean))];
  const results = []; const seen = new Set();
  for (const c of cands) {
    let es = await lookup(c);
    if (!info.author && c === headword && reading) es = [...es].sort((a, b) => (b.r.includes(reading) - a.r.includes(reading)) || (b.c - a.c));
    for (const e of es) { const key = e.k[0] + '|' + e.r[0]; if (!seen.has(key)) { seen.add(key); results.push({ e, via: c }); } }
    if (results.length >= 6) break;
  }
  // drop long compound matches if they don't exist; keep at most 5
  const shown = results.slice(0, 5);
  const saved = LS.get('words', []);
  const isSaved = saved.some(w => w.word === headword);
  popup.innerHTML = `
    <div class="ph"><div><div class="hw">${esc(headword)}</div><div class="hr">${esc(reading)}</div></div>
      <div class="x"><button id="pp-save" title="Save word">${isSaved ? '★' : '☆'}</button><button id="pp-close" title="Close">✕</button></div></div>
    <div>${posLine}</div>
    ${conj ? `<div class="conj">${conj}</div>` : ''}
    ${shown.length ? shown.map(({ e, via }) => `<div class="entry"><div class="eh">${esc(e.k[0] || e.r[0])} ${e.k[0] ? `<small>【${esc(e.r.slice(0, 3).join('・'))}】</small>` : ''}${e.c ? '<span class="tag">common</span>' : ''}</div>
      <ol>${e.s.slice(0, 6).map(s => `<li>${s[0].map(p => `<span class="pos" title="${esc(tags[p] || p)}">${esc(shortTag(p))}</span>`).join('')}${s[2].map(m => `<span class="pos">${esc(tags[m] || m)}</span>`).join('')} ${esc(s[1])}</li>`).join('')}</ol></div>`).join('')
      : '<p class="muted">No dictionary entry found (may be a name or rare word).</p>'}`;
  $('#pp-close').onclick = closePopup;
  $('#pp-save').onclick = () => {
    const ws = LS.get('words', []); const i = ws.findIndex(w => w.word === headword);
    if (i >= 0) ws.splice(i, 1); else {
      const top = shown[0]?.e;
      ws.unshift({ word: headword, reading, meaning: top ? top.s.slice(0, 3).map(s => s[1]).join(' / ') : '', context: el.closest('p')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 140) || '', src: location.hash, at: Date.now() });
    }
    LS.set('words', ws); $('#pp-save').textContent = i >= 0 ? '☆' : '★'; updateWordCount();
  };
  positionPopup(el);
}
const TAG_SHORT = { n: 'noun', 'n-adv': 'adverbial noun', 'n-t': 'temporal noun', 'n-suf': 'suffix noun', 'n-pref': 'prefix noun', pn: 'pronoun', 'adj-i': 'い-adj', 'adj-na': 'な-adj', 'adj-no': 'の-adj', 'adj-pn': 'pre-noun adj', 'adj-t': 'たる-adj', 'adj-f': 'prenominal', adv: 'adverb', 'adv-to': 'adverb (と)', aux: 'auxiliary', 'aux-v': 'aux verb', 'aux-adj': 'aux adj', conj: 'conjunction', cop: 'copula', ctr: 'counter', exp: 'expression', int: 'interjection', num: 'numeric', pref: 'prefix', suf: 'suffix', prt: 'particle', vs: 'する verb', 'vs-i': 'する verb', 'vs-s': 'する verb (special)', vt: 'transitive', vi: 'intransitive', v1: 'ichidan verb', 'v1-s': 'ichidan verb', vk: 'くる verb', 'vz': 'ずる verb', 'v5r-i': 'godan verb (irregular)', 'v5k-s': 'godan verb (行く)', 'v5aru': 'godan verb (aru)', 'adj-ix': 'い-adj (いい)', 'adj-ku': 'く-adj (archaic)', 'adj-shiku': 'しく-adj (archaic)', 'adj-nari': 'なり-adj (archaic)', unc: 'unclassified' };
const shortTag = p => TAG_SHORT[p] || (/^v5/.test(p) ? 'godan verb' : /^v2|^v4/.test(p) ? 'archaic verb' : p);
function positionPopup(el) {
  popup.classList.remove('hidden'); popup.scrollTop = 0;
  const mobile = window.innerWidth < 640;
  popup.classList.toggle('sheet', mobile);
  if (mobile) {
    popup.style.left = popup.style.top = '';
    // keep the selected word visible above the sheet
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect(); const sheetTop = window.innerHeight - popup.offsetHeight;
      if (!settings.vert && r.bottom > sheetTop - 12) window.scrollBy({ top: r.bottom - sheetTop + 60, behavior: 'smooth' });
      else if (r.top < 60) window.scrollBy({ top: r.top - 80, behavior: 'smooth' });
    });
    return;
  }
  const r = el.getBoundingClientRect(); const pw = popup.offsetWidth, ph = popup.offsetHeight;
  let left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
  let top = r.bottom + 10; if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 10);
  if (settings.vert) { left = r.left - pw - 10; if (left < 8) left = r.right + 10; top = Math.min(Math.max(8, r.top), window.innerHeight - ph - 8); }
  popup.style.left = left + 'px'; popup.style.top = top + 'px';
}
document.addEventListener('click', e => {
  const w = e.target.closest('.w');
  if (w) { e.preventDefault(); if (w === selEl) closePopup(); else showPopup(w); return; }
  if (!e.target.closest('#popup')) closePopup();
});
window.addEventListener('resize', () => selEl && positionPopup(selEl));

/* ---------- views ---------- */
function loading(msg) { app.innerHTML = `<div class="spinner">${esc(msg)}<div class="bar-progress"><div id="prog"></div></div></div>`; }
function errorView(e) { app.innerHTML = `<div class="err"><b>Couldn't load.</b><br>${esc(e.message || e)}</div><p><button class="primary" onclick="route()">Try again</button> <a href="#/">← Home</a></p>`; }
function updateWordCount() { $('#word-count').textContent = LS.get('words', []).length; }

async function viewHome() {
  const lib = LS.get('library', {});
  const items = Object.values(lib).sort((a, b) => b.at - a.at);
  app.innerHTML = `
    <h1>Read Syosetu with furigana & a tap dictionary</h1>
    <form class="search" id="f-open"><input id="in-open" placeholder="Paste a ncode.syosetu.com URL or ncode (e.g. n9669bk)" autocapitalize="off" autocomplete="off"><button class="primary">Open</button></form>
    ${items.length ? `<h2>Continue reading</h2><ul class="list">${items.map(n => `<li><a href="#/n/${n.ncode}/${n.ep || ''}">${esc(n.title)}<span class="sub">${n.ep ? `Episode ${n.ep}` : 'Not started'}${n.epTitle ? ' · ' + esc(n.epTitle) : ''}</span></a></li>`).join('')}</ul>` : ''}
    <h2>Search</h2>
    <form class="search" id="f-search"><input id="in-search" placeholder="Keyword (e.g. 異世界, 悪役令嬢)"><button>Search</button></form>
    <div class="chips" id="order-chips">${[['hyoka', 'Top rated'], ['weekly', 'Popular this week'], ['new', 'Newest updates']].map(([k, l], i) => `<button data-o="${k}" class="${i ? '' : 'on'}">${l}</button>`).join('')}</div>
    <ul class="list" id="results"><li class="muted" style="padding:.8em 0">Loading…</li></ul>`;
  $('#f-open').onsubmit = e => { e.preventDefault(); const p = parseNcode($('#in-open').value); if (!p) return alert('That doesn\'t look like a Syosetu URL or ncode.'); if (/novel18/.test($('#in-open').value)) LS.set('host:' + p.ncode, 'novel18'); location.hash = `#/n/${p.ncode}/${p.ep || ''}`; };
  let order = 'hyoka';
  const run = async () => {
    const q = $('#in-search').value.trim(); const res = $('#results');
    res.innerHTML = '<li class="muted" style="padding:.8em 0">Loading…</li>';
    try {
      const url = `https://api.syosetu.com/novelapi/api/?out=json&lim=30&of=t-n-w-ga-nt-e-l&order=${q ? 'hyoka' : order}${q ? '&word=' + encodeURIComponent(q) : ''}`;
      const data = await proxied(url, 'json');
      const list = data.slice(1);
      res.innerHTML = list.length ? list.map(n => `<li><a href="#/n/${n.ncode.toLowerCase()}/">${esc(n.title)}<span class="sub">${esc(n.writer)} · ${n.noveltype === 2 ? 'short story' : (n.general_all_no + ' episodes')}${n.end === 0 ? ' · complete' : ''} · ${(n.length / 1000).toFixed(0)}k chars</span></a></li>`).join('') : '<li class="muted" style="padding:.8em 0">No results.</li>';
    } catch (e) { res.innerHTML = `<li class="muted" style="padding:.8em 0">Search unavailable right now (${esc(e.message)}). You can still paste a URL above.</li>`; }
  };
  $('#f-search').onsubmit = e => { e.preventDefault(); run(); };
  $('#order-chips').onclick = e => { const b = e.target.closest('button'); if (!b) return; order = b.dataset.o; $('#in-search').value = ''; [...e.currentTarget.children].forEach(x => x.classList.toggle('on', x === b)); run(); };
  run();
  getTokenizer(); // warm up dictionary download in background
}

async function viewToc(ncode, page) {
  loading('Loading table of contents…');
  try {
    const host = hostFor(ncode);
    const doc = parseHTML(await proxied(`https://${host}/${ncode}/${page > 1 ? '?p=' + page : ''}`));
    const title = $('.p-novel__title', doc)?.textContent.trim() || ncode;
    const author = $('.p-novel__author', doc)?.textContent.replace('作者：', '').trim() || '';
    const summary = $('.p-novel__summary', doc)?.textContent.trim() || '';
    const lib = LS.get('library', {}); const entry = lib[ncode] || { ncode, title, at: Date.now() }; entry.title = title; lib[ncode] = entry; LS.set('library', lib);
    if (!doc.querySelector('.p-eplist') && doc.querySelector('.p-novel__text')) return viewChapter(ncode, 0, doc);
    const read = LS.get('read:' + ncode, {});
    let html = `<h1>${esc(title)}</h1><p class="muted">${esc(author)} · <a href="https://${host}/${ncode}/" target="_blank" rel="noopener">View on Syosetu ↗</a></p>`;
    if (summary && page <= 1) html += `<div class="summary">${esc(summary)}</div>`;
    if (entry.ep) html += `<p><a class="primary" href="#/n/${ncode}/${entry.ep}"><button class="primary">Continue: episode ${entry.ep}</button></a></p>`;
    html += '<div>';
    for (const el of doc.querySelectorAll('.p-eplist > *')) {
      if (el.classList.contains('p-eplist__chapter-title')) html += `<div class="chap">${esc(el.textContent.trim())}</div>`;
      else { const a = $('a', el); if (!a) continue; const ep = +(a.getAttribute('href').match(/\/(\d+)\/?$/) || [])[1];
        html += `<ul class="list"><li><a href="#/n/${ncode}/${ep}" class="${read[ep] ? 'read' : ''} ${entry.ep === ep ? 'current' : ''}">${esc(a.textContent.trim())}<span class="sub">#${ep} · ${esc(($('.p-eplist__update', el)?.childNodes[0]?.textContent || '').trim())}${read[ep] ? ' · read' : ''}</span></a></li></ul>`; }
    }
    html += '</div>';
    const next = $('.c-pager__item--next', doc), prev = $('.c-pager__item--before', doc);
    const pn = a => a && a.getAttribute('href') ? +(a.getAttribute('href').match(/p=(\d+)/) || [, 1])[1] : null;
    const stats = $('.c-pager__result-stats', doc)?.textContent.replace(/\s+/g, ' ').trim() || '';
    if (pn(next) || pn(prev)) html += `<div class="pager"><a href="#/n/${ncode}?p=${pn(prev)}" class="${pn(prev) ? '' : 'disabled'}">← Prev</a><span class="muted">${esc(stats)}</span><a href="#/n/${ncode}?p=${pn(next)}" class="${pn(next) ? '' : 'disabled'}">Next →</a></div>`;
    app.innerHTML = html; window.scrollTo(0, 0);
  } catch (e) { errorView(e); }
}

let saveScroll = null;
async function viewChapter(ncode, ep, preDoc) {
  document.body.classList.add('reading');
  loading('Loading chapter…');
  try {
    const host = hostFor(ncode);
    const [doc, tokenizer] = await Promise.all([
      preDoc ? preDoc : proxied(`https://${host}/${ncode}/${ep ? ep + '/' : ''}`).then(parseHTML),
      getTokenizer(p => { const b = $('#prog'); if (b) b.style.width = (p * 100) + '%'; const s = $('.spinner'); if (s && p < 1 && s.firstChild.nodeType === 3) s.firstChild.textContent = 'Loading Japanese dictionary (first time only, ~18 MB)…'; })
    ]);
    TOK = [];
    const novelTitle = ($('.c-announce:not(.c-announce--note) > a[href^="/"]', doc) || $('.p-novel__title', doc))?.textContent.trim() || ncode;
    const epTitle = $('.p-novel__title', doc)?.textContent.trim() || '';
    const texts = [...doc.querySelectorAll('.p-novel__text')];
    let body = `<div class="ep-title">${renderText(tokenizer, epTitle)}</div>`;
    for (const t of texts) {
      const cls = t.classList.contains('p-novel__text--preface') || t.classList.contains('p-novel__text--afterword') ? 'note' : '';
      body += `<div class="${cls}">` + [...t.querySelectorAll('p')].map(p => `<p>${renderNode(tokenizer, p)}</p>`).join('') + '</div>';
    }
    const nextA = [...doc.querySelectorAll('.c-pager__item--next')][0], prevA = [...doc.querySelectorAll('.c-pager__item--before')][0];
    const epOf = a => a && a.getAttribute('href') ? +(a.getAttribute('href').match(/\/(\d+)\/?$/) || [])[1] || null : null;
    const nx = epOf(nextA), pv = epOf(prevA);
    const pager = ep ? `<div class="pager"><a href="#/n/${ncode}/${pv || ''}" class="${pv ? '' : 'disabled'}">← Prev</a><a href="#/n/${ncode}">Contents</a><a href="#/n/${ncode}/${nx || ''}" class="${nx ? '' : 'disabled'}">Next →</a></div>` : '';
    app.innerHTML = `<p class="muted" style="margin:.2em 0 .8em"><a href="#/n/${ncode}">${esc(novelTitle)}</a>${ep ? ' · #' + ep : ''}</p>${pager}<article id="reader">${body}</article>${pager}`;
    // progress
    const lib = LS.get('library', {}); lib[ncode] = Object.assign(lib[ncode] || { ncode }, { title: ep ? novelTitle : epTitle, ep: ep || null, epTitle: ep ? epTitle : '', at: Date.now() }); LS.set('library', lib);
    const read = LS.get('read:' + ncode, {}); if (ep) { read[ep] = 1; LS.set('read:' + ncode, read); }
    const key = `pos:${ncode}:${ep}`; const pos = LS.get(key, 0);
    const reader = $('#reader');
    requestAnimationFrame(() => {
      if (settings.vert) reader.scrollLeft = -pos * (reader.scrollWidth - reader.clientWidth);
      else window.scrollTo(0, pos * (document.documentElement.scrollHeight - innerHeight));
    });
    saveScroll = () => {
      const f = settings.vert ? Math.abs(reader.scrollLeft) / Math.max(1, reader.scrollWidth - reader.clientWidth)
        : scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight);
      LS.set(key, Math.min(1, Math.max(0, f)));
    };
    reader.addEventListener('scroll', throttle(saveScroll, 400), { passive: true });
    if (nx) proxied(`https://${host}/${ncode}/${nx}/`).catch(() => { }); // prefetch next into edge cache
  } catch (e) { errorView(e); }
}
function throttle(fn, ms) { let t = 0; return () => { if (!t) t = setTimeout(() => { t = 0; fn(); }, ms); }; }
window.addEventListener('scroll', throttle(() => saveScroll && saveScroll(), 400), { passive: true });

function viewWords() {
  const ws = LS.get('words', []);
  app.innerHTML = `<h1>Saved words (${ws.length})</h1>
    <p><button id="exp-tsv" class="primary">Export for Anki (TSV)</button> <button id="exp-csv">Export CSV</button> ${ws.length ? '<button id="clr">Clear all</button>' : ''}</p>
    ${ws.length ? `<table class="words">${ws.map((w, i) => `<tr><td>${esc(w.word)}<div class="muted">${esc(w.reading)}</div></td><td>${esc(w.meaning)}<div class="muted" style="font-family:var(--jp)">${esc(w.context)}</div></td><td><button data-del="${i}" title="Remove">✕</button></td></tr>`).join('')}</table>` : '<p class="muted">Tap a word while reading, then ☆ to save it here.</p>'}`;
  const dl = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type })); a.download = name; a.click(); };
  const cell = s => String(s || '').replace(/[\t\n]/g, ' ');
  $('#exp-tsv').onclick = () => dl('yomu-words.tsv', ws.map(w => [w.word, w.reading, w.meaning, w.context].map(cell).join('\t')).join('\n'), 'text/tab-separated-values');
  $('#exp-csv').onclick = () => dl('yomu-words.csv', 'word,reading,meaning,context\n' + ws.map(w => [w.word, w.reading, w.meaning, w.context].map(s => '"' + cell(s).replace(/"/g, '""') + '"').join(',')).join('\n'), 'text/csv');
  if ($('#clr')) $('#clr').onclick = () => { if (confirm('Delete all saved words?')) { LS.set('words', []); updateWordCount(); viewWords(); } };
  app.onclick = e => { const b = e.target.closest('[data-del]'); if (b) { ws.splice(+b.dataset.del, 1); LS.set('words', ws); updateWordCount(); viewWords(); } };
}

function route() {
  closePopup(); saveScroll = null; app.onclick = null;
  document.body.classList.remove('reading');
  const h = location.hash.slice(1) || '/';
  let m;
  if (h === '/words') return viewWords();
  if ((m = h.match(/^\/n\/(n\d+[a-z]+)\/(\d+)$/))) return viewChapter(m[1], +m[2]);
  if ((m = h.match(/^\/n\/(n\d+[a-z]+)\/?(?:\?p=(\d+))?$/))) return viewToc(m[1], +(m[2] || 1));
  return viewHome();
}
applySettings(); updateWordCount();
window.addEventListener('hashchange', route); route();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
