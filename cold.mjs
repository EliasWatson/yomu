import { chromium } from '/workspace/solar-system/node_modules/playwright-core/index.mjs';
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome'});const p=await (await b.newContext()).newPage();
const t=Date.now();await p.goto('https://yomu-1b6.pages.dev/#/n/n9669bk/5');await p.waitForSelector('#reader .w, .err',{timeout:120000});console.log((await p.textContent('#app')).slice(0,200));console.log('cold ms',Date.now()-t, await p.$$eval('#reader rt',x=>x.length));await b.close();
