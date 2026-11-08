import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SWARM_URL || 'http://127.0.0.1:4173';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'warning' && message.text().includes('[cursor-swarm]')) errors.push(message.text());
});

const read = () => page.evaluate(() => window.demoSwarm.getState({ detailed: true }));
const pause = ms => page.waitForTimeout(ms);
async function until(predicate, message, timeout = 15000) {
  const end = Date.now() + timeout;
  let state;
  while (Date.now() < end) {
    state = await read();
    if (predicate(state)) return state;
    await pause(120);
  }
  assert.fail(`${message}; last state ${JSON.stringify(state)}`);
}
function assertNoConstructionFlock(state) {
  if (state.phase === 'building' && state.pending > 0) {
    assert.equal(state.cursors.filter(cursor => cursor.mode === 'flock').length, 0,
      'workers must roam or perform work while unfinished sections remain; no pointer-centered idle flock');
  }
}
const text = '各个光标一起搭建这张真实页面；完成这一处之后，它们会移开、检查，并继续去往新的工作区域。';
const fixture = `<style>
  html{scroll-behavior:auto}body{margin:0;font:16px/1.5 system-ui;background:#fafaf7}
  main{padding:40px 80px}.work-zone{display:grid;grid-template-columns:repeat(4,1fr);gap:20px}
  p{margin:0;min-height:70px;padding:6px;border-bottom:1px solid #ddd}
  #second{margin-top:1500px;padding-bottom:80px}
</style><main>
  <section class="work-zone" id="first">${Array.from({ length: 20 }, (_, index) =>
    `<p data-swarm="text" data-swarm-id="first-${index}">${index + 1}. ${text}</p>`).join('')}</section>
  <section class="work-zone" id="second">${Array.from({ length: 24 }, (_, index) =>
    `<p data-swarm="text" data-swarm-id="second-${index}">${index + 1}. ${text}</p>`).join('')}</section>
</main>`;

