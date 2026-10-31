import { chromium } from '/workspace/solar-system/node_modules/playwright-core/index.mjs';
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome'});
for (const ep of [60,61,62,63,64,65]) { const p=await (await b.newContext()).newPage(); const t=Date.now();
 await p.goto('https://yomu-1b6.pages.dev/#/n/n9669bk/'+ep); await p.waitForSelector('#reader .w, .err',{timeout:180000});
 console.log(ep,'ms',Date.now()-t, await p.$$eval('#reader rt',x=>x.length), (await p.textContent('#app')).slice(0,40)); await p.context().close(); }
await b.close();
