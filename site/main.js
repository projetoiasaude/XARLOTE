/* ═══════════════════════════════════════════════════════════════
   XARLOTE — motor da página
   Vanilla JS, zero dependências:
   · vídeo do mascote com transparência (WebGL, MP4 empilhado cor+matte)
   · mascote SVG rigado que "nada" pela página (waypoints por scroll)
   · cenas com scrub (rolar anima, voltar rebobina)
   · reveals, contador R$, parallax, botões magnéticos
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* Número oficial da Xarlote no WhatsApp (só dígitos, DDI 55 + DDD).
   +55 62 98228-0719 */
const WHATSAPP_NUMBER = '5562982280719';
const WHATSAPP_TEXT = 'Oi, Xarlote!';

const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const TAU = Math.PI * 2;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ─── links do WhatsApp ─── */
(function initWaLinks() {
  const valid = /^\d{12,13}$/.test(WHATSAPP_NUMBER);
  if (!valid) console.warn('[xarlote] WHATSAPP_NUMBER ainda não configurado em main.js — CTAs apontam pra #cta.');
  const href = valid
    ? `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(WHATSAPP_TEXT)}`
    : '#cta';
  $$('.js-wa').forEach((a) => {
    a.href = href;
    if (valid) { a.target = '_blank'; a.rel = 'noopener'; }
  });
})();

/* ─── mascote: clona o template pro nadador e pro fallback do herói ─── */
const mascotTpl = $('#mascotTpl');
function mountMascot(slot) {
  if (!slot || slot.querySelector('svg')) return null;
  slot.appendChild(mascotTpl.content.cloneNode(true));
  return slot.querySelector('svg');
}
/* piscadas aleatórias de todos os mascotes montados */
function scheduleBlinks() {
  if (RM) return;
  const tick = () => {
    $$('.x-eyes').forEach((eyes) => {
      if (Math.random() < 0.75) {
        eyes.classList.add('blink');
        setTimeout(() => eyes.classList.remove('blink'), 220);
      }
    });
    setTimeout(tick, 2600 + Math.random() * 3200);
  };
  setTimeout(tick, 1800);
}
scheduleBlinks();

/* ─── mascote 3D com alpha (WebGL) → herói E nadador ───
   O MP4 traz a COR na metade de cima e a MÁSCARA na de baixo; o shader
   recompõe RGBA pré-multiplicado (obrigatório no iOS). UM <video> alimenta
   DOIS canvases (herói grande + nadador pequeno), cada um com seu contexto.
   Fallbacks independentes: herói → mascote SVG; nadador → ícone liquid-glass. */
const heroMascot = $('#heroMascot');
const swimmerEl = $('#swimmer');
/* Nadador = ícone liquid-glass girando (V2, oficial). `?v=1` na URL volta
   ao render 3D do mascote (mantido como alternativa). */
const SWIMMER_V2 = new URLSearchParams(location.search).get('v') !== '1';
if (SWIMMER_V2 && swimmerEl) swimmerEl.classList.add('icon-mode');
let videoEl = null;
let glStop = null;
let drawAlphaOnce = null; // usado pelo watchdog quando o rAF está pausado

function heroFallback() {
  if (glStop) { glStop(); glStop = null; }
  heroMascot.classList.add('fallback-on');
  mountMascot($('.hero-fallback'));
}

function swimmerFallback() {
  swimmerEl.classList.add('fallback-on');
}

