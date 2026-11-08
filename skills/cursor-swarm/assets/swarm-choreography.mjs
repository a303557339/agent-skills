/** Pure timing and trajectory helpers for visible, purposeful cursor work. */
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const copyPoint = point => ({ x: finite(point?.x, 0), y: finite(point?.y, 0) });

/** A single movement, independent of the requestAnimationFrame cadence. */
export function makeFlight(from, to, { speed = 1, bend = 40, drag = false } = {}) {
  const start = copyPoint(from), end = copyPoint(to);
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const seconds = .16 + Math.sqrt(distance) * (drag ? .030 : .025);
  return {
    from: start,
    to: end,
    duration: clamp(seconds, .18, 1.25) / clamp(finite(speed, 1), .1, 8),
    bend: finite(bend, 40),
    drag: Boolean(drag),
  };
}

/**
 * `to` may follow a moving DOM target after a scroll/resize. Bend is perpendicular
 * to the actual travel direction, in CSS pixels, not an always-upward offset.
 */
export function sampleFlight(flight, progress, to = flight.to) {
  const p = clamp(finite(progress, 0), 0, 1);
  const from = flight.from, end = copyPoint(to);
  if (p === 0) return { ...from };
  if (p === 1) return end;
  const dx = end.x - from.x, dy = end.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < .000001) return { ...from };

  // Travel accelerates early and eases into a deliberate arrival. Precision drag
  // uses a symmetric profile with zero velocity/acceleration at both endpoints.
  const smooth = p * p * (3 - 2 * p);
  const u = flight.drag
    ? p * p * p * (10 + p * (-15 + p * 6))
    : 1 - Math.pow(1 - smooth, 1.4);
  const arc = Math.sin(Math.PI * u)
    * clamp(flight.bend, -distance * .28, distance * .28);
  return {
    x: from.x + dx * u - dy / distance * arc,
    y: from.y + dy * u + dx / distance * arc,
  };
}

function graphemes(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
      .map(({ segment, index }) => ({ text: segment, end: index + segment.length }));
  }
  // Older engines still avoid broken surrogate pairs. Group common combining
  // marks, variation selectors, modifiers, ZWJ chains, and paired flag symbols.
  const result = [];
  let end = 0, regionalCount = 0;
  for (const character of text) {
    end += character.length;
    const previous = result.at(-1);
    const regional = /\p{Regional_Indicator}/u.test(character);
    const attaches = /[\u200D\uFE0E\uFE0F]|\p{Mark}|\p{Emoji_Modifier}/u.test(character)
      || previous?.text.endsWith('\u200D') || (regional && regionalCount % 2 === 1);
    if (previous && attaches) { previous.text += character; previous.end = end; }
    else result.push({ text: character, end });
    regionalCount = regional ? regionalCount + 1 : 0;
  }
  return result;
}

/**
 * Precompute irregular typing beats once. Progress is a UTF-16 text offset ratio,
 * so it can drive the existing Range-based reveal without replacing real text.
 */
export function makeTypingTrack(value, random = Math.random) {
  const text = String(value ?? '');
  const parts = graphemes(text);
  const rand = () => clamp(finite(random(), .5), 0, 1);
  const stops = [{ at: 0, progress: 0 }];
  let elapsed = 0;
  for (const part of parts) {
    let delay = .012 + rand() * .023;
    if (/\s/u.test(part.text)) delay += .014 + rand() * .043;
    if (/[,.!?;:，。！？；：、]/u.test(part.text)) delay += .055 + rand() * .095;
    if (part.text.includes('\n')) delay += .055;
    if (rand() < .045) delay += .065 + rand() * .11;
    elapsed += delay;
    stops.push({ at: elapsed, progress: part.end / text.length });
  }
  if (!parts.length) return { stops: [{ at: 0, progress: 0 }, { at: .4, progress: 1 }], duration: .4 };
  const ceiling = text.length <= 200 ? 3 : Math.min(8, 3 + Math.sqrt((text.length - 200) / 60));
  const duration = clamp(elapsed, .4, ceiling);
  const scale = duration / elapsed;
  for (const stop of stops) stop.at *= scale;
  // Make the public final endpoint exact, rather than one floating-point ulp off.
  stops.at(-1).at = duration;
  stops.at(-1).progress = 1;
  return { stops, duration };
}

/** Stepwise reveal: characters appear as discrete beats rather than a time ramp. */
export function typingProgress(track, elapsed) {
  if (elapsed >= track.duration) return 1;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  let low = 0, high = track.stops.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (track.stops[middle].at <= elapsed) low = middle;
    else high = middle - 1;
  }
  return track.stops[low].progress;
}
