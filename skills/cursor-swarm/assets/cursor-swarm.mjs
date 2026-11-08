import { createAgents, stepFlock } from './swarm-motion.mjs';
import { makeFlight, sampleFlight, makeTypingTrack, typingProgress } from './swarm-choreography.mjs';

const mounted = new WeakMap();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ease = t => t * t * (3 - 2 * t);
const random = (lo, hi) => lo + Math.random() * (hi - lo);
const ignored = '[data-swarm-ignore],script,style,template,textarea,input,select,[contenteditable="true"]';

/** Mount a decorative swarm over real, editable DOM. No dependencies or text rewrites. */
export function createCursorSwarm(options = {}) {
  if (typeof document === 'undefined') throw new Error('Mount cursor-swarm in a client lifecycle hook.');
  const root = options.root ?? document.body;
  if (!(root instanceof Element)) throw new TypeError('root must be a DOM Element');
  mounted.get(root)?.destroy();
  const config = { count: 36, workers: 'auto', radius: 115, speed: 1, start: 'auto', intro: false,
    autoDiscover: true, respectReducedMotion: true, touch: 'disable', ...options };
  config.count = clamp(Number(config.count) || 36, 1, 100);
  const workerLimit = config.workers === 'auto' ? config.count : clamp(Number(config.workers) || 8, 1, config.count);
  config.speed = clamp(Number(config.speed) || 1, .25, 4);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(pointer: coarse)');
  const disabled = () => (config.respectReducedMotion && reduce.matches) || (config.touch === 'disable' && coarse.matches);
  let phase = disabled() ? 'reduced' : config.intro ? 'intro' : 'building';
  let width = innerWidth, height = innerHeight, time = 0, last = 0, frame = 0, destroyed = false;
  let pointer = null, dirty = true, refreshNeeded = false, frontier = 0, serial = 0, activeStart = false;
  let scrollSpeed = 0, previousScroll = scrollY, recruitAt = 0, tempo = 1;
  let tasks = [], pool = [], agents = [];
  function resetCrew() {
    pool = createAgents(config.count, width, height).map(a => ({...a, mode:config.intro?'flock':'roam', tool:'arrow',
      worked:0, idleFor:0, flight:null, readyAt:0, pace:random(.88,1.18), patience:random(1.4,2.7)}));
    agents = pool.slice(0, Math.min(config.count, 18));
  }
  resetCrew();
  const managed = new Map(), listeners = [], byElement = new Map();
  const host = document.createElement('div');
  host.dataset.cursorSwarmOverlay = '';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;overflow:hidden;contain:strict;';
  const shadow = host.attachShadow({ mode: 'open' });
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none';
  shadow.append(canvas);
  document.documentElement.append(host);
  const ctx = canvas.getContext('2d');
  if (!ctx) { host.remove(); throw new Error('Canvas 2D is unavailable'); }
  function listen(el, name, fn, opts) { el.addEventListener(name, fn, opts); listeners.push(() => el.removeEventListener(name, fn, opts)); }
  function setStyle(el, key, value) {
    let props = managed.get(el);
    if (!props) managed.set(el, props = new Map());
    let p = props.get(key);
    if (!p) props.set(key, p = { value: el.style.getPropertyValue(key), priority: el.style.getPropertyPriority(key), last: null });
    else if (el.style.getPropertyValue(key) !== p.last || el.style.getPropertyPriority(key) !== p.lastPriority) {
      p.value = el.style.getPropertyValue(key); p.priority = el.style.getPropertyPriority(key);
    }
    el.style.setProperty(key, value, 'important');
    p.last = el.style.getPropertyValue(key);
    p.lastPriority = el.style.getPropertyPriority(key);
  }
  function restore(el) {
    const props = managed.get(el);
    if (!props) return;
    for (const [key, p] of props) {
      // Preserve an application update made while the animation was active.
      if (el.style.getPropertyValue(key) !== p.last || el.style.getPropertyPriority(key) !== p.lastPriority) continue;
      if (p.value) el.style.setProperty(key, p.value, p.priority); else el.style.removeProperty(key);
    }
    managed.delete(el);
  }
  function hidden(t) {
    setStyle(t.el, 'opacity', '0');
    setStyle(t.el, 'transition', 'none');
  }
  function isCandidate(el) {
    if (el.isContentEditable || el.closest(ignored) || el.closest('[data-cursor-swarm-overlay]')) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  function discover() {
    tasks = tasks.filter(t => { if(t.el.isConnected) return true; complete(t); byElement.delete(t.el); return false; });
    let elements = [...root.querySelectorAll('[data-swarm]')];
    if (root.matches('[data-swarm]')) elements.unshift(root);
    if (!elements.length && config.autoDiscover) {
      elements = [...root.querySelectorAll('h1,h2,h3,p,button,a,img,svg')].filter(el => !el.parentElement?.closest('h1,h2,h3,p,button,a,svg'));
    }
    for (const el of elements.filter(isCandidate).slice(0, 400)) {
      if (byElement.has(el)) continue;
      let type = el.dataset.swarm || (/^(IMG|svg)$/i.test(el.tagName) ? 'reveal' : 'text');
      if (!['text', 'rect', 'path', 'reveal'].includes(type)) type = 'reveal';
      if (type === 'path' && typeof el.getTotalLength !== 'function') type = 'reveal';
      if (type === 'text' && !el.textContent.trim()) type = 'reveal';
      const t = { el, type, id: el.dataset.swarmId || `swarm-${++serial}`, deps: [], state: 'pending', progress: 0,
        duration: type === 'text' ? clamp(el.textContent.length / 35, .65, 3.6) : type === 'path' ? 1.2 : .95 };
      tasks.push(t); byElement.set(el, t);
      if (!disabled()) hidden(t); else t.state = 'done';
    }
    const ids = new Map(tasks.map(t => [t.id, t]));
    for (const t of tasks) {
      t.deps = (t.el.dataset.swarmAfter || '').split(/\s+/).filter(Boolean).map(id => ids.get(id));
      let parent = t.el.parentElement;
      while (parent && root.contains(parent)) { if (byElement.has(parent)) t.deps.push(byElement.get(parent)); parent = parent.parentElement; }
    }
    // Build the whole graph before checking it, in linear rather than exponential time.
    const visiting = new Set(), checked = new Map();
    const invalid = n => {
      if (!n || visiting.has(n)) return true;
      if (checked.has(n)) return checked.get(n);
      visiting.add(n); const bad = n.deps.some(invalid); visiting.delete(n); checked.set(n,bad); return bad;
    };
    for(const t of tasks) if(invalid(t)) complete(t);
    dirty = true;
  }
  function complete(t, withdraw = false) {
    t.state = 'done'; t.progress = 1; restore(t.el);
    if (t.agent) {
      const a=t.agent; a.task=null; a.tool='arrow'; a.idleFor=0; a.flight=null;
      a.mode=withdraw?'withdraw':'roam'; a.readyAt=time+(withdraw?.25:0);
      if(withdraw){
        a.flight=makeFlight(a,{x:clamp(a.x+random(22,65),20,width-20),y:clamp(a.y+random(-32,40),30,height-30)},
          {speed:1.6,bend:random(-18,18)});a.flightTime=0;
      }
      t.agent = null;
    }
  }
  function geometry(t) {
    t.box = t.el.getBoundingClientRect();
    t.sx = t.el.offsetWidth ? t.box.width / t.el.offsetWidth : 1;
    t.sy = t.el.offsetHeight ? t.box.height / t.el.offsetHeight : 1;
    t.rotated = false;
    for(let el=t.el;el&&el!==document.documentElement;el=el.parentElement){
      const transform=getComputedStyle(el).transform;
      if(transform!=='none'){const m=new DOMMatrix(transform);if(Math.abs(m.b)>.001||Math.abs(m.c)>.001||!m.is2D)t.rotated=true;}
    }
    t.textNodes = null;
    if (t.type === 'path') {
      try { t.length = t.el.getTotalLength(); t.dashLength = Number(t.el.getAttribute('pathLength')) > 0 ? Number(t.el.getAttribute('pathLength')) : t.length; t.matrix = t.el.getScreenCTM(); } catch { t.type = 'reveal'; }
    }
  }
  function textReveal(t, progress) {
    if(t.rotated){setStyle(t.el,'clip-path',`inset(0 ${100-progress*100}% 0 0)`);return point(t,progress);}
    // A Range measures the original rich text. No innerHTML or textContent mutation.
    if (!t.textNodes) {
      const walk = document.createTreeWalker(t.el, NodeFilter.SHOW_TEXT);
      t.textNodes = []; let node, total = 0;
      while ((node = walk.nextNode())) { t.textNodes.push({ node, start: total }); total += node.length; }
      t.textLength = total;
    }
    const count = Math.max(0, Math.ceil(t.textLength * progress - 1e-7));
    if(!count){setStyle(t.el,'clip-path','inset(0 100% 0 0)');return {x:t.box.left,y:t.box.top+Math.min(t.box.height,24)};}
    const end = [...t.textNodes].reverse().find(n => n.start < count);
    if (!end) return { x: t.box.left, y: t.box.top };
    const range = document.createRange(); range.setStart(t.textNodes[0].node, 0);
    // Avoid splitting UTF-16 surrogate pairs.
    let offset = Math.min(end.node.length, count - end.start);
    if (offset < end.node.length && /[\uDC00-\uDFFF]/.test(end.node.data[offset])) offset++;
    range.setEnd(end.node, offset);
    const rects = [...range.getClientRects()].filter(r => r.width && r.height);
    // Disconnected subpaths encoded as zero-area bridges, same winding for each rect.
    const points = [];
    for (const r of rects) {
      const x = (r.left - t.box.left) / t.sx - 1, y = (r.top - t.box.top) / t.sy - 2, w = r.width / t.sx + 2, h = r.height / t.sy + 4;
      points.push('0px 0px', `${x}px ${y}px`, `${x + w}px ${y}px`, `${x + w}px ${y + h}px`, `${x}px ${y + h}px`, `${x}px ${y}px`, '0px 0px');
    }
    if (points.length) setStyle(t.el, 'clip-path', `polygon(nonzero,${points.join(',')})`);
    const r = rects.at(-1) || t.box;
    return { x: getComputedStyle(t.el).direction === 'rtl' ? r.left : r.right, y: r.bottom - 3 };
  }
  function point(t, progress) {
    if (t.type === 'path' && t.matrix) {
      const p = t.el.getPointAtLength(t.length * progress);
      return { x: p.x * t.matrix.a + p.y * t.matrix.c + t.matrix.e, y: p.x * t.matrix.b + p.y * t.matrix.d + t.matrix.f };
    }
    return { x: t.box.left + t.box.width * progress, y: t.box.top + t.box.height * progress };
  }
  function recruit() {
    if(time<recruitAt || agents.length>=config.count) return false;
    const a=pool.find(c=>!agents.includes(c)); if(!a)return false;
    a.x=Math.random()<.5?-28:width+28;a.y=random(.12,.88)*height;
    a.vx=0;a.vy=0;a.angle=0;a.mode='roam';a.tool='arrow';a.flight=null;a.idleFor=0;a.readyAt=time;
    agents.push(a);recruitAt=time+.065;return true;
  }
  function available() {
    return tasks.filter(t=>t.state==='pending' && t.box.top+scrollY<=frontier && t.box.top<height+28 && t.deps.every(d=>d?.state==='done'));
  }
  function assign() {
    const candidates=available();
    const busy=agents.filter(a=>a.task).length;
    const desired=Math.min(workerLimit,Math.max(6,busy+candidates.length));
    if(candidates.length && agents.filter(a=>a.mode!=='leave').length<desired)recruit();
    let slots=workerLimit-busy;
    // Let every cursor participate. Nearby workers usually stay with a component,
    // but an idle worker gets precedence over one which just finished another job.
    const free=agents.filter(a=>!a.task&&a.mode!=='withdraw'&&a.mode!=='leave'&&a.readyAt<=time)
      .sort((a,b)=>a.worked-b.worked || b.idleFor-a.idleFor);
    for(const a of free){
      if(slots<=0||!candidates.length)break;
      let best=0,score=Infinity;
      candidates.forEach((t,i)=>{
        const p=point(t,0),offscreen=t.box.bottom<0?2000:0;
        const s=Math.hypot(p.x-a.x,p.y-a.y)+offscreen-(a.region===t.el.closest('section,article,header,footer')?80:0);
        if(s<score){score=s;best=i;}
      });
      const t=candidates.splice(best,1)[0];t.state='active';t.agent=a;t.stage='travel';t.clock=0;t.progress=0;
      t.track=t.type==='text'?makeTypingTrack(t.el.textContent):null;
      if(t.track)t.duration=t.track.duration;
      t.flight=makeFlight(a,point(t,0),{speed:random(1.1,1.55),bend:random(-75,75)});
      t.reviewTime=random(.2,.38);a.task=t;a.mode='travel';a.tool='arrow';a.flight=null;a.idleFor=0;a.worked++;
      a.region=t.el.closest('section,article,header,footer');slots--;
    }
  }
  function place(a,p,dt){
    a.vx=clamp((p.x-a.x)/Math.max(dt,.001),-1600,1600);a.vy=clamp((p.y-a.y)/Math.max(dt,.001),-1600,1600);
    a.x=p.x;a.y=p.y;a.angle*=Math.exp(-dt*14);
  }
  function advance(t,dt){
    const a=t.agent,delta=dt*config.speed*tempo*a.pace*(t.box.bottom<0?2:1);
    t.clock+=delta;a.press=Math.max(0,(a.press||0)-dt*6);
    if(t.stage==='travel'){
      place(a,sampleFlight(t.flight,t.clock/t.flight.duration,point(t,0)),dt);
      if(t.clock>=t.flight.duration){t.stage='press';t.clock=0;a.mode='press';a.tool=t.type==='path'?'path':'rect';a.press=1;}
      return;
    }
    if(t.stage==='press'){
      place(a,point(t,0),dt);
      if(t.clock>.075){t.stage='work';t.clock=0;a.mode='work';a.tool=t.type==='reveal'?'rect':t.type;}
      return;
    }
    if(t.stage==='review'){
      const p=t.reviewPoint;
      place(a,{x:a.x+(t.box.left+p.x-a.x)*Math.min(1,dt*14),y:a.y+(t.box.top+p.y-a.y)*Math.min(1,dt*14)},dt);
      if(t.clock>=t.reviewTime)complete(t,true);
      return;
    }
    const linear=clamp(t.clock/t.duration,0,1);
    const p=t.progress=t.type==='text'?typingProgress(t.track,t.clock):ease(linear);
    setStyle(t.el,'opacity','1');
    if(t.type==='text'){
      t.caret=textReveal(t,p);
      // An operator parks the I-beam beside the text. The insertion caret types.
      const park={x:t.box.left+Math.min(t.box.width*.65,96)+Math.sin(a.phase)*12,y:t.box.top+Math.min(t.box.height+12,40)};
      place(a,{x:a.x+(park.x-a.x)*Math.min(1,dt*18),y:a.y+(park.y-a.y)*Math.min(1,dt*18)},dt);
    }else{
      if(t.type==='path'){
        setStyle(t.el,'stroke-dasharray',`${t.dashLength}`);setStyle(t.el,'stroke-dashoffset',`${t.dashLength*(1-p)}`);
        setStyle(t.el,'fill-opacity',`${Math.max(0,(p-.85)/.15)}`);
      }else setStyle(t.el,'clip-path',t.type==='rect'?`inset(0 ${100-p*100}% ${100-p*100}% 0)`:`inset(0 ${100-p*100}% 0 0)`);
      place(a,point(t,p),dt);
    }
    if(linear>=1){
      t.stage='review';t.clock=0;a.mode='review';a.tool='arrow';a.press=.5;restore(t.el);
      t.reviewPoint={x:clamp(a.x-t.box.left+random(12,24),8,t.box.width+24),y:clamp(a.y-t.box.top+random(5,16),8,t.box.height+22)};
    }
  }
  function roam(dt){
    const keep=Math.min(6,config.count),free=agents.filter(a=>!a.task);
    for(const a of free){
      a.angle*=Math.exp(-dt*12);a.press=Math.max(0,(a.press||0)-dt*6);
      if(a.mode==='withdraw'||a.mode==='leave'){
        a.flightTime+=dt*config.speed;
        place(a,sampleFlight(a.flight,a.flightTime/a.flight.duration),dt);
        if(a.flightTime>=a.flight.duration){
          if(a.mode==='leave'){agents=agents.filter(c=>c!==a);continue;}
          a.mode='roam';a.flight=null;a.readyAt=time+random(.08,.3);
        }
        continue;
      }
      a.mode='roam';a.tool='arrow';a.idleFor+=dt;
      if(a.idleFor>a.patience && agents.filter(c=>c.mode!=='leave').length>keep && !available().length){
        a.mode='leave';a.flight=makeFlight(a,{x:a.x>width/2?width+45:-45,y:clamp(a.y+random(-100,100),40,height-40)},{speed:.75,bend:random(-65,65)});a.flightTime=0;continue;
      }
      if(a.readyAt>time)continue;
      if(!a.flight){
        const anchors=tasks.filter(t=>t.state==='done'&&t.box.bottom>40&&t.box.top<height-40);
        const near=anchors.length&&Math.random()<.6?anchors[Math.floor(Math.random()*anchors.length)].box:null;
        const target=near?{x:clamp(near.left+random(.1,.9)*near.width,40,width-40),y:clamp(near.top+near.height+random(15,55),50,height-55)}:
          {x:random(.12,.88)*width,y:random(.17,.83)*height};
        a.flight=makeFlight(a,target,{speed:random(.4,.65),bend:random(-90,90)});a.flightTime=0;
      }
      a.flightTime+=dt*config.speed;place(a,sampleFlight(a.flight,a.flightTime/a.flight.duration),dt);
      if(a.flightTime>=a.flight.duration){a.flight=null;a.readyAt=time+random(.25,1.1);}
    }
  }
  function resize() {
    width = innerWidth; height = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  }
  function selection(t) {
    if (!['work','review'].includes(t.stage)) return;
    const b = t.box, p = t.progress;
    if (b.bottom < 0 || b.top > height) return;
    ctx.save(); ctx.strokeStyle = '#128aff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 1;
    if (t.type === 'path') {
      const pt = point(t, p); ctx.beginPath(); ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else {
      const w = t.type === 'rect' ? b.width * p : b.width, h = t.type === 'rect' ? b.height * p : b.height;
      ctx.strokeRect(b.x, b.y, w, h);
      for (const [x,y] of [[b.x,b.y],[b.x+w,b.y],[b.x,b.y+h],[b.x+w,b.y+h]]) { ctx.fillRect(x-3,y-3,6,6); ctx.strokeRect(x-3,y-3,6,6); }
      if (t.type !== 'text') {
        const label = `${Math.round(w)} × ${Math.round(h)}`; ctx.font = '10px ui-monospace, monospace';
        const lw = ctx.measureText(label).width + 12; ctx.fillStyle = '#128aff'; ctx.fillRect(b.x + w/2-lw/2,b.y+h+7,lw,18);
        ctx.fillStyle = '#fff'; ctx.fillText(label,b.x+w/2-lw/2+6,b.y+h+20);
      } else {
        const caret=t.caret;
        if(caret&&t.stage==='work'){
          ctx.strokeStyle='#20252b';ctx.beginPath();ctx.moveTo(caret.x,caret.y-18);ctx.lineTo(caret.x,caret.y+2);ctx.stroke();
        }
      }
      if(t.type==='rect'&&p>.76){
        ctx.save();ctx.strokeStyle='#f4776080';ctx.setLineDash([3,4]);ctx.beginPath();
        ctx.moveTo(b.x-30,b.y+h);ctx.lineTo(b.x+w+35,b.y+h);ctx.moveTo(b.x+w,b.y-25);ctx.lineTo(b.x+w,b.y+h+32);ctx.stroke();ctx.restore();
      }
    }
    ctx.restore();
  }
  function drawCursor(a) {
    if (a.x < -50 || a.x > width+50 || a.y < -50 || a.y > height+50) return;
    ctx.save();ctx.translate(a.x,a.y);ctx.rotate(a.angle);const scale=1-(a.press||0)*.12;ctx.scale(scale,scale);
    ctx.lineWidth=1.5;ctx.lineJoin='round';ctx.lineCap='round';ctx.strokeStyle='#fff';ctx.fillStyle=a.color;
    ctx.shadowColor='rgba(0,0,0,.28)';ctx.shadowBlur=2;ctx.shadowOffsetY=1;
    const clearShadow=()=>{ctx.shadowColor='transparent';};
    const outlineTool=()=>{
      ctx.lineWidth=3.6;ctx.strokeStyle='#fff';ctx.stroke();clearShadow();
      ctx.lineWidth=1.5;ctx.strokeStyle=a.color;ctx.stroke();
    };
    const tool = a.tool || 'arrow';
    ctx.beginPath();
    if (tool === 'text') {
      ctx.moveTo(-3.5,-7.5);ctx.lineTo(-1.8,-7.5);ctx.quadraticCurveTo(0,-7.5,0,-5.7);
      ctx.quadraticCurveTo(0,-7.5,1.8,-7.5);ctx.lineTo(3.5,-7.5);
      ctx.moveTo(0,-5.7);ctx.lineTo(0,5.7);
      ctx.moveTo(-3.5,7.5);ctx.lineTo(-1.8,7.5);ctx.quadraticCurveTo(0,7.5,0,5.7);
      ctx.quadraticCurveTo(0,7.5,1.8,7.5);ctx.lineTo(3.5,7.5);outlineTool();
    } else if (tool === 'rect') {
      ctx.moveTo(-8.5,0);ctx.lineTo(8.5,0);ctx.moveTo(0,-8.5);ctx.lineTo(0,8.5);outlineTool();
    } else if (tool === 'path') {
      // A separate barrel and nib, with the nib tip exactly at the work point.
      ctx.moveTo(14.2,7.6);ctx.lineTo(17.6,10.8);ctx.lineTo(10.8,17.6);ctx.lineTo(7.6,14.2);ctx.closePath();ctx.fill();ctx.stroke();
      ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(9.9,3.3);ctx.lineTo(14.2,7.6);ctx.lineTo(7.6,14.2);ctx.lineTo(3.3,9.9);ctx.closePath();ctx.fill();ctx.stroke();
      clearShadow();ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(.8,.8);ctx.lineTo(5.6,5.6);ctx.stroke();
      ctx.beginPath();ctx.arc(7.2,7.2,1.65,0,Math.PI*2);ctx.stroke();
    } else {
      // Compact, rounded pointer: no projecting stem; the tip remains the hotspot.
      ctx.moveTo(1.25,.35);
      ctx.bezierCurveTo(.15,-.15,-.45,.55,-.05,1.6);
      ctx.lineTo(5.8,17.1);
      ctx.bezierCurveTo(6.2,18.1,7.45,17.9,7.7,16.8);
      ctx.lineTo(9.25,10.6);ctx.quadraticCurveTo(9.5,9.5,10.6,9.25);
      ctx.lineTo(16.8,7.7);ctx.bezierCurveTo(17.9,7.45,18.1,6.2,17.1,5.8);
      ctx.closePath();ctx.fill();ctx.stroke();
    }
    ctx.restore();
  }
  function tick(now) {
    frame = 0;
    if (destroyed || document.hidden || disabled()) return;
    try {
      const dt = Math.min((now - (last || now)) / 1000, .05); last = now; time += dt;
      const scrollDelta=scrollY-previousScroll;previousScroll=scrollY;
      scrollSpeed=Math.max(scrollSpeed*Math.exp(-dt*2),Math.abs(scrollDelta)/Math.max(dt,.001));
      tempo=1.1+Math.min(.8,scrollSpeed/1800);
      if(phase==='building'&&scrollDelta){
        for(const a of agents){
          a.y-=scrollDelta;
          if(a.task?.flight)a.task.flight.from.y-=scrollDelta;
          if(a.flight){a.flight.from.y-=scrollDelta;a.flight.to.y-=scrollDelta;}
          if(!a.task&&a.mode==='roam'&&(a.y<-80||a.y>height+80)){a.flight=null;a.readyAt=0;}
        }
      }
      if (refreshNeeded) { refreshNeeded = false; discover(); if (phase === 'following' && tasks.some(t => t.state === 'pending')) phase = 'building'; }
      for (const t of tasks) if (!t.el.isConnected && t.state !== 'done') complete(t);
      if (dirty) { for (const t of tasks) geometry(t); dirty = false; }
      if (phase === 'building' && activeStart) {
        frontier = Math.max(frontier, scrollY + height + 100);
        assign(); for (const a of agents) if (a.task) advance(a.task, dt);
        if (tasks.every(t => t.state === 'done')&&!agents.some(a=>a.mode==='withdraw')) phase = 'following';
      }
      if(phase==='intro'||phase==='following'){
        if(phase==='following')recruit();
        for(const a of agents){a.mode='flock';a.tool='arrow';a.flight=null;}
        const center=phase==='intro'?{x:width/2,y:height/2}:pointer||{x:width*(.5+.2*Math.sin(time*.35)),y:height*(.5+.22*Math.cos(time*.43))};
        stepFlock(agents,center,dt,time,{width,height,radius:phase==='intro'?105:config.radius,pointer});
      }else roam(dt);
      ctx.clearRect(0,0,width,height);
      for (const a of agents) if (a.task) selection(a.task);
      for (const a of agents) drawCursor(a);
      if (phase === 'intro' && config.start === 'interaction' && pointer && agents.some(a => Math.hypot(a.x-pointer.x,a.y-pointer.y)<55)) start();
    } catch (err) { console.warn('[cursor-swarm] Revealing content after animation error.', err); finish(); }
    wake();
  }
  function wake() { if (!frame && !destroyed && !document.hidden && !disabled()) frame = requestAnimationFrame(tick); }
  function start() {
    if(destroyed||disabled())return;
    if(!activeStart)for(const a of agents){a.mode='roam';a.flight=null;a.idleFor=0;a.readyAt=time;}
    activeStart=true;phase='building';dirty=true;wake();
  }
  function finish() {
    if (destroyed) return;
    for (const t of tasks) complete(t);
    for (const el of [...managed.keys()]) restore(el);
    activeStart = true; phase = disabled() ? 'reduced' : 'following';
    ctx.clearRect(0,0,width,height); wake();
  }
  function replay() {
    if (destroyed) return;
    for (const t of tasks) complete(t);
    tasks = []; byElement.clear(); frontier = 0; discover();
    resetCrew(); phase = disabled() ? 'reduced' : config.intro ? 'intro' : 'building';
    activeStart = false; last=0; time=0;recruitAt=0;scrollSpeed=0;previousScroll=scrollY;
    if (config.start === 'auto') start(); else wake();
  }
  function refresh() { if (!destroyed) { refreshNeeded=true; if (disabled()) { discover(); finish(); } else wake(); } }
  function getState({detailed=false}={}) {
    const state={phase,total:tasks.length,done:tasks.filter(t=>t.state==='done').length,active:tasks.filter(t=>t.state==='active').length,
      pending:tasks.filter(t=>t.state==='pending').length,cursorCount:disabled()||destroyed?0:agents.length};
    if(detailed)state.cursors=disabled()||destroyed?[]:agents.map(a=>({id:a.id,x:a.x,y:a.y,mode:a.mode,tool:a.tool,
      taskId:a.task?.id??null,stage:a.task?.stage??null,worked:a.worked}));
    return state;
  }
  function destroy() {
    if (destroyed) return;
    finish(); destroyed=true; phase='destroyed'; cancelAnimationFrame(frame); frame=0;
    listeners.forEach(off=>off()); observer.disconnect(); resizeObserver.disconnect();host.remove();mounted.delete(root);
  }
  const api = {start,finish,replay,refresh,destroy,getState};
  const observer = new MutationObserver(records => {
    if (records.some(r => r.type==='childList' || r.type==='characterData')) refresh();
  });
  observer.observe(root,{childList:true,subtree:true,characterData:true});
  const resizeObserver = new ResizeObserver(()=>{dirty=true;}); resizeObserver.observe(root);
  listen(window,'resize',resize,{passive:true});
  listen(document,'scroll',()=>{ dirty=true; if(config.start==='interaction' && !activeStart) start(); },{capture:true,passive:true});
  listen(window,'pointermove',e=>{if(e.pointerType!=='touch') pointer={x:e.clientX,y:e.clientY};},{passive:true});
  listen(document.documentElement,'pointerleave',()=>{pointer=null;});
  listen(window,'pointerdown',()=>{if(config.start==='interaction'&&!activeStart) start();},{passive:true});
  listen(window,'keydown',e=>{if(config.start==='interaction'&&!activeStart&&['Enter',' '].includes(e.key))start();});
  function expose(e) { for(const t of tasks) if(t.el===e.target||t.el.contains(e.target)||e.target.contains(t.el)) complete(t); }
  listen(root,'focusin',expose); listen(root,'pointerdown',expose,{capture:true,passive:true});
  listen(document,'visibilitychange',()=>{cancelAnimationFrame(frame);frame=0;last=0;wake();});
  function preferenceChange(){if(disabled()){cancelAnimationFrame(frame);frame=0;finish();}else{phase='following';last=0;wake();}}
  listen(reduce,'change',preferenceChange);listen(coarse,'change',preferenceChange);
  document.fonts?.ready.then(()=>{if(!destroyed)dirty=true;});
  resize();discover();mounted.set(root,api);
  if(config.start==='auto' && !disabled())start();else wake();
  return api;
}