/* compila o pipeline de recomposição num canvas; null se não houver GL */
function createGlView(canvas) {
  if (!canvas) return null;
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
  if (!gl) return null;

  const VERT = 'attribute vec2 p;varying vec2 uv;void main(){uv=p*0.5+0.5;gl_Position=vec4(p,0.,1.);}';
  const FRAG = `precision mediump float;varying vec2 uv;uniform sampler2D tex;const float E=0.0012;
    void main(){
      vec3 c=texture2D(tex,vec2(uv.x,mix(0.5+E,1.0-E,uv.y))).rgb;
      float a=texture2D(tex,vec2(uv.x,mix(E,0.5-E,uv.y))).r;
      a=smoothstep(0.16,0.78,a);
      gl_FragColor=vec4(c*a,a);
    }`;
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  // o contexto nasce com o tamanho que o canvas tinha — trava o viewport
  // no buffer real (sem isto o render sai encolhido no canto)
  gl.viewport(0, 0, canvas.width, canvas.height);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.clearColor(0, 0, 0, 0);

  return {
    canvas,
    dead: false,
    draw(video) {
      if (this.dead) return false;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    },
  };
}

function initAlphaVideo() {
  if (RM) { heroFallback(); swimmerFallback(); return; }

  const heroCanvas = $('#alphaCanvas');
  heroCanvas.width = 720; heroCanvas.height = 720;
  const heroView = createGlView(heroCanvas);
  if (!heroView) { heroFallback(); swimmerFallback(); return; }

  let swimView = SWIMMER_V2 ? null : createGlView($('.sw-canvas'));
  if (!swimView && !SWIMMER_V2) swimmerFallback();

  const video = document.createElement('video');
  video.muted = true; video.defaultMuted = true; video.loop = true;
  video.autoplay = true; video.playsInline = true;
  video.setAttribute('muted', ''); video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'auto';
  video.src = 'assets/xarlote-alpha.mp4';
  videoEl = video;

  let raf = 0, uploaded = false, dead = false, frames = 0;

  const drawViews = () => {
    if (video.readyState < 2) return;
    // herói: só enquanto está (quase) em cena
    if (window.scrollY <= window.innerHeight * 1.3) {
      heroView.draw(video);
      uploaded = true;
    }
    // nadador: só quando visível
    if (swimView && !swimView.dead && sw.o > 0.04) {
      swimView.draw(video);
      uploaded = true;
    }
  };
  drawAlphaOnce = drawViews;

  const draw = () => {
    if (dead) return;
    raf = requestAnimationFrame(draw);
    if (video.readyState < 2) return;
    // autoplay pode ter sido bloqueado sem disparar erro — re-tenta de vez em quando
    if (video.paused && (frames++ % 90 === 0)) video.play().catch(() => {});
    drawViews();
  };

  const fail = () => { if (!dead) { stop(); heroFallback(); swimmerFallback(); } };
  const retryPlay = () => video.play().catch(() => {});
  const onVis = () => {
    if (document.visibilityState === 'visible') video.play().catch(() => {});
    else video.pause();
  };
  const onHeroLost = (e) => { e.preventDefault(); fail(); };
  const onSwimLost = (e) => {
    e.preventDefault();
    if (swimView) swimView.dead = true;
    swimView = null;
    swimmerFallback();
  };

  video.addEventListener('error', fail);
  heroCanvas.addEventListener('webglcontextlost', onHeroLost);
  if (swimView) swimView.canvas.addEventListener('webglcontextlost', onSwimLost);
  document.addEventListener('visibilitychange', onVis);
  video.play().catch(() => window.addEventListener('pointerdown', retryPlay, { once: true }));
  draw();

  // guarda: rede lenta ganha tempo enquanto progride; 404/codec → fallback
  let tries = 0, guard = 0;
  const armGuard = () => {
    guard = setTimeout(() => {
      if (uploaded || dead) return;
      const progressing = video.readyState >= 1 || video.networkState === HTMLMediaElement.NETWORK_LOADING;
      if (progressing && tries < 4) { tries += 1; armGuard(); }
      else fail();
    }, 2500);
  };
  armGuard();

  function stop() {
    dead = true;
    drawAlphaOnce = null;
    cancelAnimationFrame(raf);
    clearTimeout(guard);
    window.removeEventListener('pointerdown', retryPlay);
    document.removeEventListener('visibilitychange', onVis);
    heroCanvas.removeEventListener('webglcontextlost', onHeroLost);
    video.removeEventListener('error', fail);
    video.pause(); video.src = '';
  }
  glStop = stop;
}
initAlphaVideo();