try {
  // Use a real DOM workload, with an unvisited section keeping construction open.
  await page.goto(base + '/assets/');
  await page.setContent(fixture);
  await page.evaluate(async base => {
    const { createCursorSwarm } = await import(base + '/assets/cursor-swarm.mjs');
    window.swarmFactory = createCursorSwarm;
    window.demoSwarm = createCursorSwarm({ root: document.querySelector('main'), count: 36, workers: 'auto' });
  }, base);
  const first = await read();
  assert.ok(Array.isArray(first.cursors), 'detailed diagnostics expose the actual cursor lifecycle');
  await page.mouse.move(1390, 35);
  const participants = new Set();
  const stages = new Set();
  let peakActive = 0;
  await until(state => {
    assertNoConstructionFlock(state);
    peakActive = Math.max(peakActive, state.active);
    for (const cursor of state.cursors) {
      if (cursor.taskId || cursor.worked) participants.add(cursor.id);
      if (cursor.stage) stages.add(cursor.stage);
      stages.add(cursor.mode);
    }
    return state.active === 0 && state.done >= 20;
  }, 'visible workload should finish while lower section still waits');
  assert.ok(peakActive > 8, `auto mode recruits a collective working group; observed peak ${peakActive}`);
  assert.ok(participants.size > 8, `work is distributed beyond the old fixed eight cursors; got ${participants.size}`);
  assert.ok(stages.has('travel'), 'workers visibly travel between tasks');
  assert.ok(stages.has('review') || stages.has('withdraw'), 'work includes a visible review or withdrawal stage');

  // Surplus workers retire instead of becoming a permanent 28-cursor mouse knot.
  const quiet = await until(state => {
    assertNoConstructionFlock(state);
    return state.active === 0 && state.pending > 0 && state.cursorCount <= 10;
  }, 'surplus workers should leave while a small roaming team remains');
  assert.ok(quiet.cursorCount > 0, 'some workers remain available for the next scroll');
  const wanderBefore = new Map(quiet.cursors.map(cursor => [cursor.id, cursor]));
  const range = [];
  let traveled = false;
  for (let i = 0; i < 10; i++) {
    await pause(250);
    const current = await read();
    assertNoConstructionFlock(current);
    range.push(...current.cursors.filter(cursor => cursor.mode === 'roam'));
    for (const cursor of current.cursors) {
      const before = wanderBefore.get(cursor.id);
      if (before && Math.hypot(cursor.x - before.x, cursor.y - before.y) > 50) traveled = true;
    }
  }
  assert.ok(traveled, 'idle workers travel rather than freeze in place');
  assert.ok(range.length > 0, 'diagnostics report the independent roaming state');
  const averagePointerDistance = range.reduce((sum, cursor) => sum + Math.hypot(cursor.x - 1390, cursor.y - 35), 0) / range.length;
  assert.ok(averagePointerDistance > 250,
    `construction roaming is distributed around the page, not the pointer; mean distance ${averagePointerDistance.toFixed(1)}`);

  // A newly visible section should receive additional workers and continue real work.
  const quietCount = (await read()).cursorCount;
  await page.locator('#second').evaluate(element => scrollTo(0, element.getBoundingClientRect().top + scrollY - 35));
  let recruited = false, nextPeak = 0;
  const seenSecondWorkers = new Set();
  await until(state => {
    assertNoConstructionFlock(state);
    nextPeak = Math.max(nextPeak, state.active);
    if (state.cursorCount > quietCount + 2) recruited = true;
    for (const cursor of state.cursors) if (cursor.taskId?.startsWith('second-')) seenSecondWorkers.add(cursor.id);
    return recruited && state.active > 8 && seenSecondWorkers.size > 8;
  }, 'scrolling into a fresh work zone should recruit a new collective');
  console.log(`PASS collective construction: ${peakActive} peak workers, ${participants.size} participants; quiet team ${quietCount}; scroll peak ${nextPeak}`);
  console.log(`PASS independent roaming: pointer distance ${Math.round(averagePointerDistance)} px; no flock while sections wait`);

  await until(state => state.phase === 'following' && state.done === state.total,
    'all completed work should eventually gather into following mode');
  await until(state => state.cursors.length > 0 && state.cursors.every(cursor => cursor.mode === 'flock'),
    'following is the final collective state, after work and withdrawals finish');
  await page.evaluate(() => window.demoSwarm.destroy());

  // Explicit limits must continue to be honored for performance-sensitive integrations.
  await page.evaluate(() => {
    scrollTo(0, 0);
    window.demoSwarm = window.swarmFactory({ root: document.querySelector('main'), count: 24, workers: 4 });
  });
  for (let i = 0; i < 20; i++) {
    await pause(100);
    const state = await read();
    assert.ok(state.active <= 4, 'numeric workers remains a concurrency cap');
    assertNoConstructionFlock(state);
  }
  await page.evaluate(() => window.demoSwarm.destroy());

  // The operator's I-beam should park beside text; only the insertion caret types.
  await page.setContent(`<main><p data-swarm="text" style="width:700px;font:28px/1.5 system-ui">${text.repeat(3)}</p></main>`);
  await page.evaluate(() => window.demoSwarm=window.swarmFactory({root:document.querySelector('main'),speed:.4,workers:1}));
  await until(state=>state.cursors.some(c=>c.mode==='work'&&c.tool==='text'),'text worker should begin typing');
  await pause(350);
  const parked=(await read()).cursors.find(c=>c.mode==='work'&&c.tool==='text');
  const clipBefore=await page.locator('p').evaluate(el=>el.style.clipPath);
  await pause(850);
  const parkedAfter=(await read()).cursors.find(c=>c.id===parked.id);
  assert.ok(Math.hypot(parkedAfter.x-parked.x,parkedAfter.y-parked.y)<5,'colored I-beam remains parked while text is typed');
  assert.notEqual(await page.locator('p').evaluate(el=>el.style.clipPath),clipBefore,'text continues to reveal independently of the parked operator');
  await page.evaluate(()=>window.demoSwarm.destroy());
  console.log('PASS independent text operator and insertion progress');

  // Exercise the shipped demo as well as the controlled workload fixture.
  await page.goto(base + '/demo/');
  await page.waitForFunction(() => window.demoSwarm);
  await page.locator('#start').click();
  let demoWorked = false;
  for (let i = 0; i < 25; i++) {
    await pause(120);
    const state = await read();
    assertNoConstructionFlock(state);
    if (state.active > 1) demoWorked = true;
  }
  assert.ok(demoWorked, 'the shipped demo actually runs collective work');
  await page.evaluate(() => window.demoSwarm.destroy());
  assert.deepEqual(errors, [], 'no runtime errors or fail-open warnings');
  console.log('PASS final gathering, explicit worker limit, and shipped demo');
} finally {
  await browser.close();
}
