import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SWARM_URL || 'http://127.0.0.1:4173';
const artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
mkdirSync(artifacts,{recursive:true});
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='warning'&&m.text().includes('[cursor-swarm]'))errors.push(m.text());});
const state=()=>page.evaluate(()=>window.demoSwarm.getState());
try {
  await page.goto(`${base}/demo/`);await page.waitForFunction(()=>window.demoSwarm);
  assert.equal((await state()).phase,'intro');
  await page.waitForTimeout(600);await page.screenshot({path:artifacts+'demo-intro.png'});
  const initialText=await page.locator('main').textContent();
  await page.locator('#start').click();await page.waitForTimeout(1100);
  assert.ok((await state()).active>1,'multiple concurrent drawing workers');
  await page.screenshot({path:artifacts+'demo-build.png'});
  assert.equal(await page.locator('main').textContent(),initialText,'drawing preserves original text DOM');
  await page.waitForTimeout(6500);
  for(let y=600;y<2700;y+=500){await page.evaluate(y=>scrollTo(0,y),y);await page.waitForTimeout(3200);}
  await page.waitForFunction(()=>window.demoSwarm.getState().pending===0&&window.demoSwarm.getState().active===0,{},{timeout:15000});
  assert.equal((await state()).phase,'following');
  await page.locator('#demo-email').fill('demo@example.com');await page.locator('#demo-form button').click();
  assert.equal(await page.evaluate(()=>window.demoEvents.submissions),1,'real form retains handler');
  await page.evaluate(()=>scrollTo(0,0));await page.mouse.move(1030,370);await page.waitForTimeout(1400);
  await page.screenshot({path:artifacts+'demo-follow.png'});
  await page.locator('#replay').click();await page.waitForTimeout(300);
  assert.equal((await state()).phase,'intro');
  assert.equal(await page.locator('[data-cursor-swarm-overlay]').count(),1);
  await page.locator('#finish').click();
  assert.equal((await state()).done,(await state()).total);
  await page.evaluate(()=>window.demoSwarm.destroy());
  assert.equal(await page.locator('[data-cursor-swarm-overlay]').count(),0);
  assert.equal(await page.locator('main [style*="clip-path"]').count(),0);
  assert.equal(await page.locator('main [style*="opacity: 0"]').count(),0);
  console.log('PASS demo: parallel build, text preservation, scrolling completion, real form, replay, cleanup');

  await page.goto(base+'/assets/'); // New document clears the demo's UI polling timer.
  await page.setContent('<main><h1 style="opacity: .8; color: red">A real <em>rich text</em> heading</h1><button id="clicker">Increment</button><p>Second task</p></main>');
  await page.evaluate(async base=>{const {createCursorSwarm}=await import(base+'/assets/cursor-swarm.mjs'); window.factory=createCursorSwarm; window.demoSwarm=createCursorSwarm({root:document.querySelector('main'),start:'interaction'});window.clicks=0;document.querySelector('button').onclick=()=>window.clicks++;},base);
  await page.locator('button').click({force:true});await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.clicks),1);
  assert.ok((await state()).active>0,'interaction starts without intro');
  await page.evaluate(()=>{const p=document.createElement('p');p.textContent='A dynamically added task';document.querySelector('main').append(p);});
  await page.waitForTimeout(150);assert.equal((await state()).total,4,'dynamic auto discovery');
  await page.evaluate(()=>window.demoSwarm.finish());
  assert.equal(await page.locator('h1').evaluate(el=>el.style.opacity),'0.8','original inline style restored');
  await page.evaluate(()=>{window.demoSwarm=window.factory({root:document.querySelector('main')});});
  assert.equal(await page.locator('[data-cursor-swarm-overlay]').count(),1,'duplicate mount replaces instance');
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(100);
  assert.equal((await state()).phase,'reduced');assert.equal((await state()).done,4);
  console.log('PASS generic DOM: discovery, interaction, dynamic child, original style, duplicate mount, reduced motion');
  await page.evaluate(()=>window.demoSwarm.destroy());
  await page.emulateMedia({reducedMotion:'no-preference'});

  await page.setContent('<main><p data-swarm="text" data-swarm-id="a" data-swarm-after="b">A</p><p data-swarm="text" data-swarm-id="b" data-swarm-after="a">B</p><p data-swarm="text" data-swarm-after="missing">C</p></main>');
  await page.evaluate(()=>window.demoSwarm=window.factory({root:document.querySelector('main')}));
  assert.equal((await state()).done,3,'invalid dependency graph never strands hidden content');
  await page.evaluate(()=>window.demoSwarm.destroy());
  console.log('PASS invalid dependency recovery');

  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await mobile.goto(base+'/demo/');await mobile.waitForFunction(()=>window.demoSwarm);
  assert.equal(await mobile.evaluate(()=>window.demoSwarm.getState().phase),'reduced');
  assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no mobile horizontal overflow');
  assert.equal(await mobile.evaluate(()=>{const c=document.querySelector('[data-cursor-swarm-overlay]').shadowRoot.querySelector('canvas');return c.getContext('2d').getImageData(0,0,c.width,c.height).data.some(x=>x);}),false,'touch fallback canvas stays empty');
  // Chromium's full-page screenshot temporarily clears touch emulation. Keep the
  // intended static fallback in the capture with an explicit motion preference.
  await mobile.emulateMedia({reducedMotion:'reduce'});
  await mobile.screenshot({path:artifacts+'demo-mobile.png',fullPage:true});await mobile.close();
  assert.deepEqual(errors,[],'no runtime error or fail-open warning');
  console.log('PASS mobile fallback and console errors');
} finally {await browser.close();}