/* ═══════════════════════════════════════════════════════════════
   MOTOR DE SCROLL (um rAF só pra tudo)
   ═══════════════════════════════════════════════════════════════ */

const nav = $('#nav');
const tintEl = $('.tint');
const auroraEl = $('.aurora');
const hero = $('#hero');
const heroStage = $('#heroStage');
const scrollHint = $('.scroll-hint');
const swimmer = $('#swimmer');
const swBob = $('.sw-bob');
const swSvgWrap = $('#swimmer .sw-svg');
const swMascot = swSvgWrap ? swSvgWrap.querySelector('svg') : null;

let vw = window.innerWidth, vh = window.innerHeight;
let docH = 0, maxScroll = 1, heroH = 1;

/* ─── cenas ─── */

const scenes = $$('[data-scene]').map((el) => {
  const s = { el, type: el.dataset.scene, top: 0, len: 1, target: 0, value: -1 };
  if (s.type === 'chat') {
    s.msgs = $$('.msg', el).map((m) => ({ el: m, at: +m.dataset.at, typed: m.classList.contains('typed') }));
    s.presence = $('[data-presence]', el);
    s.steps = $$('.steps li', el);
    s.chips = $$('.chip', el);
    s.phone = $('.phone', el);
  } else if (s.type === 'reminders') {
    s.clock = $('#bigClock', el);
    s.toasts = $$('.toast', el).map((t) => ({
      el: t, at: +t.dataset.at,
      reply: $('.t-reply', t),
      replyAt: $('.t-reply', t) ? +$('.t-reply', t).dataset.at2 : 0,
    }));
    s.lastClock = '';
  } else if (s.type === 'memory') {
    s.mems = $$('.mem', el);
  }
  return s;
});

const CLOCK_KEYS = [[0, 430], [0.12, 480], [0.40, 840], [0.62, 1200], [1, 1200]];

