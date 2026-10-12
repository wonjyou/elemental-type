'use strict';
/*
 * Elemental Type — a WebGL2 particle engine that builds words out of matter.
 *
 * Pipeline
 *  1. CPU simulation (typed arrays): every particle owns a target point sampled
 *     from the word's glyphs, plus a small state machine (falling / attached /
 *     detached) whose forces depend on the material it currently "is".
 *  2. Particle pass: instanced quads, stretched along velocity, splatted with
 *     additive blending into two half-float targets (MRT):
 *        acc = (color·w, w)         aux = (goo, additive, opacity, metal)·w
 *  3. Composite pass: per pixel, blends three looks by the weighted material
 *     properties — opaque grains, additive glow, and a metaball "liquid"
 *     surface (threshold + gradient normals → refraction, specular, chrome).
 *
 * Morphing: each particle carries (from, to, t). Switching material gives each
 * particle a staggered delay (sweeping left→right), so its look and physics
 * change one particle at a time while the per-pixel compositor melts between
 * grains, glow and liquid.
 */
(() => {
  const $ = (s) => document.querySelector(s);
  const hex = (h) => {
    const n = parseInt(h.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const rnd = Math.random;

  // ---------------------------------------------------------------- materials
  // A: radius(px), size variance, velocity streak, softness (0 hard grain → 1 gaussian)
  // B: goo (liquid surface), additive glow, liquid opacity, metallic
  const MATS = [
    { id: 'water', label: 'Water', word: 'Water',
      A: [5.5, 0.6, 1.6, 1], B: [1, 0, 0.22, 0], alpha: 1, colorMode: 0,
      pal: ['#3d9bff', '#7fd0ff', '#d9f6ff'],
      bg: { top: '#03101a', bot: '#0a2b3c', glow: '#2a8fb8', bokeh: 1.0 },
      push: 3500, drag: 1.2, knock: 1 },
    { id: 'sand', label: 'Sand', word: 'Desert',
      A: [2.0, 0.6, 0.2, 0.1], B: [0, 0, 1, 0], alpha: 1, colorMode: 0,
      pal: ['#a2562a', '#dca05a', '#f7dba0'],
      bg: { top: '#1a1026', bot: '#6b3326', glow: '#ff9a4a', bokeh: 0.25 },
      push: 9000, drag: 1.6, knock: 1 },
    // hidden: kept in the engine but left out of the picker for now
    { id: 'gel', label: 'Gel', word: 'Gel', hidden: true,
      A: [10, 0.35, 0.35, 1], B: [1, 0, 0.8, 0], alpha: 1, colorMode: 0,
      pal: ['#00e07a', '#3dffa8', '#d4ff4f'],
      bg: { top: '#0c0618', bot: '#1d0b36', glow: '#8a34e8', bokeh: 0.5 },
      push: 1600, drag: 1.5, knock: 0 },
    { id: 'fire', label: 'Fire', word: 'Fire',
      A: [7, 0.35, 1.4, 1], B: [0, 1, 1, 0], alpha: 0.13, colorMode: 1,
      pal: ['#6a0d00', '#ff5a12', '#fff0b8'],
      bg: { top: '#050304', bot: '#1a0604', glow: '#ff4a12', bokeh: 0.12 },
      push: 6000, drag: 2.5, knock: 1 },
    { id: 'snow', label: 'Snow', word: 'Snow',
      A: [2.6, 0.7, 0.05, 0.75], B: [0, 0.3, 1, 0], alpha: 0.95, colorMode: 0,
      pal: ['#b9d4ff', '#ffffff', '#dfeaff'],
      bg: { top: '#060a18', bot: '#1b2a4a', glow: '#6f95d6', bokeh: 0.6 },
      push: 3500, drag: 1.8, knock: 1 },
    { id: 'mercury', label: 'Mercury', word: 'Mercury',
      A: [11, 0.15, 0.4, 1], B: [1, 0, 1, 1], alpha: 1, colorMode: 0,
      pal: ['#c9d2dc', '#e8edf3', '#ffffff'],
      bg: { top: '#0b0c0f', bot: '#20242b', glow: '#8c98ab', bokeh: 0.35 },
      push: 5000, drag: 2.2, knock: 0 },
  ];
  const M = MATS.length;
  const WATER = 0, SAND = 1, GEL = 2, FIRE = 3, SNOW = 4, MERCURY = 5;

  // System fonts need no download; everything else streams from Google Fonts.
  const SYSTEM_FONTS = [
    { name: 'Arial', weight: 700 }, { name: 'Helvetica', weight: 700 }, { name: 'Impact', weight: 400 },
    { name: 'Georgia', weight: 700 }, { name: 'Times New Roman', weight: 700 }, { name: 'Verdana', weight: 700 },
    { name: 'Trebuchet MS', weight: 700 }, { name: 'Courier New', weight: 700 },
  ];
  const FONTS = [
    'Inter', 'Playfair Display', 'Playfair', 'Roboto', 'Montserrat', 'Poppins', 'Oswald', 'Bebas Neue',
    'Anton', 'Archivo Black', 'Shrikhand', 'Abril Fatface', 'Alfa Slab One', 'Bungee', 'Black Ops One',
    'Bowlby One', 'Chango', 'Cinzel', 'Caveat Brush', 'Creepster', 'DM Serif Display', 'Dela Gothic One',
    'Fraunces', 'Lobster', 'Luckiest Guy', 'Pacifico', 'Permanent Marker', 'Rammetto One', 'Righteous',
    'Rubik', 'Rubik Mono One', 'Russo One', 'Space Grotesk', 'Syne', 'Titan One', 'Ultra',
    'UnifrakturMaguntia', 'Yeseva One', 'Bodoni Moda',
  ];

  // --------------------------------------------------------------------- GL
  const canvas = $('#gl');
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false });
  const fatal = (msg) => { const f = $('#fatal'); f.hidden = false; f.textContent = msg; };
  if (!gl) { fatal('This demo needs WebGL2, which your browser does not provide.'); return; }
  if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
    fatal('This demo needs float render targets (EXT_color_buffer_float).'); return;
  }

  const PARTICLE_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec2 aCorner;
  layout(location=1) in vec4 aPV;   // x, y, vx, vy (css px)
  layout(location=2) in vec4 aD;    // seed, alpha, morph t, heat
  layout(location=3) in vec2 aM;    // material from, to
  uniform vec2 uRes;
  uniform float uScale;
  uniform vec4 uA[${M}];
  uniform vec4 uB[${M}];
  uniform vec4 uC[${M}];
  uniform vec3 uP0[${M}];
  uniform vec3 uP1[${M}];
  uniform vec3 uP2[${M}];
  out vec2 vL;
  out vec3 vCol;
  out float vA;
  out vec4 vB;
  out float vSoft;
  vec3 pal(int m, float s) {
    return s < 0.5 ? mix(uP0[m], uP1[m], s * 2.0) : mix(uP1[m], uP2[m], s * 2.0 - 1.0);
  }
  void main() {
    int f = int(aM.x + 0.5);
    int t = int(aM.y + 0.5);
    float k = aD.z;
    float ks = k * k * (3.0 - 2.0 * k);
    vec4 A = mix(uA[f], uA[t], ks);
    vec4 B = mix(uB[f], uB[t], ks);
    vec4 C = mix(uC[f], uC[t], ks);
    float seed = aD.x;
    float r2 = fract(seed * 91.7 + 0.13);
    float heat = clamp(aD.w, 0.0, 1.0);
    vec3 cf = mix(pal(f, seed), pal(f, heat), uC[f].y);
    vec3 ct = mix(pal(t, seed), pal(t, heat), uC[t].y);
    vec3 col = mix(cf, ct, ks) * (0.82 + 0.36 * r2);
    float pulse = sin(3.14159265 * k);
    float rad = A.x * uScale * (1.0 - A.y * 0.5 + A.y * r2) * (1.0 + pulse * 0.55);
    vec2 v = aPV.zw;
    float sp = length(v);
    vec2 dir = sp > 1.0 ? v / sp : vec2(1.0, 0.0);
    float stretch = 1.0 + A.z * clamp(sp / 500.0, 0.0, 3.0);
    vec2 perp = vec2(-dir.y, dir.x);
    vec2 world = aPV.xy + dir * aCorner.x * rad * stretch + perp * aCorner.y * rad;
    float a = aD.y * C.x;
    gl_Position = a < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0)
                            : vec4(world.x / uRes.x * 2.0 - 1.0, 1.0 - world.y / uRes.y * 2.0, 0.0, 1.0);
    vL = aCorner;
    vCol = col + pulse * 0.18;
    vA = a;
    vB = B;
    vSoft = A.w;
  }`;

  const PARTICLE_FS = `#version 300 es
  precision highp float;
  in vec2 vL;
  in vec3 vCol;
  in float vA;
  in vec4 vB;
  in float vSoft;
  layout(location=0) out vec4 o0;
  layout(location=1) out vec4 o1;
  void main() {
    float d2 = dot(vL, vL);
    if (d2 > 1.0) discard;
    float soft = exp(-d2 * 3.2);
    float hard = 1.0 - smoothstep(0.35, 0.55, d2);
    float k = mix(hard, soft, vSoft) * vA;
    if (k < 0.002) discard;
    o0 = vec4(vCol * k, k);
    o1 = vB * k;
  }`;

  const COMPOSITE_VS = `#version 300 es
  out vec2 vUv;
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vUv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const COMPOSITE_FS = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 o;
  uniform sampler2D uAcc;
  uniform sampler2D uAux;
  uniform vec2 uTexel;
  uniform float uAspect;
  uniform float uTime;
  uniform vec3 uBgTop;
  uniform vec3 uBgBot;
  uniform vec3 uGlow;
  uniform float uBokeh;
  uniform float uFlicker;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  vec3 bgAt(vec2 uv) {
    vec3 c = mix(uBgBot, uBgTop, smoothstep(0.0, 1.0, uv.y));
    vec2 p = (uv - vec2(0.5, 0.55)) * vec2(uAspect, 1.0);
    vec2 q = p * vec2(0.8, 1.7);
    c += uGlow * exp(-dot(q, q) * 2.5) * 0.5 * uFlicker;
    for (int i = 0; i < 8; i++) {
      float fi = float(i);
      vec2 cp = vec2(hash(vec2(fi, 1.3)), hash(vec2(fi, 7.1)));
      cp += 0.04 * vec2(sin(uTime * 0.07 + fi * 1.7), cos(uTime * 0.05 + fi * 2.3));
      float r = 0.04 + 0.08 * hash(vec2(fi, 3.7));
      float d = length((uv - cp) * vec2(uAspect, 1.0));
      c += uGlow * uBokeh * 0.09 * (1.0 - smoothstep(r * 0.72, r, d));
    }
    return c;
  }

  float hgt(vec2 uv) { return 1.0 - exp(-texture(uAcc, uv).a * 0.55); }

  void main() {
    vec4 A = texture(uAcc, vUv);
    vec4 B = texture(uAux, vUv);
    float w = A.a;
    float iw = 1.0 / max(w, 1e-4);
    vec3 col = A.rgb * iw;
    vec4 P = w < 1e-4 ? vec4(0.0) : clamp(B * iw, 0.0, 1.0);
    vec3 bg = bgAt(vUv);

    // grains / flakes: coverage-weighted average colour
    float cover = 1.0 - exp(-w * 2.2);
    vec3 opaque = mix(bg, col, cover);
    // glow: additive, soft tone-mapped
    vec3 glow = bg + (1.0 - exp(-A.rgb * 1.1));
    vec3 outc = mix(opaque, glow, P.y);

    // liquid surface (metaballs)
    if (P.x > 0.001) {
      float h = hgt(vUv);
      float hx = hgt(vUv + vec2(uTexel.x, 0.0)) - hgt(vUv - vec2(uTexel.x, 0.0));
      float hy = hgt(vUv + vec2(0.0, uTexel.y)) - hgt(vUv - vec2(0.0, uTexel.y));
      vec3 N = normalize(vec3(-hx, -hy, 0.22));
      float mask = smoothstep(0.22, 0.32, h);

      vec3 L = normalize(vec3(-0.45, 0.65, 0.62));
      float diff = clamp(dot(N, L), 0.0, 1.0);
      float spec = pow(max(dot(N, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 90.0);
      vec3 L2 = normalize(vec3(0.6, -0.35, 0.72));
      float spec2 = pow(max(dot(N, normalize(L2 + vec3(0.0, 0.0, 1.0))), 0.0), 40.0) * 0.35;
      float edge = 1.0 - N.z;
      float fres = pow(edge, 2.0);

      // translucent liquid: refract the background through the surface
      vec3 refr = bgAt(vUv + N.xy * 0.035) * mix(vec3(1.0), col, 0.7);
      vec3 body = col * (0.45 + 0.8 * diff) * (0.8 + 0.3 * h);
      vec3 liquid = mix(refr, body, P.z);
      liquid *= 1.0 - edge * 0.4;
      liquid += (spec + spec2) * 1.1 + fres * 0.4 * (col * 0.5 + 0.5);

      // chrome: a horizon environment reflected across the surface
      vec3 R = reflect(vec3(0.0, 0.0, -1.0), N);
      float ry = (vUv.y - 0.55) * 2.4 + R.y * 1.3 + 0.05 * sin(R.x * 9.0 + uTime * 0.4);
      vec3 sky = mix(vec3(0.62, 0.7, 0.82), vec3(1.0), smoothstep(0.0, 0.9, ry));
      vec3 gnd = mix(vec3(0.36, 0.32, 0.3), vec3(0.03), smoothstep(0.0, 0.6, -ry));
      vec3 env = ry > 0.0 ? sky : gnd;
      env += vec3(1.0) * exp(-abs(ry) * 40.0) * 0.6; // horizon line
      vec3 metal = env * col * (0.55 + 0.45 * diff) + spec * 1.6 + spec2 + fres * 0.25;

      vec3 goo = mix(liquid, metal, P.w);
      outc = mix(outc, mix(bg, goo, mask), P.x);
    }

    vec2 q = vUv - 0.5;
    outc *= 1.0 - dot(q, q) * 0.7;
    outc += (hash(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.022;
    o = vec4(outc, 1.0);
  }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  const partProg = program(PARTICLE_VS, PARTICLE_FS);
  const compProg = program(COMPOSITE_VS, COMPOSITE_FS);

  // material uniforms (static)
  gl.useProgram(partProg.p);
  {
    const A = new Float32Array(M * 4), B = new Float32Array(M * 4), C = new Float32Array(M * 4);
    const P0 = new Float32Array(M * 3), P1 = new Float32Array(M * 3), P2 = new Float32Array(M * 3);
    MATS.forEach((m, i) => {
      A.set(m.A, i * 4); B.set(m.B, i * 4); C.set([m.alpha, m.colorMode, 0, 0], i * 4);
      P0.set(hex(m.pal[0]), i * 3); P1.set(hex(m.pal[1]), i * 3); P2.set(hex(m.pal[2]), i * 3);
    });
    gl.uniform4fv(partProg.u.uA, A); gl.uniform4fv(partProg.u.uB, B); gl.uniform4fv(partProg.u.uC, C);
    gl.uniform3fv(partProg.u.uP0, P0); gl.uniform3fv(partProg.u.uP1, P1); gl.uniform3fv(partProg.u.uP2, P2);
  }

  // --------------------------------------------------------------- particles
  const STRIDE = 10; // floats per instance
  let N = 0;
  let px, py, vx, vy, tx, ty, eT, eB, seed, life, heat, alpha, delay, touch;
  let state, amb, behav, mFrom, mTo;
  let inst, instBuf, vao;
  const AMBIENT = 0.12;

  function allocate(n) {
    N = n;
    const F = () => new Float32Array(N), U = () => new Uint8Array(N);
    px = F(); py = F(); vx = F(); vy = F(); tx = F(); ty = F(); eT = F(); eB = F();
    seed = F(); life = F(); heat = F(); alpha = F(); delay = F(); touch = F().fill(-100);
    state = U(); amb = U(); behav = U(); mFrom = U(); mTo = U();
    for (let i = 0; i < N; i++) {
      seed[i] = rnd();
      amb[i] = rnd() < AMBIENT ? 1 : 0;
      px[i] = rnd() * W; py[i] = rnd() * H;
      alpha[i] = 1; life[i] = rnd(); heat[i] = 1;
    }
    inst = new Float32Array(N * STRIDE);

    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, inst.byteLength, gl.DYNAMIC_DRAW);
    const bpe = 4;
    [[1, 4, 0], [2, 4, 4], [3, 2, 8]].forEach(([loc, size, off]) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * bpe, off * bpe);
      gl.vertexAttribDivisor(loc, 1);
    });
    gl.bindVertexArray(null);
  }

  // ------------------------------------------------------------ framebuffer
  let fbo = null, texAcc = null, texAux = null, fbW = 0, fbH = 0;
  function makeTex(w, h) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function makeFBO(w, h) {
    if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(texAcc); gl.deleteTexture(texAux); }
    fbW = w; fbH = h;
    texAcc = makeTex(w, h); texAux = makeTex(w, h);
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texAcc, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texAux, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) console.warn('Framebuffer incomplete', w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  const emptyVao = gl.createVertexArray();

  // ------------------------------------------------------------------ layout
  let W = innerWidth, H = innerHeight, DPR = Math.min(devicePixelRatio || 1, 2);
  function resizeCanvas() {
    W = Math.max(1, innerWidth); H = Math.max(1, innerHeight); DPR = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    makeFBO(canvas.width, canvas.height);
  }

  // ------------------------------------------------------------ text → points
  const sampleCanvas = document.createElement('canvas');
  const sctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  const trialCanvas = document.createElement('canvas');
  const tctx = trialCanvas.getContext('2d', { willReadFrequently: true });
  let scaleTarget = 1, scaleCur = 1;
  let textMask = null, maskW = 0, maskH = 0; // glyph coverage, used for rain splashes

  // Render once at 100px and measure the *actual* inked pixels, so swashes,
  // italics and side bearings can never push the word off-screen.
  function inkBounds(text, font) {
    tctx.font = font(100);
    const mw = Math.ceil(tctx.measureText(text).width);
    const PAD = 160, BASE = 260;
    const w = Math.min(16000, mw + PAD * 2), h = 400;
    trialCanvas.width = w; trialCanvas.height = h;
    tctx.font = font(100);
    tctx.fillStyle = '#fff';
    tctx.textBaseline = 'alphabetic';
    tctx.fillText(text, PAD, BASE);
    const d = tctx.getImageData(0, 0, w, h).data;
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0, p = y * w * 4 + 3; x < w; x++, p += 4) {
        if (d[p] > 40) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    return { w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1 + 1) / 2 - PAD, cy: (y0 + y1 + 1) / 2 - BASE };
  }

  function sampleText(text, family, weight) {
    const cw = Math.max(2, Math.floor(W)), ch = Math.max(2, Math.floor(H));
    sampleCanvas.width = cw; sampleCanvas.height = ch;
    sctx.clearRect(0, 0, cw, ch);
    sctx.fillStyle = '#fff';
    sctx.textAlign = 'left';
    sctx.textBaseline = 'alphabetic';
    const font = (sz) => `${weight} ${sz}px "${family}", "Archivo Black", sans-serif`;
    const T = { x: new Float32Array(N), y: new Float32Array(N), t: new Float32Array(N), b: new Float32Array(N) };
    let count = 0, list = null, data = null;
    textMask = null;

    const b = text.trim() ? inkBounds(text, font) : null;
    if (b) {
      // leave room for liquid bloom, splashes and particle radius on both sides
      const margin = Math.max(40, cw * 0.08);
      const maxW = cw - margin * 2, maxH = ch * (cw < 700 ? 0.3 : 0.42);
      const cy = ch * 0.45;
      let sc = Math.min(maxW / b.w, maxH / b.h);
      let ox = cw / 2 - b.cx * sc, oy = cy - b.cy * sc;
      // draw, then measure where the ink really landed (font hinting and
      // fallback glyphs can differ from the trial render) and correct until it fits
      for (let attempt = 0; attempt < 4; attempt++) {
        sctx.clearRect(0, 0, cw, ch);
        sctx.font = font(100 * sc);
        sctx.fillText(text, ox, oy);
        data = sctx.getImageData(0, 0, cw, ch).data;
        let x0 = cw, x1 = -1, y0 = ch, y1 = -1;
        for (let y = 0; y < ch; y++) {
          for (let x = 0, p = y * cw * 4 + 3; x < cw; x++, p += 4) {
            if (data[p] > 40) {
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
          }
        }
        if (x1 < 0) break;
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        const touching = x0 <= 1 || x1 >= cw - 2 || y0 <= 1 || y1 >= ch - 2; // clipped by the canvas
        const fit = Math.min(maxW / w, maxH / h);
        const offCentre = Math.abs((x0 + x1) / 2 - cw / 2) > 2 || Math.abs((y0 + y1) / 2 - cy) > 2;
        if (!touching && fit >= 0.995 && !offCentre) break;
        const k = touching ? Math.min(fit, 0.8) : Math.min(fit, 1);
        // scale about the ink centre, then move that centre to the canvas centre
        const icx = (x0 + x1) / 2, icy = (y0 + y1) / 2;
        sc *= k;
        ox = cw / 2 - (icx - ox) * k;
        oy = cy - (icy - oy) * k;
      }
      list = new Int32Array(cw * ch);
      textMask = new Uint8Array(cw * ch); maskW = cw; maskH = ch;
      for (let i = 0, p = 3; i < cw * ch; i++, p += 4) if (data[p] > 127) { list[count++] = i; textMask[i] = 1; }
    }

    if (count === 0) {
      for (let k = 0; k < N; k++) {
        T.x[k] = rnd() * W; T.y[k] = rnd() * H; T.t[k] = 30; T.b[k] = 30;
      }
      scaleTarget = 1;
      return T;
    }
    const on = (ix, iy) => ix >= 0 && iy >= 0 && ix < cw && iy < ch && data[(iy * cw + ix) * 4 + 3] > 127;
    for (let k = 0; k < N; k++) {
      const idx = list[(rnd() * count) | 0];
      const ix = idx % cw, iy = (idx / cw) | 0;
      T.x[k] = ix + rnd(); T.y[k] = iy + rnd();
      let d = 1; while (d < 30 && on(ix, iy - d)) d++; T.t[k] = d - 1;
      d = 1; while (d < 30 && on(ix, iy + d)) d++; T.b[k] = d - 1;
    }
    scaleTarget = clamp(Math.sqrt(count / N / 4.5), 0.35, 2.0);
    return T;
  }

  // Word particles and targets are both sorted by x, so words morph with short
  // paths. Ambient particles (rain, dust, flakes roaming the whole screen) get an
  // evenly spread share of targets separately; otherwise the sort would hand the
  // word's outermost targets to whichever ambient particles sit nearest the screen
  // edges, and those parts of the word would never fill in.
  function assignTargets(T) {
    const set = (i, j) => { tx[i] = T.x[j]; ty[i] = T.y[j]; eT[i] = T.t[j]; eB[i] = T.b[j]; };
    const ti = Array.from({ length: N }, (_, i) => i).sort((a, b) => T.x[a] - T.x[b]);
    const word = [], ambient = [];
    for (let i = 0; i < N; i++) (amb[i] ? ambient : word).push(i);
    word.sort((a, b) => px[a] - px[b]);
    const step = ambient.length ? N / ambient.length : Infinity;
    let next = step / 2, a = 0, w = 0;
    for (let k = 0; k < N; k++) {
      if (k >= next && a < ambient.length) { set(ambient[a++], ti[k]); next += step; }
      else if (w < word.length) set(word[w++], ti[k]);
      else set(ambient[a++], ti[k]);
    }
  }

  // ----------------------------------------------------------------- clock
  let clock = 0;
  let current = WATER;
  let switchTime = -100;
  const MORPH_DUR = 0.9;

  const isLiquid = (m) => m === GEL || m === MERCURY;

  function enterMaterial(i, m) {
    behav[i] = m;
    if (!amb[i] || isLiquid(m)) state[i] = 1;
    else { state[i] = 0; life[i] = rnd(); }
    heat[i] = 1; alpha[i] = 1;
    vx[i] += (rnd() - 0.5) * 160;
    vy[i] += (rnd() - 0.5) * 160 - 40;
  }

  function setMaterial(m) {
    if (m === current) return;
    for (let i = 0; i < N; i++) {
      const t = (clock - switchTime - delay[i]) / MORPH_DUR;
      if (t >= 0.5) mFrom[i] = mTo[i];
      mTo[i] = m;
      delay[i] = clamp(px[i] / W, 0, 1) * 0.9 + rnd() * 0.35;
    }
    switchTime = clock;
    bgFrom = bgNow(); bgStart = clock;
    current = m;
    updateUI();
  }

  // entrance choreography for the current material
  function intro() {
    const m = current;
    switchTime = -100;
    for (let i = 0; i < N; i++) {
      behav[i] = mFrom[i] = mTo[i] = m;
      heat[i] = 1; alpha[i] = 1; life[i] = rnd();
      vx[i] = 0; vy[i] = 0;
      const X = tx[i], Y = ty[i];
      if (amb[i] && !isLiquid(m)) {
        state[i] = 0; px[i] = rnd() * W; py[i] = rnd() * H;
        if (m === FIRE) { py[i] = H + rnd() * 40; }
        continue;
      }
      switch (m) {
        case WATER:
          state[i] = 0; px[i] = X + (rnd() - 0.5) * 3; py[i] = -20 - rnd() * H * 1.1; vy[i] = 600 + rnd() * 400; break;
        case SAND:
          state[i] = 0; px[i] = -30 - rnd() * W * 0.45; py[i] = Y + (rnd() - 0.5) * H * 0.5; vx[i] = 400; break;
        case GEL:
          state[i] = 0; px[i] = X; py[i] = Y - H - (X / W) * H * 0.7; break;
        case FIRE:
          state[i] = 1; px[i] = X + (rnd() - 0.5) * 30; py[i] = H + 20 + rnd() * 140; vy[i] = -200; break;
        case SNOW:
          state[i] = 0; px[i] = X + (rnd() - 0.5) * 140; py[i] = -20 - rnd() * H * 1.4; break;
        case MERCURY:
          state[i] = 1; px[i] = W / 2 + (rnd() - 0.5) * W * 0.6; py[i] = H - 10 - rnd() * 30; break;
      }
    }
  }

  // ----------------------------------------------------------------- pointer
  const ptr = { x: -1e4, y: -1e4, lx: -1e4, ly: -1e4, vx: 0, vy: 0, speed: 0, active: false, down: false, t: 0 };
  function onPointer(e) {
    const now = performance.now();
    const dtp = Math.max(8, now - ptr.t) / 1000;
    // a big jump (re-entering the canvas, a dropped frame) is a new position, not a swipe
    const jump = Math.hypot(e.clientX - ptr.x, e.clientY - ptr.y) > 140;
    if (!ptr.active || jump) { ptr.lx = e.clientX; ptr.ly = e.clientY; ptr.vx = 0; ptr.vy = 0; }
    else {
      ptr.vx = ptr.vx * 0.5 + ((e.clientX - ptr.x) / dtp) * 0.5;
      ptr.vy = ptr.vy * 0.5 + ((e.clientY - ptr.y) / dtp) * 0.5;
    }
    ptr.x = e.clientX; ptr.y = e.clientY; ptr.t = now; ptr.active = true;
  }
  canvas.addEventListener('pointermove', onPointer);
  canvas.addEventListener('pointerdown', (e) => { onPointer(e); ptr.down = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', (e) => { ptr.down = false; if (e.pointerType !== 'mouse') ptr.active = false; });
  canvas.addEventListener('pointerleave', () => { ptr.active = false; });
  canvas.addEventListener('pointercancel', () => { ptr.active = false; ptr.down = false; });

  // --------------------------------------------------------------- simulate
  // rain impacts on the word (ring buffer) → ripples + crown splashes
  const IMP = 40, imp = new Float32Array(IMP * 3).fill(-100);
  let impHead = 0;
  function addImpact(x, y, t) {
    imp[impHead * 3] = x; imp[impHead * 3 + 1] = y; imp[impHead * 3 + 2] = t;
    impHead = (impHead + 1) % IMP;
  }
  const IMP_LIFE = 0.3, IMP_R = 16;
  const actImp = new Float32Array(IMP * 3);
  const onMask = (x, y) => {
    if (!textMask) return false;
    const ix = x | 0, iy = y | 0;
    return ix >= 0 && iy >= 0 && ix < maskW && iy < maskH && textMask[iy * maskW + ix] === 1;
  };

  const HOLD = 1.2, RAMP = 2.2;
  const smooth = (t) => t * t * (3 - 2 * t);

  function update(dt, time) {
    // pointer acts along the segment it swept this frame (a capsule), with a
    // per-particle radius jitter so the influence never reads as a clean circle
    ptr.speed = Math.hypot(ptr.vx, ptr.vy);
    const pAct = ptr.active;
    const mv = Math.min(ptr.speed / 500, 1.6);
    const sx = ptr.lx, sy = ptr.ly, sdx = ptr.x - sx, sdy = ptr.y - sy;
    const sl2 = sdx * sdx + sdy * sdy;
    const PR = 44 * (ptr.down ? 1.3 : 1);
    const PRmax = PR * 1.4 * 1.8;
    const bx0 = Math.min(sx, ptr.x) - PRmax, bx1 = Math.max(sx, ptr.x) + PRmax;
    const by0 = Math.min(sy, ptr.y) - PRmax, by1 = Math.max(sy, ptr.y) + PRmax;

    let nImp = 0;
    for (let k = 0; k < IMP; k++) {
      const age = time - imp[k * 3 + 2];
      if (age >= 0 && age < IMP_LIFE) {
        actImp[nImp * 3] = imp[k * 3]; actImp[nImp * 3 + 1] = imp[k * 3 + 1];
        actImp[nImp * 3 + 2] = 1 - age / IMP_LIFE; nImp++;
      }
    }

    for (let i = 0; i < N; i++) {
      if (behav[i] !== mTo[i] && time >= switchTime + delay[i]) enterMaterial(i, mTo[i]);
      const m = behav[i];
      let x = px[i], y = py[i], u = vx[i], v = vy[i];
      let st = state[i];
      const s = seed[i], X = tx[i], Y = ty[i];
      let ax = 0, ay = 0, c = 0;
      // after the cursor disturbs a particle it rests for HOLD seconds, then
      // eases back over RAMP seconds (rf: 0 = leave it be, 1 = fully reforming)
      const since = time - touch[i];
      const recent = since < HOLD + RAMP;
      const rf = since < HOLD ? 0 : recent ? smooth((since - HOLD) / RAMP) : 1;
      const mayReturn = !recent || (since > HOLD && rnd() < dt * 2.5);

      // pointer influence f ∈ [0,1], and unit vector away from the swept segment
      let f = 0, nx = 0, ny = 0;
      if (pAct && x > bx0 && x < bx1 && y > by0 && y < by1) {
        let t = sl2 > 0 ? ((x - sx) * sdx + (y - sy) * sdy) / sl2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = x - (sx + sdx * t), dy = y - (sy + sdy * t);
        const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
        const R = PR * (m === FIRE ? 1.8 : 1) * (0.6 + 0.8 * s) * (1 + 0.25 * Math.sin(s * 40 + time * 3));
        if (d < R) { f = 1 - d / R; nx = dx / d; ny = dy / d; }
      }

      switch (m) {
        case WATER:
          if (amb[i]) { // rain across the whole screen
            ay = 2600; c = 0.6;
            alpha[i] = st === 4 ? 0 : st === 3 ? 0.55 : 0.65;
            if (st === 0 && v > 0 && onMask(x, y)) {
              if (!onMask(x, y - 12)) { // hits a top edge → small splash off the rim
                st = 3;
                const sp = 0.35 + rnd() * 0.55;
                u = (rnd() - 0.5) * 300 * sp; v = -(100 + rnd() * 200) * sp;
                if (rnd() < 0.2) addImpact(x, y, time);
              } else st = 4; // landed inside the letter: absorbed into the surface
            }
            if (y > H + 40) { st = 0; x = rnd() * (W + 100) - 50; y = -40 - rnd() * 160; u = 30; v = 900 + rnd() * 700; }
          } else if (st === 0) { // raindrop falling onto its letter
            ay = 2000; ax = (X - x) * 14; c = 1.2;
            if (y >= Y - 1) {
              const rim = eT[i] < 3;
              if (rim && rnd() < 0.3) addImpact(x, y, time);
              if (rim && rnd() < 0.25) { // only rim drops bounce off as a splash
                st = 3; u = (rnd() - 0.5) * 260; v = -(80 + rnd() * 160);
              } else { st = 1; v *= 0.1; u += (rnd() - 0.5) * 40; }
            }
            else if (y > H + 40) { x = X; y = -30 - rnd() * H * 0.6; v = 700; }
          } else if (st === 1) { // beaded on the glyph
            ax = (X - x) * 90 * rf; ay = (Y - y) * 90 * rf + Math.sin(time * 3 + s * 40) * 20; c = 13;
            // ripples from nearby impacts; top-edge water gets thrown up as a crown
            for (let k = 0; k < nImp; k++) {
              const dx = x - actImp[k * 3], dy = y - actImp[k * 3 + 1];
              const d2 = dx * dx + dy * dy;
              if (d2 < IMP_R * IMP_R && eT[i] < 5) { // ripples stay on the rim
                const d = Math.sqrt(d2) + 0.5, fi = (1 - d / IMP_R) * actImp[k * 3 + 2];
                ax += (dx / d) * 1100 * fi; ay += (dy / d) * 1100 * fi;
                if (eT[i] < 2 && rnd() < fi * 0.01) {
                  st = 3; u = (dx / d) * (120 + rnd() * 200); v = -(160 + rnd() * 260);
                }
              }
            }
            if (rnd() < (eB[i] < 3 ? 0.02 : 0.0006) * dt) { st = 2; v = 20; }
          } else if (st === 3) { // splash droplet, lands back on the word
            ay = 1700; c = 0.4;
            if (v > 0 && y >= Y) { st = 1; v *= 0.2; }
            else if (y > H + 40) {
              if (mayReturn) { st = 0; x = X; y = -30 - rnd() * H * 0.6; u = 0; v = 700; }
              else { y = H + 41; u = 0; v = 0; ay = 0; }
            }
          } else { // drip, then recycle as fresh rain
            ay = 1700; c = 0.8;
            if (y > H + 40) {
              if (mayReturn) { st = 0; x = X + (rnd() - 0.5) * 4; y = -30 - rnd() * H * 0.45; u = 0; v = 900 + rnd() * 500; }
              else { y = H + 41; u = 0; v = 0; ay = 0; }
            }
          }
          break;

        case SAND:
          if (amb[i]) { // wind-blown dust
            ax = (230 + 90 * Math.sin(y * 0.01 + time * 0.6 + s * 3) - u) * 1.8;
            ay = (Math.sin(x * 0.012 + time * 1.7 + s * 9) * 50 - v) * 2.0;
            alpha[i] = 0.45;
            if (x > W + 30) { x = -30; y = rnd() * H; }
            if (x < -80 || y < -80 || y > H + 80) { x = -20; y = rnd() * H; }
          } else if (st === 0) { // carried in on the wind from the left
            const dxr = X - x;
            if (dxr < -12) st = 3; // overshot: loop round on the wind
            else if (dxr <= 2) { st = 1; u *= 0.2; v *= 0.2; }
            else {
              // velocity is set kinematically: eases to a stop exactly on target
              const wv = Math.min(720, 60 + dxr * 2.6) * (0.3 + 0.7 * rf);
              const amp = Math.min(dxr * 0.3, 55);
              const ty0 = Y + Math.sin(x * 0.013 + s * 6.28 + time * 1.5) * amp;
              const ku = Math.min(1, dt * 10);
              u += (wv - u) * ku;
              v += ((ty0 - y) * (2.5 + 60 / (dxr + 10)) - v) * ku;
            }
          } else if (st === 1) { // settled grain
            ax = (X - x) * 220; ay = (Y - y) * 220; c = 30;
            if (rnd() < (eT[i] < 3 ? 0.006 : 0.0002) * dt) { st = 3; u = 60 + rnd() * 100; v = -20 - rnd() * 40; }
          } else if (st === 2) { // swept loose: slides, loses momentum, comes to rest
            c = 3.2; life[i] += dt;
            if (life[i] > 1.2 + s * 1.8 && u * u + v * v < 900) st = x < X - 4 ? 0 : 3;
          } else { // lifted by wind: drifts right in gusts, re-enters from the left
            const wind = 240 + 180 * s + 90 * Math.sin(time * 0.7 + y * 0.01);
            ax = (wind - u) * 1.3;
            ay = (-18 + Math.sin(x * 0.012 + s * 9 + time * 1.3) * 50 - v) * 1.6;
            if (x > W + 30 || y < -60 || y > H + 60) {
              if (mayReturn) { st = 0; x = -30 - rnd() * W * 0.35; y = Y + (rnd() - 0.5) * H * 0.4; u = 200; v = 0; }
              else { x = W + 40; y = clamp(y, -50, H + 50); u = 0; v = 0; ax = 0; ay = 0; }
            }
          }
          break;

        case GEL:
        case MERCURY: {
          const liq = m === GEL;
          if (st === 0) { // dropping in
            ay = 2400; ax = (X - x) * 8; c = 0.5; alpha[i] = 1;
            if (y >= Y) { st = 1; v *= 0.3; }
          } else {
            // spatially coherent drips that stretch the bottom edge of glyphs
            const dn = Math.sin(X * 0.029 + time * 0.33 + 1.3) * Math.sin(X * 0.047 - time * 0.21);
            const drip = clamp((dn - 0.35) / 0.55, 0, 1);
            const bw = Math.max(0, 1 - eB[i] / 22);
            const k = (liq ? 34 : 70) * rf;
            ax = (X - x) * k + Math.sin(Y * 0.045 + time * 2.2) * (liq ? 70 : 40);
            ay = (Y - y) * k + (40 + drip * drip * bw * bw * (liq ? 2600 : 2200)) * rf + Math.cos(X * 0.04 + time * 1.8) * (liq ? 70 : 40);
            // disturbed goo flows freely under the cursor, then thickens as it
            // comes to rest and oozes home overdamped (no rubber-band snap)
            const thick = smooth(Math.min(since / 0.7, 1));
            c = recent ? (liq ? 2.2 + 10 * thick : 11) : (liq ? 2.4 : 4.5);
            alpha[i] = 1;
          }
          break;
        }

        case FIRE:
          if (amb[i]) { // embers
            life[i] -= dt * (0.35 + s * 0.3);
            ax = Math.sin(y * 0.02 + time * 2 + s * 20) * 120; ay = -140; c = 1.0;
            heat[i] = life[i] * 0.8 + 0.2; alpha[i] = clamp(life[i], 0, 1) * 0.9;
            if (life[i] <= 0 || y < -20) {
              life[i] = 1; u = 0; v = -60;
              if (rnd() < 0.85) { x = X; y = Y; } else { x = rnd() * W; y = H + 10; }
            }
          } else if (st === 1) { // white-hot core
            ax = (X - x) * 60 * rf + Math.sin(y * 0.08 + time * 9 + s * 30) * 120; ay = (Y - y) * 60 * rf - 80; c = 9;
            heat[i] = 0.68 + 0.2 * Math.sin(time * 6 + X * 0.05 + Y * 0.09) * Math.sin(time * 3.7 - X * 0.023) - Math.min(eT[i], 20) * 0.004 + (s - 0.5) * 0.12; alpha[i] = 1;
            if (rnd() < (eT[i] < 8 ? 3.2 : 0.15) * dt) { st = 2; life[i] = 1; v = -40 - rnd() * 80; }
          } else { // licking flame
            life[i] -= dt * (1.3 + s * 1.4);
            ax = Math.sin(y * 0.035 + time * 4.5 + X * 0.01) * 380 + Math.sin(y * 0.11 - time * 7 + s * 10) * 140;
            ay = -700; c = 2.6;
            heat[i] = life[i] * 0.95; alpha[i] = clamp(life[i], 0, 1);
            if (life[i] <= 0) {
              // burnt out; fanned areas stay dark a moment, then reignite gradually
              if (mayReturn) { st = 1; x = X; y = Y; u = 0; v = 0; life[i] = 1; }
              else { life[i] = 0; alpha[i] = 0; u = 0; v = 0; ax = 0; ay = 0; }
            }
          }
          break;

        case SNOW:
          if (amb[i]) {
            u = 20 + Math.sin(time * 0.7 + s * 30) * 35; v = 45 + s * 55; alpha[i] = 0.85;
            if (y > H + 10) { y = -10; x = rnd() * W; }
            if (x > W + 10) x = -10;
          } else if (st === 0) { // drifting down
            ax = (X - x) * 3 + Math.sin(time * 1.3 + s * 40) * 80; ay = 280 + s * 140; c = 1.0;
            if (y >= Y) st = 1;
            else if (y > H + 30) { x = X + (rnd() - 0.5) * 120; y = -20 - rnd() * 200; v = 100; }
          } else if (st === 1) { // settled
            ax = (X - x) * 120 * rf; ay = (Y - y) * 120 * rf; c = 16;
            if (rnd() < (eT[i] < 3 ? 0.006 : 0.0003) * dt) { st = 2; u = 30 + rnd() * 50; v = -20; }
          } else { // swept off by wind
            ax = Math.sin(time + s * 20) * 60 + 40; ay = 40; c = 0.8;
            if (x > W + 20 || y > H + 20 || x < -20) {
              if (mayReturn) { st = 0; x = X + (rnd() - 0.5) * 120; y = -20 - rnd() * 200; u = 0; v = 100; }
              else { x = clamp(x, -30, W + 30); y = Math.min(y, H + 30); u = 0; v = 0; ax = 0; ay = 0; }
            }
          }
          break;
      }

      if (f > 0) {
        touch[i] = time;
        if (m === SAND) {
          // hovering loosens grains a few at a time; the wind then carries them off
          if (!amb[i] && st !== 3) {
            if (rnd() < f * dt * (10 + mv * 25)) {
              st = 3;
              u = 30 + rnd() * 70 + clamp(ptr.vx, -600, 600) * 0.25 * f;
              v = -10 - rnd() * 40 + clamp(ptr.vy, -600, 600) * 0.25 * f;
            }
          } else {
            ax += 260 * f; // a gust right under the cursor
          }
        } else if (m === FIRE) {
          // fanning: more oxygen → hotter core, more and taller flames bent by the draft
          if (amb[i]) {
            ax += (ptr.vx - u) * f * 3; ay += (ptr.vy - v) * f * 3;
            life[i] = Math.min(1, life[i] + dt * f);
          } else if (st === 1) {
            heat[i] = Math.min(1, heat[i] + f * 0.45);
            if (rnd() < f * (0.8 + mv * 3) * dt * 8) { st = 2; life[i] = 1; u += ptr.vx * 0.25; v = -80 - rnd() * 140; }
          } else {
            ax += (ptr.vx * 0.9 - u) * f * 3.5;
            ay += (ptr.vy * 0.5 - v) * f * 2 - f * 650;
            life[i] = Math.min(1, life[i] + dt * f * 1.2);
            heat[i] = Math.min(1, heat[i] + f * 0.25);
          }
        } else if (m === WATER && !amb[i] && (st === 1 || st === 3)) {
          // the cursor splashes the surface: droplets leap out in a crown and
          // fall back onto the word; faster movement throws bigger splashes
          if (st === 1 && rnd() < f * dt * (2 + mv * 22)) {
            st = 3;
            const sp = (0.5 + rnd() * 0.7) * (0.55 + mv * 0.6);
            u = nx * (120 + rnd() * 220) * sp + clamp(ptr.vx, -800, 800) * 0.25;
            v = -(200 + rnd() * 300) * sp + ny * 50;
          } else if (st === 1) {
            ax += nx * 1400 * f; ay += ny * 1400 * f; // ring of displaced water
          }
        } else {
          const mat = MATS[m];
          // a soft wake: particles get dragged along with the motion, barely pushed when still
          const wake = Math.min(1, mv * 1.5) * f * mat.drag * 5;
          ax += (ptr.vx - u) * wake; ay += (ptr.vy - v) * wake;
          const push = f * mat.push * (0.06 + mv * 0.45);
          ax += nx * push; ay += ny * push;
          if (mat.knock && st === 1 && !amb[i] && f > 0.35 && (ptr.down || ptr.speed > 300)) {
            st = m === WATER ? 3 : 2;
            if (m === WATER) { u = ptr.vx * 0.4 + nx * 120; v = Math.min(ptr.vy * 0.4, 0) - 120 - rnd() * 160; }
          }
        }
      }

      // semi-implicit Euler with implicit damping (stable for stiff springs)
      u = (u + ax * dt) / (1 + c * dt);
      v = (v + ay * dt) / (1 + c * dt);
      x += u * dt; y += v * dt;
      px[i] = x; py[i] = y; vx[i] = u; vy[i] = v; state[i] = st;
    }
    ptr.vx *= Math.exp(-dt * 6); ptr.vy *= Math.exp(-dt * 6);
    ptr.lx = ptr.x; ptr.ly = ptr.y;
  }

  // -------------------------------------------------------------- background
  const bgOf = (m) => {
    const b = MATS[m].bg;
    return { top: hex(b.top), bot: hex(b.bot), glow: hex(b.glow), bokeh: b.bokeh };
  };
  let bgFrom = bgOf(WATER), bgStart = -100;
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  function bgNow() {
    const to = bgOf(current);
    let t = clamp((clock - bgStart) / 1.6, 0, 1);
    t = t * t * (3 - 2 * t);
    return {
      top: lerp3(bgFrom.top, to.top, t), bot: lerp3(bgFrom.bot, to.bot, t),
      glow: lerp3(bgFrom.glow, to.glow, t), bokeh: bgFrom.bokeh + (to.bokeh - bgFrom.bokeh) * t,
    };
  }

  // ------------------------------------------------------------------ render
  function render() {
    // pack instances
    for (let i = 0, o = 0; i < N; i++, o += STRIDE) {
      inst[o] = px[i]; inst[o + 1] = py[i]; inst[o + 2] = vx[i]; inst[o + 3] = vy[i];
      inst[o + 4] = seed[i]; inst[o + 5] = alpha[i];
      inst[o + 6] = clamp((clock - switchTime - delay[i]) / MORPH_DUR, 0, 1);
      inst[o + 7] = heat[i]; inst[o + 8] = mFrom[i]; inst[o + 9] = mTo[i];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, fbW, fbH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(partProg.p);
    gl.uniform2f(partProg.u.uRes, W, H);
    gl.uniform1f(partProg.u.uScale, scaleCur);
    gl.bindVertexArray(vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, N);
    gl.disable(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(compProg.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texAcc);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texAux);
    const u = compProg.u, bg = bgNow();
    gl.uniform1i(u.uAcc, 0); gl.uniform1i(u.uAux, 1);
    gl.uniform2f(u.uTexel, DPR / fbW, DPR / fbH);
    gl.uniform1f(u.uAspect, W / H);
    gl.uniform1f(u.uTime, clock);
    gl.uniform3fv(u.uBgTop, bg.top); gl.uniform3fv(u.uBgBot, bg.bot); gl.uniform3fv(u.uGlow, bg.glow);
    gl.uniform1f(u.uBokeh, bg.bokeh);
    const fireMix = current === FIRE ? 1 : 0;
    gl.uniform1f(u.uFlicker, 1 + fireMix * (0.25 * Math.sin(clock * 11) * Math.sin(clock * 7.3) + 0.2));
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // --------------------------------------------------------------------- UI
  const wordInput = $('#word'), statusEl = $('#status');
  const matsEl = $('#mats'), statsEl = $('#stats');
  let fontFamily = 'Abril Fatface', fontWeight = 400;

  // materials shown in the picker (and bound to number keys), in order
  const VISIBLE = MATS.map((_, i) => i).filter((i) => !MATS[i].hidden);
  document.querySelector('.hint').innerHTML =
    `Drag through the letters · keys <kbd>1</kbd>–<kbd>${VISIBLE.length}</kbd> switch matter · <kbd>H</kbd> hides the panel`;

  VISIBLE.forEach((i, k) => {
    const m = MATS[i];
    const b = document.createElement('button');
    b.className = 'mat';
    b.setAttribute('role', 'tab');
    b.style.setProperty('--c', m.pal[1]);
    b.style.setProperty('--g', `radial-gradient(circle at 35% 30%, ${m.pal[2]}, ${m.pal[1]} 45%, ${m.pal[0]})`);
    b.innerHTML = `<span class="sw"></span>${m.label}<span class="k">${k + 1}</span>`;
    b.addEventListener('click', () => chooseMaterial(i));
    matsEl.appendChild(b);
  });

  function updateUI() {
    [...matsEl.children].forEach((b, k) => b.setAttribute('aria-selected', VISIBLE[k] === current ? 'true' : 'false'));
    document.documentElement.style.setProperty('--accent', MATS[current].pal[1]);
    updateMini();
  }

  // ---- collapsible panel: folds down to a pill showing the current material
  const dock = $('#dock'), collapseBtn = $('#collapseBtn'), miniBar = $('#miniBar');
  function updateMini() {
    const m = MATS[current];
    $('#miniMat').textContent = m.label;
    $('#miniSw').style.setProperty('--g', `radial-gradient(circle at 35% 30%, ${m.pal[2]}, ${m.pal[1]} 45%, ${m.pal[0]})`);
  }
  function setCollapsed(on) {
    dock.classList.toggle('collapsed', on);
    collapseBtn.setAttribute('aria-expanded', on ? 'false' : 'true');
    if (on) closeFonts();
    try { localStorage.setItem('elemental-collapsed', on ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  }
  collapseBtn.addEventListener('click', () => { setCollapsed(true); miniBar.focus(); });
  miniBar.addEventListener('click', () => { setCollapsed(false); collapseBtn.focus(); });

  function chooseMaterial(i) {
    const prevWord = MATS[current].word;
    // swap in the material's signature word unless the user typed their own
    if (wordInput.value.trim() === prevWord || !wordInput.value.trim()) {
      wordInput.value = MATS[i].word;
      setMaterial(i);
      retarget();
    } else {
      setMaterial(i);
    }
  }

  let status = (msg, err = false) => { statusEl.textContent = msg; statusEl.classList.toggle('err', err); };

  function retarget() {
    assignTargets(sampleText(wordInput.value, fontFamily, fontWeight));
  }

  let retargetTimer = 0;
  wordInput.addEventListener('input', () => {
    clearTimeout(retargetTimer);
    retargetTimer = setTimeout(retarget, 120);
  });

  // Google Fonts: try bold first, fall back to the default weight
  const fontCache = new Map();
  function addStylesheet(url) {
    return new Promise((resolve) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = url;
      l.onload = () => resolve(true);
      l.onerror = () => { l.remove(); resolve(false); };
      document.head.appendChild(l);
    });
  }
  async function loadGoogleFont(family) {
    if (fontCache.has(family)) return fontCache.get(family);
    const fam = encodeURIComponent(family).replace(/%20/g, '+');
    for (const w of [700, 400]) {
      const url = w === 400
        ? `https://fonts.googleapis.com/css2?family=${fam}&display=block`
        : `https://fonts.googleapis.com/css2?family=${fam}:wght@${w}&display=block`;
      if (await addStylesheet(url)) {
        try {
          const faces = await document.fonts.load(`${w} 100px "${family}"`, wordInput.value || 'Aa');
          if (faces.length) { fontCache.set(family, w); return w; }
        } catch (e) { /* try next */ }
      }
    }
    return null;
  }

  let fontReq = 0;
  async function chooseFont(name) {
    name = name.trim().replace(/\s+/g, ' ');
    if (!name) return;
    const sys = SYSTEM_FONTS.find((f) => f.name.toLowerCase() === name.toLowerCase());
    const known = FONTS.find((f) => f.toLowerCase() === name.toLowerCase());
    if (known) name = known;
    const req = ++fontReq;
    let w;
    if (sys) {
      name = sys.name; w = sys.weight;
    } else {
      status(`Loading “${name}”…`);
      w = await loadGoogleFont(name);
      if (req !== fontReq) return;
      if (w == null) { status(`Couldn't find “${name}” on Google Fonts.`, true); return; }
    }
    fontFamily = name; fontWeight = w;
    fontNameEl.textContent = name;
    fontNameEl.style.fontFamily = `"${name}", 'Manrope', sans-serif`;
    status('');
    retarget();
  }

  // ---- font dropdown
  const fontBtn = $('#fontBtn'), fontPop = $('#fontPop'), fontSearch = $('#fontSearch');
  const fontListEl = $('#fontList'), fontNameEl = $('#fontName'), fontField = $('#fontField');
  let previewsLoaded = false, hl = 0, optEls = [];

  function loadPreviews() {
    if (previewsLoaded) return;
    previewsLoaded = true;
    // one request, subset to just the letters of the names
    const chars = [...new Set(FONTS.join('').replace(/\s/g, '') + 'Aa')].join('');
    const fams = FONTS.map((f) => 'family=' + f.replace(/ /g, '+')).join('&');
    addStylesheet(`https://fonts.googleapis.com/css2?${fams}&text=${encodeURIComponent(chars)}&display=swap`);
  }

  function renderFontList() {
    const q = fontSearch.value.trim().toLowerCase();
    const match = (n) => !q || n.toLowerCase().includes(q);
    const sys = SYSTEM_FONTS.map((f) => f.name).filter(match);
    const goog = FONTS.filter(match);
    let html = '';
    const opt = (n, tag) => `<div class="font-opt" role="option" data-font="${n}" aria-selected="${n === fontFamily}"
      style="font-family:'${n}', 'Manrope', sans-serif">${n}<small>${tag}</small></div>`;
    if (sys.length) html += `<div class="font-group">System</div>` + sys.map((n) => opt(n, 'system')).join('');
    if (goog.length) html += `<div class="font-group">Google Fonts</div>` + goog.map((n) => opt(n, 'google')).join('');
    const exact = [...sys, ...goog].some((n) => n.toLowerCase() === q);
    if (q && !exact) {
      const raw = fontSearch.value.trim().replace(/[<>"&]/g, '');
      html += `<div class="font-opt custom" role="option" data-font="${raw}">Load “${raw}” from Google Fonts</div>`;
    }
    fontListEl.innerHTML = html || '<div class="font-empty">No fonts match.</div>';
    optEls = [...fontListEl.querySelectorAll('.font-opt')];
    hl = Math.max(0, optEls.findIndex((el) => el.dataset.font === fontFamily));
    if (q) hl = 0;
    highlight(false);
  }
  function highlight(scroll = true) {
    optEls.forEach((el, i) => el.classList.toggle('hl', i === hl));
    if (optEls[hl]) optEls[hl].scrollIntoView({ block: scroll ? 'nearest' : 'center' });
  }
  function openFonts() {
    loadPreviews();
    fontPop.hidden = false;
    fontBtn.setAttribute('aria-expanded', 'true');
    fontSearch.value = '';
    renderFontList();
    fontSearch.focus();
  }
  function closeFonts() {
    fontPop.hidden = true;
    fontBtn.setAttribute('aria-expanded', 'false');
  }
  function pickFont(name) { closeFonts(); fontBtn.focus(); chooseFont(name); }

  fontField.addEventListener('click', (e) => {
    if (fontPop.contains(e.target)) return;
    fontPop.hidden ? openFonts() : closeFonts();
  });
  fontListEl.addEventListener('click', (e) => {
    const el = e.target.closest('.font-opt');
    if (el) pickFont(el.dataset.font);
  });
  fontListEl.addEventListener('mousemove', (e) => {
    const el = e.target.closest('.font-opt');
    const i = optEls.indexOf(el);
    if (i >= 0 && i !== hl) { hl = i; optEls.forEach((o, k) => o.classList.toggle('hl', k === hl)); }
  });
  fontSearch.addEventListener('input', renderFontList);
  fontSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { hl = Math.min(optEls.length - 1, hl + 1); highlight(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hl = Math.max(0, hl - 1); highlight(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (optEls[hl]) pickFont(optEls[hl].dataset.font); e.preventDefault(); }
    else if (e.key === 'Escape') { closeFonts(); fontBtn.focus(); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!fontPop.hidden && !fontField.contains(e.target)) closeFonts();
  });
  wordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') wordInput.blur(); });

  $('#dice').addEventListener('click', () => {
    const all = [...SYSTEM_FONTS.map((f) => f.name), ...FONTS];
    let f; do { f = all[(rnd() * all.length) | 0]; } while (f === fontFamily);
    chooseFont(f);
  });
  $('#replay').addEventListener('click', intro);

  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= VISIBLE.length) chooseMaterial(VISIBLE[n - 1]);
    else if (e.key === 'h' || e.key === 'H') $('#dock').classList.toggle('hidden');
    else if (e.key === 'r' || e.key === 'R') intro();
  });

  let resizeTimer = 0;
  addEventListener('resize', () => {
    resizeCanvas();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(retarget, 150);
  });

  // -------------------------------------------------------------------- boot
  let last = performance.now(), fpsAcc = 0, fpsN = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    clock += dt;
    scaleCur += (scaleTarget - scaleCur) * Math.min(1, dt * 3);
    update(dt, clock);
    render();
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) {
      statsEl.textContent = `${N.toLocaleString()} particles · ${Math.round(fpsN / fpsAcc)} fps`;
      fpsAcc = 0; fpsN = 0;
    }
    requestAnimationFrame(frame);
  }

  async function boot() {
    resizeCanvas();
    allocate(Math.round(clamp((W * H) / 36, 14000, 42000)));
    wordInput.value = MATS[current].word;
    try { if (localStorage.getItem('elemental-collapsed') === '1') setCollapsed(true); } catch (e) { /* ignore */ }
    fontNameEl.style.fontFamily = `"${fontFamily}", 'Manrope', sans-serif`;
    updateUI();
    status(`Loading “${fontFamily}”…`);
    const w = await loadGoogleFont(fontFamily);
    if (w == null) { fontFamily = 'sans-serif'; fontWeight = 800; } else fontWeight = w;
    status('');
    retarget();
    intro();
    requestAnimationFrame((t) => { last = t; frame(t); });
  }
  boot();
})();
