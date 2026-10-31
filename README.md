# Yomu 読む

A reader for [小説家になろう (Syosetu)](https://syosetu.com) web novels aimed at Japanese learners:
furigana on every kanji, tap any word for a JMdict definition + conjugation breakdown, saved-word list with Anki/CSV export,
reading progress, light/sepia/dark themes, optional vertical text.

Live: https://yomu-1b6.pages.dev

## How it works
- Static frontend on Cloudflare Pages (`public/`), no build step.
- `functions/api/fetch.js`: Pages Function that proxies + edge-caches pages from `ncode.syosetu.com`, `novel18.syosetu.com` and `api.syosetu.com` only (CORS). HTML is parsed in the browser.
- Tokenizing/readings: [kuromoji.js](https://github.com/takuyaa/kuromoji.js) (Apache-2.0) with the bundled IPADIC dictionary (see `public/vendor/kuromoji-NOTICE.md`), ~18 MB, cached by a service worker.
- Dictionary: [JMdict](https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project) English via [jmdict-simplified](https://github.com/scriptin/jmdict-simplified), sharded into 1024 JSON files by `scripts/build-dict.mjs`.

## Licenses / credits
- JMdict © Electronic Dictionary Research and Development Group, used under [CC BY-SA 4.0](https://www.edrdg.org/edrdg/licence.html). The derived files in `public/dict/jm/` are under the same license.
- kuromoji.js: Apache-2.0. IPADIC: see NOTICE.
- Novel text is not stored in this repo; it's fetched live from Syosetu and belongs to its authors. Unofficial, not affiliated with Hina Project.
- App code: MIT.

## Rebuild the dictionary
Download `jmdict-eng-*.json.tgz` from jmdict-simplified releases, extract next to the script, and run `node scripts/build-dict.mjs`.