function clockAt(p) {
  let a = CLOCK_KEYS[0], b = CLOCK_KEYS[CLOCK_KEYS.length - 1];
  for (let i = 0; i < CLOCK_KEYS.length - 1; i++) {
    if (p >= CLOCK_KEYS[i][0] && p <= CLOCK_KEYS[i + 1][0]) { a = CLOCK_KEYS[i]; b = CLOCK_KEYS[i + 1]; break; }
  }
  const t = b[0] === a[0] ? 1 : (p - a[0]) / (b[0] - a[0]);
  const mins = Math.round(lerp(a[1], b[1], t));
  const h = String(Math.floor(mins / 60)).padStart(2, '0');
  const m = String(mins % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function popIn(el, p, at, win = 0.075) {
  const t = clamp((p - at) / win, 0, 1);
  const e = easeOutCubic(t);
  el.style.opacity = String(Math.min(1, t * 2.2));
  el.style.transform = `translateY(${(1 - e) * 24}px) scale(${0.92 + 0.08 * e})`;
  return t;
}

function applyChat(s, p) {
  let typing = false;
  for (const m of s.msgs) {
    const t = popIn(m.el, p, m.at);
    // fora do fluxo até chegar a vez: mensagem nova EMPURRA as anteriores,
    // como num chat de verdade (e sem buraco embaixo)
    const disp = t <= 0 ? 'none' : '';
    if (m.el.style.display !== disp) m.el.style.display = disp;
    if (m.typed) {
      const done = t > 0.62;
      m.el.classList.toggle('done', done);
      if (t > 0.02 && !done) typing = true;
    }
  }
  if (s.presence) {
    const label = typing ? 'digitando…' : 'online';
    if (s.presence.textContent !== label) {
      s.presence.textContent = label;
      s.presence.classList.toggle('typing', typing);
    }
  }
  const idx = p < 0.27 ? 0 : p < 0.62 ? 1 : 2;
  s.steps.forEach((li, i) => {
    li.classList.toggle('active', i === idx);
    li.classList.toggle('done', i < idx);
  });
  const speeds = [-70, 52, -48, 62];
  s.chips.forEach((c, i) => {
    const vis = clamp((p - 0.07) / 0.1, 0, 1) * clamp((0.96 - p) / 0.08, 0, 1);
    c.style.opacity = String(vis * 0.95);
    c.style.transform = `translateY(${(p - 0.5) * speeds[i % speeds.length]}px)`;
  });
}

function applyReminders(s, p) {
  const label = clockAt(p);
  if (label !== s.lastClock) { s.lastClock = label; s.clock.textContent = label; }
  for (const t of s.toasts) {
    popIn(t.el, p, t.at, 0.07);
    if (t.reply) {
      const r = clamp((p - t.replyAt) / 0.05, 0, 1);
      const e = easeOutCubic(r);
      t.reply.style.opacity = String(r);
      t.reply.style.transform = `scale(${0.6 + 0.4 * e})`;
    }
  }
}

function applyMemory(s, p) {
  const n = s.mems.length;
  const rx = clamp(Math.min(vw * 0.5 - 96, vw * 0.34), 86, 330);
  const ry = clamp(vh * 0.19, 68, 190);
  s.mems.forEach((m, i) => {
    const enter = clamp((p * 1.3 - i * 0.05) / 0.42, 0, 1);
    const e = easeOutCubic(enter);
    const ang0 = (i / n) * TAU - 1.2;
    const ang = ang0 + p * 0.85;
    const tx = Math.cos(ang) * rx;
    const ty = Math.sin(ang) * ry;
    const sx = Math.cos(ang0) * rx * 3.4;
    const sy = Math.sin(ang0) * ry * 3.8;
    const x = lerp(sx, tx, e);
    const y = lerp(sy, ty, e);
    const back = Math.sin(ang) < 0; // metade de cima da elipse = atrás
    m.style.opacity = String(Math.min(1, enter * 1.8) * (back ? 0.82 : 1));
    m.style.zIndex = back ? '1' : '3';
    m.style.transform =
      `translate(-50%,-50%) translate3d(${x}px,${y}px,0) scale(${(0.72 + 0.28 * e) * (back ? 0.9 : 1)})`;
  });
}

/* ─── nadador: waypoints ao longo do documento ─── */

let waypoints = [];

function docTop(el) { return el.getBoundingClientRect().top + window.scrollY; }

function buildWaypoints() {
  const secs = {};
  ['compra', 'lembretes', 'memoria', 'alem', 'familia', 'gratis', 'cta'].forEach((id) => {
    const el = document.getElementById(id);
    secs[id] = { top: docTop(el), h: el.offsetHeight, el };
  });
  const desk = vw >= 920;
  const dock = $('.finale-dock');
  const dockCenter = docTop(dock) + dock.offsetHeight / 2;
  const dockAt = clamp(dockCenter - vh * 0.45, 0, maxScroll);
  const dockY = clamp(((dockCenter - dockAt) / vh) * 100, 18, 60);

  // centro real da órbita (varia com o viewport) → % do pin travado
  const orbitEl = $('#orbit');
  const orbitPin = orbitEl.closest('.scene-pin');
  const orbitY = clamp(((orbitEl.offsetTop + orbitEl.offsetHeight / 2) / orbitPin.offsetHeight) * 100, 30, 78);

  waypoints = [
    { at: 0, x: 50, y: 44, s: 1.0, o: 0 },
    { at: heroH * 0.5, x: 50, y: 40, s: 0.95, o: 0 },
    { at: heroH * 0.78, x: desk ? 70 : 68, y: 30, s: 0.9, o: 1 },
    { at: secs.compra.top + secs.compra.h * 0.18, x: desk ? 8 : 10, y: 32, s: 0.82, o: 1 },
    { at: secs.compra.top + secs.compra.h * 0.6, x: desk ? 12 : 12, y: 60, s: 0.78, o: 1 },
    { at: secs.lembretes.top + secs.lembretes.h * 0.18, x: desk ? 82 : 80, y: 26, s: 0.8, o: 1 },
    { at: secs.lembretes.top + secs.lembretes.h * 0.62, x: desk ? 85 : 84, y: 58, s: 0.78, o: 1 },
    { at: secs.memoria.top + secs.memoria.h * 0.3, x: 50, y: orbitY, s: 1.08, o: 1 },
    { at: secs.memoria.top + secs.memoria.h * 0.82, x: 50, y: orbitY, s: 1.08, o: 1 },
    { at: secs.alem.top + secs.alem.h * 0.5 - vh * 0.5, x: desk ? 88 : 84, y: 20, s: 0.7, o: 1 },
    { at: secs.familia.top + secs.familia.h * 0.5 - vh * 0.5, x: 50, y: 22, s: 0.82, o: 1 },
    { at: secs.gratis.top + secs.gratis.h * 0.55 - vh * 0.5, x: desk ? 13 : 12, y: 30, s: 0.75, o: 1 },
    { at: dockAt, x: 50, y: dockY, s: 1.45, o: 1 },
    // depois de docar, ancora no documento: o mascote sobe junto com o CTA
    // quando o rodapé entra (senão ele flutua por cima do texto do footer)
    { at: maxScroll, x: 50, y: ((dockCenter - maxScroll) / vh) * 100, s: 1.45, o: 1 },
  ].sort((a, b) => a.at - b.at);
}

function waypointAt(y) {
  if (!waypoints.length) return { x: 50, y: 44, s: 1, o: 0 };
  if (y <= waypoints[0].at) return waypoints[0];
  const last = waypoints[waypoints.length - 1];
  if (y >= last.at) return last;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i], b = waypoints[i + 1];
    if (y >= a.at && y <= b.at) {
      const t = easeInOutSine((y - a.at) / Math.max(1, b.at - a.at));
      return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), s: lerp(a.s, b.s, t), o: lerp(a.o ?? 1, b.o ?? 1, t) };
    }
  }
  return last;
}

