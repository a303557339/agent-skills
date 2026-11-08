import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgents, stepFlock } from '../assets/swarm-motion.mjs';

function seededRandom(seed = 1749) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
const makeAgents = (count = 28) => createAgents(count, 1200, 800, seededRandom());
const meanDistance = (agents, point) => agents.reduce((sum, a) => sum + Math.hypot(a.x - point.x, a.y - point.y), 0) / agents.length;

test('moving target stays finite and catches up over a long run', () => {
  const agents = makeAgents();
  let target;
  for (let frame = 0; frame < 7200; frame++) {
    const t = frame / 60;
    target = { x: 600 + Math.sin(t * 0.6) * 440, y: 400 + Math.cos(t * 0.9) * 250 };
    stepFlock(agents, target, 1 / 60, t, { pointer: target });
    for (const agent of agents) {
      for (const value of [agent.x, agent.y, agent.vx, agent.vy, agent.angle]) assert.ok(Number.isFinite(value));
      assert.ok(Math.hypot(agent.x - target.x, agent.y - target.y) >= 42 - 1e-8);
    }
  }
  assert.ok(meanDistance(agents, target) < 230, 'flock remains close to moving pointer');
});

test('distant target is acquired; returning workers can rejoin', () => {
  const agents = makeAgents();
  const workers = agents.splice(0, 8);
  const target = { x: 1060, y: 140 };
  const before = meanDistance(agents, target);
  for (let i = 0; i < 240; i++) stepFlock(agents, target, 1 / 60, i / 60);
  assert.ok(meanDistance(agents, target) < before * 0.4);
  for (const worker of workers) { worker.x = -300; worker.y = 1100; }
  agents.push(...workers);
  for (let i = 240; i < 600; i++) stepFlock(agents, target, 1 / 60, i / 60);
  assert.ok(meanDistance(workers, target) < 180);
});

test('resume clamps elapsed time and invalid elapsed time is inert', () => {
  const a = makeAgents();
  const b = structuredClone(a);
  const target = { x: 900, y: 300 };
  stepFlock(a, target, 120, 4);
  stepFlock(b, target, 0.05, 4);
  assert.deepEqual(a, b);
  const snapshot = structuredClone(a);
  for (const dt of [0, -1, NaN, Infinity]) stepFlock(a, target, dt, 4);
  assert.deepEqual(a, snapshot);
});

test('30 Hz and 120 Hz converge to similar orbital radius', () => {
  const target = { x: 860, y: 260 };
  const low = makeAgents(18);
  const high = structuredClone(low);
  for (let i = 0; i < 300; i++) stepFlock(low, target, 1 / 30, i / 30);
  for (let i = 0; i < 1200; i++) stepFlock(high, target, 1 / 120, i / 120);
  assert.ok(Math.abs(meanDistance(low, target) - meanDistance(high, target)) < 12);
});

test('exact overlaps separate without singularities', () => {
  const agents = makeAgents(8);
  for (const agent of agents) Object.assign(agent, { x: 600, y: 400, vx: 0, vy: 0 });
  for (let i = 0; i < 120; i++) stepFlock(agents, { x: 600, y: 400 }, 1 / 60, i / 60, { pointer: { x: 600, y: 400 } });
  assert.ok(agents.every(a => Number.isFinite(a.x) && Number.isFinite(a.y)));
  assert.ok(new Set(agents.map(a => `${Math.round(a.x)},${Math.round(a.y)}`)).size > 5);
});
