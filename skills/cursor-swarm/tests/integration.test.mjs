import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.SWARM_URL||'http://127.0.0.1:4173';
const b=await chromium.launch({headless:true});const p=await b.newPage({viewport:{width:1100,height:800}});
const errors=[];p.on('pageerror',e=>errors.push(e.message));
try {
  await p.goto(base+'/assets/');
  await p.setContent(`<main><svg width="300" height="100"><path id="path" data-swarm="path" pathLength="1" d="M0 50 L300 50" stroke="black" fill="none"/></svg><h1 data-swarm="text" style="opacity:.8">A sufficiently long heading to animate while a framework updates its styles</h1><div contenteditable><p>Editor content must never hide</p></div><div contenteditable="plaintext-only"><p>Plain text editor</p></div><button data-swarm="rect"><span data-swarm="text">Keep this label visible on focus</span></button></main>`);
  await p.evaluate(async base=>{const {createCursorSwarm}=await import(base+'/assets/cursor-swarm.mjs');window.factory=createCursorSwarm;window.demoSwarm=createCursorSwarm({root:document.querySelector('main'),speed:.25});},base);
  await p.waitForFunction(()=>document.querySelector('#path').style.strokeDasharray);
  assert.equal(await p.locator('#path').evaluate(el=>el.style.strokeDasharray),'1');
  assert.ok(await p.locator('#path').evaluate(el=>Number(el.style.strokeDashoffset)<1));
  await p.locator('h1').evaluate(el=>el.style.opacity='.35');await p.waitForTimeout(70);
  await p.locator('button').focus();
  assert.equal(await p.locator('button span').evaluate(el=>getComputedStyle(el).opacity),'1','focus exposes descendant label');
  await p.evaluate(()=>window.demoSwarm.finish());assert.equal(await p.locator('h1').evaluate(el=>el.style.opacity),'0.35','framework style update survives animation');
  await p.evaluate(()=>window.demoSwarm.destroy());
  await p.locator('main [data-swarm]').evaluateAll(els=>els.forEach(el=>el.removeAttribute('data-swarm')));
  await p.evaluate(()=>window.demoSwarm=window.factory({root:document.querySelector('main'),start:'manual'}));
  assert.equal(await p.locator('[contenteditable] p[style]').count(),0,'both editor syntaxes excluded');
  await p.evaluate(()=>window.demoSwarm.destroy());
  console.log('PASS SVG pathLength, concurrent application styles, keyboard focus and editable regions');

  await p.setContent('<main><div id="scroller" style="overflow:auto;height:140px"><div style="height:500px"><p data-swarm="text">Nested scrolling text</p><p data-swarm="text" style="margin-top:230px">New nested content</p></div></div><div style="transform:scale(.7);transform-origin:0 0"><h1 data-swarm="text">Scaled heading uses local clip coordinates</h1></div></main>');
  await p.evaluate(()=>window.demoSwarm=window.factory({root:document.querySelector('main'),start:'interaction',speed:.3}));
  await p.locator('#scroller').evaluate(el=>el.scrollTop=90);await p.waitForTimeout(100);
  assert.ok(await p.evaluate(()=>window.demoSwarm.getState().active>0),'nested scrolling triggers waiting instance');
  await p.waitForFunction(()=>document.querySelector('h1').style.clipPath.startsWith('polygon'));
  const measure=await p.locator('h1').evaluate(el=>({clip:el.style.clipPath,box:el.getBoundingClientRect().width,local:el.offsetWidth}));
  assert.ok(measure.box<measure.local,'fixture exercises scaled text');assert.ok(!measure.clip.includes('NaN'));
  await p.evaluate(()=>window.demoSwarm.destroy());assert.deepEqual(errors,[]);
  console.log('PASS nested scrolling and transformed text');
}finally{await b.close();}