const sw = { x: 0, y: 0, s: 1, o: 0, dir: 1, rot: 0, swiftUntil: 0 };

function applySwimmer(scrollY, now, hard) {
  if (!swimmer || RM) return;
  const t = waypointAt(scrollY);
  const swW = clamp(vw * 0.085, 62, 116);
  swimmer.style.setProperty('--sw', `${swW}px`);
  const txp = (t.x / 100) * vw - swW / 2;
  const typ = (t.y / 100) * vh - swW / 2;

  const px = sw.x, py = sw.y;
  const kp = hard ? 1 : 0.085;
  sw.x = lerp(sw.x, txp, kp);
  sw.y = lerp(sw.y, typ, kp);
  sw.s = lerp(sw.s, t.s, hard ? 1 : 0.09);
  sw.o = lerp(sw.o, t.o, hard ? 1 : 0.12);

  const vx = sw.x - px, vy = sw.y - py;
  if (Math.abs(vx) > 0.6) sw.dir = vx < 0 ? -1 : 1;
  const targetRot = clamp(vy * 0.6, -22, 22);
  sw.rot = lerp(sw.rot, targetRot, 0.12);

  const speed = Math.abs(vx) + Math.abs(vy);
  if (speed > 3.2) sw.swiftUntil = now + 450;
  if (swMascot) swMascot.classList.toggle('swift', now < sw.swiftUntil);

  swimmer.classList.toggle('on', sw.o > 0.06);
  swimmer.style.transform = `translate3d(${sw.x}px, ${sw.y}px, 0)`;
  swimmer.style.opacity = String(sw.o);
  // v2 (ícone): sem espelhar — o giro 3D é contínuo; só inclina e escala
  swSvgWrap.style.transform = SWIMMER_V2
    ? `rotate(${sw.rot}deg) scale(${sw.s})`
    : `rotate(${sw.rot * sw.dir}deg) scale(${sw.s * sw.dir}, ${sw.s})`;
}

