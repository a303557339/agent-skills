/** Pure cursor flock simulation. Coordinates are viewport CSS pixels. */
const TAU = Math.PI * 2;
const COLORS = ['#F24E1E', '#A259FF', '#1ABCFE', '#0ACF83', '#FF7262', '#FFC700',
  '#9747FF', '#E8467C', '#14AE5C', '#0D99FF', '#FF8A00', '#00B5CE'];
const limit = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

export function createAgents(count, width, height, random = Math.random) {
  const w = Math.max(1, finite(width, 1200));
  const h = Math.max(1, finite(height, 800));
  const n = limit(Math.floor(finite(count, 0)), 0, 160);
  return Array.from({ length: n }, (_, id) => {
    const phase = random() * TAU;
    const arc = id / Math.max(1, n) * TAU + (random() - 0.5) * 0.2;
    const distance = Math.min(w, h) * (0.14 + random() * 0.12);
    // A small quick cohort catches up first after the pointer changes direction.
    // Orbit speed stays shared, so this changes the chase without fragmenting it.
    const quick = random() < .2;
    return {
      id,
      x: w / 2 + Math.cos(arc) * distance,
      y: h / 2 + Math.sin(arc) * distance,
      vx: -Math.sin(arc) * 170,
      vy: Math.cos(arc) * 170,
      angle: arc + Math.PI * 1.25,
      color: COLORS[id % COLORS.length],
      phase,
      orbit: 0.75 + random() * 0.5,
      speed: quick ? 600 + random() * 220 : 290 + random() * 180,
      force: quick ? 2800 + random() * 1400 : 1300 + random() * 900,
    };
  });
}

/**
 * Mutates only the supplied agents, so workers can be omitted while drawing.
 * A suspended tab advances at most 50 ms on resumption. Internal fixed-size
 * substeps keep acceleration and separation comparable at 30–144 Hz.
 */
