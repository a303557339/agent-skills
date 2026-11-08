import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFlight, sampleFlight, makeTypingTrack, typingProgress } from '../assets/swarm-choreography.mjs';

function randomSeed(seed = 82) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

test('flight hits exact endpoints, supports live destinations and isolates input objects', () => {
  const from = { x: 10, y: 35 }, to = { x: 650, y: 270 };
  const flight = makeFlight(from, to);
  from.x = -100; to.y = -400;
  assert.deepEqual(sampleFlight(flight, 0), { x: 10, y: 35 });
  assert.deepEqual(sampleFlight(flight, 1), { x: 650, y: 270 });
  assert.deepEqual(sampleFlight(flight, 1, { x: 450, y: 190 }), { x: 450, y: 190 });
  assert.deepEqual(sampleFlight(flight, -1), flight.from);
  assert.deepEqual(sampleFlight(flight, 5), flight.to);
});

test('signed arcs bend in opposite directions and drag never overshoots its placement', () => {
  const from = { x: 20, y: 60 }, to = { x: 420, y: 60 };
  const positive = makeFlight(from, to, { bend: 80 });
  const negative = makeFlight(from, to, { bend: -80 });
  assert.ok(sampleFlight(positive, .5).y > 60);
  assert.ok(sampleFlight(negative, .5).y < 60);
  const drag = makeFlight(from, to, { bend: 0, drag: true });
  let last = from.x;
  for (let i = 0; i <= 100; i++) {
    const p = sampleFlight(drag, i / 100);
    assert.ok(p.x >= last - 1e-9 && p.x <= to.x + 1e-9);
    assert.equal(p.y, 60); last = p.x;
  }
  assert.ok(drag.duration > makeFlight(from, to).duration);
});

test('flight positions agree at equal times across frame rates; durations follow distance/speed', () => {
  const from = { x: 20, y: 35 }, to = { x: 620, y: 335 };
  const flight = makeFlight(from, to);
  const low = Array.from({ length: 31 }, (_, frame) => sampleFlight(flight, frame / 30));
  const high = Array.from({ length: 121 }, (_, frame) => sampleFlight(flight, frame / 120));
  low.forEach((position, i) => assert.deepEqual(position, high[i * 4]));
  assert.ok(makeFlight(from, {x:50,y:60}).duration < flight.duration);
  assert.equal(makeFlight(from,to,{speed:2}).duration,flight.duration/2);
  assert.equal(makeFlight(from,{x:1e6,y:1e6}).duration,1.25);
  assert.deepEqual(sampleFlight(makeFlight(from,from),.4),from);
});

test('typing uses uneven beats and observable punctuation/word pauses', () => {
  const track = makeTypingTrack('One small team, many moving cursors. Build together!', randomSeed());
  assert.equal(track.stops[0].at,0);
  assert.equal(track.stops[0].progress,0);
  assert.equal(track.stops.at(-1).at,track.duration);
  assert.equal(track.stops.at(-1).progress,1);
  const deltas = track.stops.slice(1).map((s,i)=>s.at-track.stops[i].at);
  assert.ok(Math.max(...deltas)>Math.min(...deltas)*3);
  assert.ok(track.duration>=.4&&track.duration<=3);
  let prior = 0;
  for(let i=0;i<=1000;i++){
    const value=typingProgress(track,track.duration*i/1000);
    assert.ok(value>=prior);prior=value;
  }
  for(let i=1;i<track.stops.length;i++){
    const prev=track.stops[i-1],next=track.stops[i];
    assert.ok(next.at>prev.at);
    assert.equal(typingProgress(track,(prev.at+next.at)/2),prev.progress);
  }
});

test('typing reveals whole grapheme clusters while returning UTF-16 progress', () => {
  const text='中文👩🏽‍💻 e\u0301 🇨🇳 ✨！';
  const boundaries=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].map(s=>s.index+s.segment.length);
  const track=makeTypingTrack(text,randomSeed());
  assert.deepEqual(track.stops.slice(1).map(s=>Math.round(s.progress*text.length)),boundaries);
  for(const value of ['', 'A', 'long paragraph '.repeat(100)]){
    const t=makeTypingTrack(value,randomSeed());
    assert.equal(typingProgress(t,-1),0);
    assert.equal(typingProgress(t,NaN),0);
    assert.equal(typingProgress(t,t.duration),1);
    assert.ok(Number.isFinite(t.duration)&&t.duration>0&&t.duration<=8);
  }
});