/* easter egg: clica no mascote → festinha */
if (swSvgWrap) {
  swSvgWrap.addEventListener('click', () => {
    if (!swMascot) return;
    swBob.classList.remove('happy');
    void swBob.offsetWidth; // reinicia a animação
    swBob.classList.add('happy');
    const hearts = $('.sw-hearts');
    for (let i = 0; i < 6; i++) {
      const h = document.createElement('span');
      h.textContent = ['💜', '💙', '💖'][i % 3];
      h.style.setProperty('--hx', `${(Math.random() - 0.5) * 90}px`);
      h.style.setProperty('--hr', `${(Math.random() - 0.5) * 50}deg`);
      h.style.animationDelay = `${i * 55}ms`;
      hearts.appendChild(h);
      setTimeout(() => h.remove(), 1400);
    }
  });
}

/* ─── parallax do ponteiro (desktop) ─── */
const FINE = window.matchMedia('(pointer: fine)').matches;
const par = { tx: 0, ty: 0, x: 0, y: 0 };
if (FINE && !RM) {
  window.addEventListener('pointermove', (e) => {
    par.tx = (e.clientX / vw - 0.5) * 2;
    par.ty = (e.clientY / vh - 0.5) * 2;
  }, { passive: true });
}

/* ─── medidas ─── */
function measure() {
  vw = window.innerWidth; vh = window.innerHeight;
  docH = document.documentElement.scrollHeight;
  maxScroll = Math.max(1, docH - vh);
  heroH = hero.offsetHeight;
  for (const s of scenes) {
    s.top = docTop(s.el);
    s.len = Math.max(1, s.el.offsetHeight - vh);
  }
  buildWaypoints();
}

/* ─── loop principal ───
   rAF é o caminho feliz; um watchdog em setInterval assume quando o
   navegador pausa rAF (aba oculta/preview) aplicando os alvos direto. */
let lastNavScrolled = null;
let lastFrameAt = 0;

function frame(now) {
  lastFrameAt = now;
  requestAnimationFrame(frame);
  step(now, false);
}

function step(now, hard) {
  const y = window.scrollY;

  // nav
  const scrolled = y > 30;
  if (scrolled !== lastNavScrolled) {
    lastNavScrolled = scrolled;
    nav.classList.toggle('scrolled', scrolled);
  }

  // tint global (azul → roxo → rosa conforme desce)
  const g = clamp(y / maxScroll, 0, 1);
  tintEl.style.setProperty('--hue', String(Math.round(236 + g * 74)));

  // herói: sai de cena + parallax do mouse
  const hp = clamp(y / (heroH * 0.85), 0, 1);
  par.x = lerp(par.x, par.tx, 0.06);
  par.y = lerp(par.y, par.ty, 0.06);
  heroStage.style.transform =
    `translate3d(${par.x * 10}px, ${hp * -64 + par.y * 8}px, 0) scale(${1 - hp * 0.16})`;
  heroStage.style.opacity = String(clamp(1 - hp * 1.3, 0, 1));
  if (scrollHint) scrollHint.style.opacity = String(clamp(1 - hp * 4, 0, 1));
  if (auroraEl && FINE) auroraEl.style.transform = `translate3d(${par.x * -16}px, ${par.y * -10}px, 0)`;

  // cenas (scrub suavizado)
  for (const s of scenes) {
    s.target = clamp((y - s.top) / s.len, 0, 1);
    const next = hard || Math.abs(s.target - s.value) < 0.0004
      ? s.target
      : lerp(s.value, s.target, 0.16);
    if (next === s.value) continue;
    s.value = next;
    if (s.type === 'chat') applyChat(s, next);
    else if (s.type === 'reminders') applyReminders(s, next);
    else if (s.type === 'memory') applyMemory(s, next);
  }

  applySwimmer(y, now, hard);
  // rAF pausado (aba oculta): mantém os canvases do mascote atualizados
  if (hard && drawAlphaOnce) drawAlphaOnce();
}