export function stepFlock(agents, target, dt, time, {
  width = 1200, height = 800, radius = 115, pointer = null,
} = {}) {
  if (!agents.length || !Number.isFinite(dt) || dt <= 0) return;
  const elapsed = Math.min(dt, 0.05);
  const steps = Math.ceil(elapsed * 120);
  const tick = elapsed / steps;
  const tx = finite(target?.x, finite(width, 1200) / 2);
  const ty = finite(target?.y, finite(height, 800) / 2);
  const orbitRadius = limit(finite(radius, 115), 20, 400);
  const now = finite(time, 0);
  const hasPointer = Number.isFinite(pointer?.x) && Number.isFinite(pointer?.y);

  for (let step = 0; step < steps; step++) {
    // Snapshot positions and velocities: iteration order must not change the flock.
    const snapshot = agents.map(agent => ({
      x: agent.x, y: agent.y, vx: agent.vx, vy: agent.vy, id: agent.id,
    }));
    for (let index = 0; index < agents.length; index++) {
      const agent = agents[index];
      const state = snapshot[index];
      const dx = state.x - tx;
      const dy = state.y - ty;
      const distance = Math.hypot(dx, dy);
      const radialAngle = distance > 0.001 ? Math.atan2(dy, dx) : agent.phase;
      const nx = Math.cos(radialAngle);
      const ny = Math.sin(radialAngle);
      const desiredRadius = orbitRadius * agent.orbit
        * (1 + .17 * Math.sin(3 * radialAngle + now * .65))
        * (1 + .05 * Math.sin(now * .55 + agent.phase * .2));
      const radialSpeed = (desiredRadius - distance) * 4.4;
      // A coherent breathing outline and brisk orbit read as one living group.
      // Saturating the direction keeps reversals brief rather than slowly stalling.
      const circulation = (220 + 20 * Math.sin(agent.phase + now * .45))
        * Math.tanh(3.8 * Math.cos(now * .1));
      let desiredX = nx * radialSpeed - ny * circulation;
      let desiredY = ny * radialSpeed + nx * circulation;
      let neighborVX = 0;
      let neighborVY = 0;
      let weights = 0;
      let separationX = 0;
      let separationY = 0;

      for (let otherIndex = 0; otherIndex < snapshot.length; otherIndex++) {
        if (otherIndex === index) continue;
        const neighbor = snapshot[otherIndex];
        let sx = state.x - neighbor.x;
        let sy = state.y - neighbor.y;
        let spacing = Math.hypot(sx, sy);
        if (spacing >= 76) continue;
        const weight = 1 - spacing / 76;
        neighborVX += neighbor.vx * weight;
        neighborVY += neighbor.vy * weight;
        weights += weight;
        if (spacing < 30) {
          if (spacing < 0.001) {
            // Antisymmetric deterministic direction also resolves exact overlaps.
            const low = Math.min(state.id, neighbor.id);
            const high = Math.max(state.id, neighbor.id);
            const angle = (low * 13.13 + high * 7.71) % TAU;
            const sign = state.id < neighbor.id ? 1 : -1;
            sx = Math.cos(angle) * sign;
            sy = Math.sin(angle) * sign;
            spacing = 1;
          }
          const repel = 190 * (1 - spacing / 30);
          separationX += sx / spacing * repel;
          separationY += sy / spacing * repel;
        }
      }
      if (weights > 0) {
        desiredX = desiredX * 0.82 + neighborVX / weights * 0.18;
        desiredY = desiredY * 0.82 + neighborVY / weights * 0.18;
      }
      desiredX += separationX;
      desiredY += separationY;

      const lag = Math.max(0, distance - desiredRadius * 1.5);
      const maxSpeed = agent.speed * (1 + Math.min(3.5, lag / 160));
      const desiredSpeed = Math.hypot(desiredX, desiredY);
      if (desiredSpeed > maxSpeed) {
        desiredX *= maxSpeed / desiredSpeed;
        desiredY *= maxSpeed / desiredSpeed;
      }
      let ax = (desiredX - state.vx) * 5.5;
      let ay = (desiredY - state.vy) * 5.5;
      const acceleration = Math.hypot(ax, ay);
      const maxForce = agent.force * (1 + Math.min(3, lag / 180));
      if (acceleration > maxForce) {
        ax *= maxForce / acceleration;
        ay *= maxForce / acceleration;
      }
      agent.vx += ax * tick;
      agent.vy += ay * tick;
      const speed = Math.hypot(agent.vx, agent.vy);
      if (speed > maxSpeed) {
        agent.vx *= maxSpeed / speed;
        agent.vy *= maxSpeed / speed;
      }
      agent.x += agent.vx * tick;
      agent.y += agent.vy * tick;

      if (hasPointer) {
        const px = agent.x - pointer.x;
        const py = agent.y - pointer.y;
        const proximity = Math.hypot(px, py);
        const exclusion = 42;
        if (proximity < exclusion) {
          const angle = proximity > 0.001 ? Math.atan2(py, px) : agent.phase;
          const ex = Math.cos(angle);
          const ey = Math.sin(angle);
          agent.x = pointer.x + ex * exclusion;
          agent.y = pointer.y + ey * exclusion;
          const inward = agent.vx * ex + agent.vy * ey;
          if (inward < 0) {
            agent.vx -= ex * inward * 1.3;
            agent.vy -= ey * inward * 1.3;
          }
        }
      }

      if (Math.hypot(agent.vx, agent.vy) > 8) {
        const heading = Math.atan2(agent.vy, agent.vx) + Math.PI * 0.75;
        const delta = Math.atan2(Math.sin(heading - agent.angle), Math.cos(heading - agent.angle));
        agent.angle += delta * (1 - Math.exp(-tick * 10));
        agent.angle = Math.atan2(Math.sin(agent.angle), Math.cos(agent.angle));
      }
    }
  }
}