/* ─── reveals + contador + barra de CTA ─── */

function initObservers() {
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        en.target.classList.add('in');
        io.unobserve(en.target);
      }
    }
  }, { threshold: 0.2, rootMargin: '0px 0px -6% 0px' });
  $$('.reveal').forEach((el) => io.observe(el));

  // contador R$ 149 → R$ 0
  const price = $('#price');
  if (price) {
    const from = +price.dataset.from || 149;
    const pio = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      pio.disconnect();
      if (RM) { price.textContent = 'R$ 0'; return; }
      const t0 = performance.now();
      const dur = 1500;
      let iv = 0;
      const run = () => {
        const t = clamp((performance.now() - t0) / dur, 0, 1);
        price.textContent = `R$ ${Math.round(lerp(from, 0, easeOutExpo(t)))}`;
        if (t < 1) requestAnimationFrame(run);
        else { price.textContent = 'R$ 0'; clearInterval(iv); }
      };
      // intervalo de retaguarda: completa o contador mesmo com rAF pausado
      iv = setInterval(() => {
        if (performance.now() - t0 >= dur) { price.textContent = 'R$ 0'; clearInterval(iv); }
      }, 250);
      requestAnimationFrame(run);
    }, { threshold: 0.5 });
    pio.observe(price);
  }

  // barra fixa mobile: aparece depois do herói, some no CTA final
  const ctabar = $('#ctabar');
  let pastHero = false, inFinale = false;
  const upd = () => ctabar.classList.toggle('show', pastHero && !inFinale);
  new IntersectionObserver((e) => { pastHero = !e[0].isIntersecting; upd(); }, { threshold: 0.12 })
    .observe(hero);
  new IntersectionObserver((e) => { inFinale = e[0].isIntersecting; upd(); }, { threshold: 0.25 })
    .observe($('#cta'));
}

/* ─── botões magnéticos + brilho dos cards (desktop) ─── */
function initPointerFlair() {
  if (!FINE || RM) return;
  $$('.magnetic').forEach((btn) => {
    btn.addEventListener('pointermove', (e) => {
      const r = btn.getBoundingClientRect();
      const dx = (e.clientX - r.left - r.width / 2) * 0.18;
      const dy = (e.clientY - r.top - r.height / 2) * 0.3;
      btn.style.transform = `translate(${clamp(dx, -7, 7)}px, ${clamp(dy, -6, 6)}px)`;
    });
    btn.addEventListener('pointerleave', () => { btn.style.transform = ''; });
  });
  $$('.card').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
      card.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
    });
  });
}

/* ─── boot ─── */

function boot() {
  initObservers();
  initPointerFlair();

  if (RM) {
    document.documentElement.classList.add('no-motion');
    // estados finais, sem motor
    $$('.msg').forEach((m) => { m.style.opacity = '1'; m.style.transform = 'none'; m.classList.add('done'); });
    $$('.toast, .t-reply, .mem').forEach((el) => { el.style.opacity = '1'; el.style.transform = 'none'; });
    const clock = $('#bigClock'); if (clock) clock.textContent = '20:00';
    $$('.steps li').forEach((li) => li.classList.add('active'));
    return; // sem rAF-loop, sem nadador
  }

  measure();
  requestAnimationFrame(frame);
  setInterval(() => {
    const now = performance.now();
    if (now - lastFrameAt > 240) step(now, true);
  }, 200);

  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(measure, 160); }, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(measure, 300), { passive: true });
  window.addEventListener('load', measure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  setTimeout(measure, 900);
}

boot();

console.log(
  '%c🌊 oi! eu sou a xarlote 💜',
  'font-size:18px;font-weight:bold;background:linear-gradient(90deg,#7da2ff,#f7a8f0);color:#0a0a20;padding:6px 14px;border-radius:99px',
  '\ncuriosidade é sinal de saúde. manda um “oi” pra mim no WhatsApp :)'
);
