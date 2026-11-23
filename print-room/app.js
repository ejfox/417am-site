// The Print Room: a walkable gallery of every 417am work, generated from gallery.json
// (pipeline/layout.py). Rooms, walls, doors, hang positions and the tour all come from
// the data; nothing about the plan is hard-coded here.

import {makePile} from './pile.js';

const DATA = await fetch('gallery.json').then(response => response.json());
// the entrance room's floor is covered in letter-size prints you can kick around
const PILE_ROOM = 0;
const PILE_COUNT = 1024;

const DOOR = 2.3;
// one CRT in a bank (pipeline/layout.py uses the same sizes to hang them)
const CRT_GAP = .03, PLINTH = .32;
const EYE_HEIGHT = 1.75;
const H = DATA.H;
const PREVIEW = 768;

function cloudinary(url, limit, lossless) {
  let format = 'f_auto,q_auto';
  if (lossless) format = 'f_png';
  return url.replace('/image/upload/', `/image/upload/c_limit,w_${limit},${format}/`);
}

const rooms = DATA.rooms.map((room, index) => ({...room, index}));
const works = DATA.works.map(work => {
  const dither = work.kind === 'studio';
  // the best pixels we have: a 4K upscale where the original is smaller
  let source = work.image, sourceWidth = work.w;
  if (work.hi) { source = work.hi; sourceWidth = work.hw; }
  return {
    ...work,
    title: `no. ${work.id}`,
    dimensions: [work.w, work.h],
    width: work.dw,
    original: source,
    dither,
    texture(limit) {
      if (sourceWidth <= limit) return source;
      return cloudinary(source, limit, dither);
    },
  };
});
const byId = new Map(works.map(work => [work.id, work]));

// visit stats (Umami, served with the page by 417am.party). Each event at most once a visit
// per subject, so walking back and forth doesn't count twice. Never blocks anything.
const tracked = new Set();
function track(name, data, key = '') {
  const id = `${name}:${key}`;
  if (tracked.has(id)) return;
  tracked.add(id);
  try { window.umami?.track(name, data); } catch { /* stats are optional */ }
}

// rooms without prints: black-box video, or the bot's scripts running live
function isVideoRoom(room) {
  return (room.screens ?? []).some(screen => screen.kind === 'crt' || screen.kind === 'projection');
}
function isScriptRoom(room) {
  return (room.screens ?? []).some(screen => screen.kind === 'script');
}
// "24–26", "27 and 28", "05"
function roomRange(numbers) {
  if (numbers.length === 1) return numbers[0];
  const consecutive = numbers.every((n, i) => i === 0 || Number(n) === Number(numbers[i - 1]) + 1);
  if (consecutive && numbers.length > 2) return `${numbers[0]}–${numbers[numbers.length - 1]}`;
  return `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}

// ---------- live scripts: the 2017-18 bot's own CoffeeScript, compiled and run in the browser ----------
// Each script is compiled once, a trace call is put before every statement (mapped back to its
// CoffeeScript line), and it runs on a fresh random seed, a few ticks a frame, forever. The code
// panel lights each line as it runs; light fades, so a busy loop glows and setup flickers past.
// Nothing here loads until someone walks near a script room.
const CDN = 'https://cdn.jsdelivr.net/npm/';
const LIBRARIES = {
  coffee: 'coffeescript@2.7.0/lib/coffeescript-browser-compiler-modern/coffeescript.js',
  acorn: 'acorn@8.12.1/dist/acorn.mjs',
  astring: 'astring@1.9.0/dist/astring.mjs',
  d3: 'd3@5.16.0/+esm',
  chance: 'chance@1.1.12/+esm',
  simplex: 'simplex-noise@2.4.0/+esm',
  lodash: 'lodash-es@4.17.21/+esm',
};
let libraries = null;
function loadLibraries() {
  if (!libraries) {
    const names = Object.keys(LIBRARIES);
    libraries = Promise.all(names.map(name => import(CDN + LIBRARIES[name]))).then(modules => {
      const out = {};
      names.forEach((name, i) => { out[name] = modules[i]; });
      return out;
    });
  }
  return libraries;
}
const palettes = new Map();
function loadPalettes(size) {
  if (!palettes.has(size)) palettes.set(size, fetch(`${CDN}nice-color-palettes@3.0.0/${size}.json`).then(response => response.json()));
  return palettes.get(size);
}
// require('nice-color-palettes/500') and friends, as named in the source
function paletteSizes(source) {
  const sizes = new Set();
  for (const match of source.matchAll(/nice-color-palettes(?:\/(\d+))?/g)) sizes.add(match[1] ?? '100');
  return [...sizes];
}
// the CoffeeScript line a compiled JS position came from: the first mapped position along the
// statement's own line, else the nearest one before it (which can land on a comment above)
function coffeeLine(map, line, column) {
  for (let c = column; c < column + 160; c++) {
    const found = map.sourceLocation([line, c]);
    if (found) return found[0] + 1;
  }
  for (let l = line; l >= 0; l--) {
    let c = column;
    if (l !== line) c = 1000;
    for (; c >= 0; c--) {
      const found = map.sourceLocation([l, c]);
      if (found) return found[0] + 1;
    }
  }
  return 1;
}
function traceCall(line) {
  return {type: 'ExpressionStatement', expression: {type: 'CallExpression', optional: false,
    callee: {type: 'Identifier', name: '__trace'}, arguments: [{type: 'Literal', value: line, raw: String(line)}]}};
}
function instrument(lib, source) {
  const compiled = lib.coffee.compile(source, {sourceMap: true, bare: true});
  const ast = lib.acorn.parse(compiled.js, {ecmaVersion: 2022, locations: true, sourceType: 'script'});
  const traced = statements => statements.flatMap(statement => {
    const at = coffeeLine(compiled.sourceMap, statement.loc.start.line - 1, statement.loc.start.column);
    return [traceCall(at), statement];
  });
  const visit = node => {
    if (!node || typeof node.type !== 'string') return;
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
    if (node.type === 'Program' || node.type === 'BlockStatement') node.body = traced(node.body);
    if (node.type === 'SwitchCase') node.consequent = traced(node.consequent);
    if (node.type === 'ArrowFunctionExpression' && node.expression) {
      node.expression = false;
      node.body = {type: 'BlockStatement', body: traced([{type: 'ReturnStatement', argument: node.body, loc: node.body.loc}])};
    }
  };
  visit(ast);
  return lib.astring.generate(ast);
}
// @ejfox/four-seventeen 0.6.3, the skeleton every script extends, minus the file saving and logs
function skeleton(lib) {
  return class FourSeventeen {
    constructor(seed, options) {
      this.seed = seed; this.count = 500; this.numTicks = 1; this.bgColor = 'black';
      this.opacity = .88; this.width = 1080; this.height = 1080;
      if (options) Object.assign(this, options);
    }
    makeCanvas() {
      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.width; this.canvas.height = this.height;
      }
      this.ctx = this.canvas.getContext('2d');
      if (this.blendMode) this.ctx.globalCompositeOperation = this.blendMode;
      this.ctx.fillStyle = this.bgColor;
      return this.ctx.fillRect(0, 0, this.width, this.height);
    }
    // init(), split so the ticks can be spread over frames
    prepare() {
      this.chance = new lib.chance.Chance(this.seed);
      this.simplex = new lib.simplex.default();
      if (this.randomizeCount) this.count = this.chance.integer({min: this.count * .25, max: this.count});
      if (this.randomizeTicks) {
        this.numTicks = this.chance.integer({min: this.numTicks * .1, max: this.numTicks});
        if (this.minTicks) this.numTicks = lib.lodash.clamp(this.numTicks, this.minTicks, this.numTicks);
      }
      this.makeCanvas();
      this.makeParticles();
    }
    makeParticles() {
      this.data = lib.d3.range(this.count).map(() => {
        const c = lib.d3.hsl('white'); c.opacity = this.opacity;
        return {x: this.width / 2 + this.chance.floating({min: -250, max: 250}), y: this.height / 2 + this.chance.floating({min: -250, max: 250}), color: c.toString()};
      });
      return this.data;
    }
    tick() { this.ticks++; }
    init() { this.prepare(); }
    saveFile() {}
  };
}
// one script, ready to run any number of times: returns make(seed, trace) -> art
async function compileScript(name, source) {
  const lib = await loadLibraries();
  const sizes = paletteSizes(source);
  const loaded = await Promise.all(sizes.map(loadPalettes));
  const paletteBy = new Map(sizes.map((size, i) => [size, loaded[i]]));
  const run = new Function('require', 'module', '__filename', '__trace', instrument(lib, source));
  const shims = {
    path: {basename: () => name},
    yargs: {alias() { return this; }, argv: {}},
    d3: lib.d3,
    chance: lib.chance.Chance,
    'simplex-noise': lib.simplex.default,
    lodash: lib.lodash,
    '@ejfox/four-seventeen': skeleton(lib),
  };
  const require = id => {
    if (id.startsWith('nice-color-palettes')) return paletteBy.get(id.split('/')[1] ?? '100');
    if (id in shims) return shims[id];
    throw new Error(`${name}: no ${id} in the browser`);
  };
  return (seed, trace) => {
    const module = {exports: {}};
    run(require, module, `${name}.coffee`, trace);
    const art = module.exports;
    art.seed = seed;
    return art;
  };
}
// a station: the picture and its code, two canvases, advanced by step(dt)
const ART_PX = 1024, CODE_W = 900, CODE_H = 1260, CODE_LINE = 23, CODE_TOP = 54, CODE_BOTTOM = 64;
const RUN_SECONDS = 45, HOLD_SECONDS = 9, SETUP_SECONDS = 3;
function station(name, source, make, made) {
  const lines = source.split('\n');
  const art = document.createElement('canvas'); art.width = art.height = ART_PX;
  const code = document.createElement('canvas'); code.width = CODE_W; code.height = CODE_H;
  const artContext = art.getContext('2d'), codeContext = code.getContext('2d');
  const heat = new Float32Array(lines.length + 2);
  let piece = null, phase = 'setup', clock = 0, setupTrace = [], ticksDone = 0, ticksTotal = 0, runFor = RUN_SECONDS;
  let scroll = 0, dark = false, failed = 0, tracing = 'setup';
  const trace = line => {
    heat[line] = 1;
    if (tracing === 'setup' && setupTrace.length < 4000) setupTrace.push(line);
  };
  function begin() {
    const seed = Date.now() + Math.floor(Math.random() * 1000);
    heat.fill(0); setupTrace = []; tracing = 'setup'; ticksDone = 0; clock = 0; phase = 'setup';
    try {
      piece = make(seed, trace);
      piece.prepare();
      piece.ticks = 0;
      ticksTotal = piece.numTicks + 1;  // the skeleton's tickTil runs 0..numTicks inclusive
      // a script of a few ticks still takes a few seconds; a long one, at most RUN_SECONDS
      runFor = Math.min(RUN_SECONDS, Math.max(5, ticksTotal * 1.2));
      failed = 0;
    } catch (error) {
      console.warn(name, error);
      failed += 1; piece = null; phase = 'hold';
    }
    heat.fill(0); tracing = 'run';
    artContext.fillStyle = '#000'; artContext.fillRect(0, 0, ART_PX, ART_PX);
    if (piece) artContext.drawImage(piece.canvas, 0, 0, ART_PX, ART_PX);
  }
  function drawCode() {
    let paper = '#f4f4f2', ink = '#111111', mid = '#9a9a9a';
    if (dark) { paper = '#070707'; ink = '#d6d6d6'; mid = '#5a5a5a'; }
    const c = codeContext;
    c.fillStyle = paper; c.fillRect(0, 0, CODE_W, CODE_H);
    c.font = '500 15px "Helvetica Neue", Helvetica, Arial, sans-serif'; c.textBaseline = 'alphabetic';
    c.fillStyle = ink; c.textAlign = 'left'; c.fillText(`${name}.coffee`, 28, 34);
    c.fillStyle = mid; c.textAlign = 'right';
    let status = 'compiling';
    if (piece && phase === 'setup') status = 'makeParticles';
    if (piece && phase === 'run') status = `tick ${ticksDone.toLocaleString('en-US')} / ${ticksTotal.toLocaleString('en-US')}`;
    if (piece && phase === 'hold') status = 'done';
    c.fillText(status, CODE_W - 28, 34);
    c.textAlign = 'left';
    c.fillRect(28, 44, CODE_W - 56, 1);
    // follow the light: centre on where the heat is
    let weight = 0, sum = 0;
    for (let i = 1; i < heat.length; i++) { weight += heat[i]; sum += heat[i] * i; }
    const visible = Math.floor((CODE_H - CODE_TOP - CODE_BOTTOM) / CODE_LINE);
    if (weight > .05) {
      const target = Math.max(0, Math.min(lines.length - visible, sum / weight - visible / 2));
      scroll += (target - scroll) * .12;
    }
    const first = Math.max(0, Math.floor(scroll));
    c.font = '15px "SF Mono", Menlo, Consolas, monospace';
    for (let row = 0; row < visible + 1; row++) {
      const index = first + row;
      if (index >= lines.length) break;
      const y = CODE_TOP + (index - scroll) * CODE_LINE;
      if (y < CODE_TOP - CODE_LINE || y > CODE_H - CODE_BOTTOM) continue;
      const h = heat[index + 1];
      if (h > .015) {
        c.globalAlpha = Math.min(1, h);
        c.fillStyle = ink; c.fillRect(24, y + 4, CODE_W - 48, CODE_LINE);
        c.globalAlpha = 1;
      }
      c.fillStyle = mid;
      if (h > .5) c.fillStyle = paper;
      c.textAlign = 'right'; c.fillText(String(index + 1), 66, y + CODE_LINE - 2);
      c.textAlign = 'left';
      c.fillStyle = ink;
      if (h > .5) c.fillStyle = paper;
      c.fillText(lines[index].slice(0, 86), 82, y + CODE_LINE - 2);
    }
    c.fillStyle = mid; c.fillRect(28, CODE_H - CODE_BOTTOM + 8, CODE_W - 56, 1);
    c.font = '15px "Helvetica Neue", Helvetica, Arial, sans-serif';
    if (piece) c.fillText(`seed ${piece.seed}`, 28, CODE_H - 26);
    c.textAlign = 'right'; c.fillText(made, CODE_W - 28, CODE_H - 26); c.textAlign = 'left';
  }
  function step(dt) {
    if (!piece && phase !== 'hold') begin();
    clock += dt;
    const fade = Math.pow(.88, dt * 60);
    for (let i = 0; i < heat.length; i++) heat[i] *= fade;
    if (phase === 'setup') {
      // replay what setup touched, quickly, so it reads as a flicker down the file
      const shown = Math.floor(setupTrace.length * Math.min(1, clock / SETUP_SECONDS));
      for (let i = Math.max(0, shown - 3); i < shown; i++) heat[setupTrace[i]] = 1;
      if (clock >= SETUP_SECONDS) { phase = 'run'; clock = 0; }
    } else if (phase === 'run') {
      const due = Math.min(ticksTotal, Math.ceil(ticksTotal * Math.min(1, clock / runFor)));
      const start = performance.now();
      while (ticksDone < due && performance.now() - start < 12) {
        try { piece.tick(); } catch (error) { console.warn(name, error); ticksDone = ticksTotal; break; }
        ticksDone += 1;
      }
      artContext.drawImage(piece.canvas, 0, 0, ART_PX, ART_PX);
      if (ticksDone >= ticksTotal) { phase = 'hold'; clock = 0; }
    } else if (clock >= HOLD_SECONDS && failed < 3) {
      piece = null;
      begin();
    }
    drawCode();
  }
  return {art, code, step, theme(isDark) { dark = isDark; drawCode(); }};
}
// one station per script, shared by the 3D rooms and the flat fallback
const liveStations = new Map();
const readyStations = [];
function madeLine(ids) {
  const present = ids.filter(id => byId.has(id));
  if (!present.length) return '';
  const first = byId.get(present[0]);
  let line = `made no. ${first.id}, room ${rooms[first.room].number}`;
  if (present.length > 1) line += `, and ${present.length - 1} more in the show`;
  return line;
}
function liveStation(screen) {
  if (!liveStations.has(screen.id)) {
    const ready = compileScript(screen.id, screen.source).then(make => {
      const live = station(screen.id, screen.source, make, madeLine(screen.made ?? []));
      live.theme(night);
      readyStations.push(live);
      return live;
    });
    liveStations.set(screen.id, ready);
  }
  return liveStations.get(screen.id);
}

function plural(n, word) {
  if (n === 1) return `${n} ${word}`;
  return `${n} ${word}s`;
}

// ---------- plan geometry ----------

function insideRect([x1, z1, x2, z2], x, z, inset = 0) {
  return x > x1 + inset && x < x2 - inset && z > z1 + inset && z < z2 - inset;
}

function inDoor(x, z) {
  return DATA.doors.some(([dx, dz, axis]) => {
    if (axis === 'x') return Math.abs(x - dx) < .5 && Math.abs(z - dz) < DOOR / 2 - .3;
    return Math.abs(z - dz) < .5 && Math.abs(x - dx) < DOOR / 2 - .3;
  });
}

// a bank of CRTs stands on the floor against its wall: walk up to it, not into it
function inBank(x, z) {
  return rooms.some(room => (room.screens ?? []).some(screen => {
    if (screen.kind !== 'crt') return false;
    const dx = x - screen.x, dz = z - screen.z;
    const along = dx * Math.cos(screen.yaw) - dz * Math.sin(screen.yaw);
    const out = dx * Math.sin(screen.yaw) + dz * Math.cos(screen.yaw);
    return Math.abs(along) < screen.dw / 2 + .45 && out > -.3 && out < 1.15;
  }));
}

function onBench(x, z) {
  return DATA.benches.some(([bx, bz, width, alongX]) => {
    if (alongX) return Math.abs(x - bx) < width / 2 + .25 && Math.abs(z - bz) < .565;
    return Math.abs(z - bz) < width / 2 + .25 && Math.abs(x - bx) < .565;
  });
}

function canStand(x, z) {
  if (onBench(x, z) || inBank(x, z)) return false;
  if (inDoor(x, z)) return true;
  return rooms.some(room => insideRect(room.rect, x, z, .32));
}

function roomAt(x, z, fallback) {
  const found = rooms.findIndex(room => insideRect(room.rect, x, z));
  if (found < 0) return fallback;
  return found;
}

function centre(room) {
  const [x1, z1, x2, z2] = room.rect;
  return [(x1 + x2) / 2, (z1 + z2) / 2];
}

// ---------- building ----------

function buildSpace(T, scene, works) {
  const palette = [];
  const faces = [];
  const roomGroups = rooms.map(() => {
    const group = new T.Group();
    scene.add(group);
    return group;
  });
  const immaterial = (day, night = day, options = {}) => {
    const material = new T.MeshBasicMaterial({color: day, toneMapped: false, ...options});
    palette.push({material, day: new T.Color(day), night: new T.Color(night)});
    return material;
  };
  // Safari dithers canvas gradients per colour channel, and reading back a faint (low-alpha)
  // pixel un-premultiplies that dither into big coloured specks. So every pattern is flattened
  // to grey after painting, and a light or shadow spot (tint) keeps only its alpha.
  function pattern(width, height, paint, tint) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', {willReadFrequently: true});
    paint(context, width, height);
    const image = context.getImageData(0, 0, width, height);
    const px = image.data;
    for (let i = 0; i < px.length; i += 4) {
      let grey = (px[i] + px[i + 1] + px[i + 2]) / 3;
      if (tint !== undefined) grey = tint;
      px[i] = px[i + 1] = px[i + 2] = grey;
    }
    context.putImageData(image, 0, 0);
    const map = new T.CanvasTexture(canvas); map.colorSpace = T.SRGBColorSpace;
    return map;
  }
  function noise(ctx, w, h, amount) {
    const image = ctx.getImageData(0, 0, w, h);
    let seed = 27421;
    for (let i = 0; i < image.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const change = ((seed >>> 24) / 255 - .5) * amount;
      image.data[i] += change; image.data[i + 1] += change; image.data[i + 2] += change;
    }
    ctx.putImageData(image, 0, 0);
  }
  function plaster(width) {
    return pattern(512, 256, (c, w, h) => {
      // white cube: neutral white, a little falloff at the ceiling, floor and corners
      c.fillStyle = '#e9e9e7'; c.fillRect(0, 0, w, h);
      const glow = c.createRadialGradient(w * .53, h * .12, 9, w * .52, h * .3, w * .67);
      glow.addColorStop(0, '#ffffff'); glow.addColorStop(.48, '#f6f6f5c9'); glow.addColorStop(1, '#ffffff00'); c.fillStyle = glow; c.fillRect(0, 0, w, h);
      const shade = c.createLinearGradient(0, 0, 0, h);
      shade.addColorStop(0, '#00000026'); shade.addColorStop(.16, '#00000000'); shade.addColorStop(.74, '#00000000'); shade.addColorStop(1, '#00000022'); c.fillStyle = shade; c.fillRect(0, 0, w, h);
      const corner = c.createLinearGradient(0, 0, w, 0);
      const edge = Math.min(.29, 1.55 / width); corner.addColorStop(0, '#0000002a'); corner.addColorStop(edge, '#00000000'); corner.addColorStop(1 - edge, '#00000000'); corner.addColorStop(1, '#00000028'); c.fillStyle = corner; c.fillRect(0, 0, w, h); noise(c, w, h, 4);
    });
  }
  const concreteCanvas = pattern(512, 512, (c, w, h) => {
    c.fillStyle = '#b4b4b2'; c.fillRect(0, 0, w, h);
    const shine = c.createRadialGradient(w * .46, h * .55, 10, w * .50, h * .47, w * .57);
    shine.addColorStop(0, '#dcdcda'); shine.addColorStop(.72, '#c4c4c2'); shine.addColorStop(1, '#a2a2a0'); c.fillStyle = shine; c.fillRect(0, 0, w, h);
    noise(c, w, h, 14);
    c.strokeStyle = '#0000001c'; c.lineWidth = 1;
    for (let x = 0; x <= w; x += 128) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y <= h; y += 112) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  });
  function surface(w, h, material, x, y, z, yaw = 0, parent = scene) {
    const mesh = new T.Mesh(new T.PlaneGeometry(w, h), material);
    mesh.position.set(x, y, z); mesh.rotation.y = yaw; parent.add(mesh); return mesh;
  }
  function box(w, h, d, material, x, y, z, parent = scene) {
    const mesh = new T.Mesh(new T.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  }
  // after hours: the house lights are off, the room goes OLED black, only the art is lit
  const ceiling = immaterial(0xe2e2e0, 0x050505);
  const edge = immaterial(0xc8c8c6, 0x1a1a1a);
  const recess = immaterial(0x7a7a78, 0x030303);
  const timber = immaterial(0x1c1c1c, 0x232323);
  const dark = immaterial(0x111111, 0x050505);
  const light = immaterial(0xffffff, 0x0b0b0b);
  const softLight = immaterial(0xf2f2f0, 0x080808);
  const walls = new Map();
  function wall(x1, z1, x2, z2) {
    const width = Math.hypot(x2 - x1, z2 - z1);
    const yaw = Math.atan2(z1 - z2, x2 - x1);
    const x = (x1 + x2) / 2, z = (z1 + z2) / 2;
    const key = width.toFixed(0);
    if (!walls.has(key)) walls.set(key, immaterial(0xffffff, 0x141414, {map: plaster(width), side: T.DoubleSide}));
    const group = new T.Group(); group.position.set(x, 0, z); group.rotation.y = yaw; scene.add(group);
    box(width, H, .12, walls.get(key), 0, H / 2, 0, group);
    box(width, .096, .15, recess, 0, .048, 0, group);
    box(width, .034, .17, edge, 0, .112, 0, group);
    box(width, .08, .18, edge, 0, H - .04, 0, group);
  }
  for (const spec of DATA.walls) wall(...spec);

  // video rooms are black boxes: lined, house lights off, lit only by their screens
  const blackout = immaterial(0x070707, 0x030303);
  function lineRoom(room) {
    const [x1, z1, x2, z2] = room.rect;
    const inset = .1;
    // [the wall's line, the lining just inside it, from, to, wall runs along x]
    const sides = [[z1, z1 + inset, x1, x2, true], [z2, z2 - inset, x1, x2, true], [x1, x1 + inset, z1, z2, false], [x2, x2 - inset, z1, z2, false]];
    for (const [wallLine, fixed, from, to, alongX] of sides) {
      const gaps = [];
      for (const [dx, dz, axis] of DATA.doors) {
        if (alongX && axis !== 'x' && Math.abs(dz - wallLine) < .3 && dx > from && dx < to) gaps.push([dx - DOOR / 2 - .12, dx + DOOR / 2 + .12]);
        if (!alongX && axis === 'x' && Math.abs(dx - wallLine) < .3 && dz > from && dz < to) gaps.push([dz - DOOR / 2 - .12, dz + DOOR / 2 + .12]);
      }
      gaps.sort((a, b) => a[0] - b[0]);
      let start = from;
      for (const [a, b] of [...gaps, [to, to]]) {
        const length = a - start;
        if (length > .05) {
          const mid = (start + a) / 2;
          if (alongX) box(length, H, .01, blackout, mid, H / 2, fixed, roomGroups[room.index]);
          else box(.01, H, length, blackout, fixed, H / 2, mid, roomGroups[room.index]);
        }
        start = b;
      }
    }
  }

  for (const room of rooms) {
    const [x1, z1, x2, z2] = room.rect;
    const [x, z] = centre(room);
    if (isVideoRoom(room)) {
      surface(x2 - x1, z2 - z1, blackout, x, .002, z).rotation.x = -Math.PI / 2;
      surface(x2 - x1, z2 - z1, blackout, x, H - .002, z).rotation.x = Math.PI / 2;
      lineRoom(room);
      continue;
    }
    const map = concreteCanvas.clone();
    map.wrapS = map.wrapT = T.RepeatWrapping;
    map.repeat.set((x2 - x1) / 6, (z2 - z1) / 6);
    map.needsUpdate = true;
    const floor = immaterial(0xffffff, 0x121212, {map});
    surface(x2 - x1, z2 - z1, floor, x, 0, z).rotation.x = -Math.PI / 2;
    surface(x2 - x1, z2 - z1, ceiling, x, H, z).rotation.x = Math.PI / 2;
    box((x2 - x1) * .68, .035, (z2 - z1) * .66, recess, x, H - .024, z);
    box((x2 - x1) * .63, .043, (z2 - z1) * .61, softLight, x, H - .032, z);
    box((x2 - x1) * .60, .052, (z2 - z1) * .58, light, x, H - .042, z);
    for (let j = -2; j <= 2; j++) box((x2 - x1) * .615, .047, .075, edge, x, H - .079, z + j * (z2 - z1) * .104);
  }

  // door frames: header above 3.09 m, two posts, a timber threshold
  for (const [x, z, axis] of DATA.doors) {
    const span = DOOR + .02;
    if (axis === 'x') {
      box(.32, H - 3.09, span, ceiling, x, (H + 3.09) / 2, z);
      for (const side of [-1, 1]) box(.32, 3.09, .09, edge, x, 1.545, z + side * DOOR / 2);
      box(.38, .09, span, edge, x, 3.09, z);
      box(.32, .013, DOOR - .04, timber, x, .007, z);
    } else {
      box(span, H - 3.09, .32, ceiling, x, (H + 3.09) / 2, z);
      for (const side of [-1, 1]) box(.09, 3.09, .32, edge, x + side * DOOR / 2, 1.545, z);
      box(span, .09, .38, edge, x, 3.09, z);
      box(DOOR - .04, .013, .32, timber, x, .007, z);
    }
  }

  const shadow = pattern(128, 128, (c, w, h) => {
    const glow = c.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 2);
    glow.addColorStop(0, '#000000aa'); glow.addColorStop(.51, '#00000055'); glow.addColorStop(1, '#00000000'); c.fillStyle = glow; c.fillRect(0, 0, w, h);
  }, 0);
  const shadowMat = new T.MeshBasicMaterial({map: shadow, transparent: true, depthWrite: false, opacity: .5});
  const printShade = new T.MeshBasicMaterial({map: shadow, transparent: true, depthWrite: false, opacity: .48});
  // a pool of track light on the wall around each print; brighter after hours
  const washMap = pattern(256, 256, (c, w, h) => {
    const glow = c.createRadialGradient(w / 2, h * .34, 2, w / 2, h * .46, w / 2);
    glow.addColorStop(0, '#ffffff'); glow.addColorStop(.42, '#ffffff8c'); glow.addColorStop(.78, '#ffffff1f'); glow.addColorStop(1, '#ffffff00');
    c.fillStyle = glow; c.fillRect(0, 0, w, h);
  }, 255);
  const wash = immaterial(0x1a1a1a, 0x5c5c5c, {map: washMap, transparent: true, depthWrite: false, blending: T.AdditiveBlending});

  for (const [x, z, width, alongX] of DATA.benches) {
    let w = width, d = .63, lw = .14, ld = .47;
    if (!alongX) { w = .63; d = width; lw = .47; ld = .14; }
    box(w, .14, d, timber, x, .49, z);
    for (const side of [-1, 1]) {
      if (alongX) box(lw, .42, ld, dark, x + side * width * .36, .21, z);
      else box(lw, .42, ld, dark, x, .21, z + side * width * .36);
    }
    const shadowPlane = surface(w * 1.5, d * 2.4, shadowMat, x, .01, z);
    shadowPlane.rotation.x = -Math.PI / 2;
  }

  // white glyphs, tinted by the material: ink by day, pale grey after hours;
  // the second line is the same ink at half strength, so it reads as grey on either wall
  const ink = immaterial(0x111111, 0xcfcfcf, {transparent: true, depthWrite: false});
  function lettering(lines, large, width, height) {
    const material = ink.clone();
    palette.push({material, day: new T.Color(0x111111), night: new T.Color(0xcfcfcf)});
    material.map = pattern(width, height, (c) => {
      c.textBaseline = 'middle';
      const face = '"Helvetica Neue", Helvetica, Arial, sans-serif';
      c.fillStyle = '#ffffff';
      if (large) {
        c.font = `92px ${face}`; c.fillText(lines[0], 14, height * .5);
      } else {
        c.font = `30px ${face}`; c.fillText(lines[0], 10, 42);
        c.globalAlpha = .5; c.font = `24px ${face}`; c.fillText(lines[1], 10, 83);
      }
    });
    return material;
  }

  for (const room of rooms) {
    // the room number sits high on the wall above the first thing hung there
    let anchor = byId.get(room.works[0]);
    let width = anchor?.width;
    let high = 3.45;
    if (!anchor) { anchor = room.screens[0]; width = anchor.dw; }
    if (isVideoRoom(room)) high = 4.2;  // clear of the projection
    const group = new T.Group();
    group.position.set(anchor.x, 0, anchor.z); group.rotation.y = anchor.yaw;
    roomGroups[room.index].add(group);
    const sign = lettering([room.number], true, 1024, 166);
    // on a black box's lining the number is light, day or night
    if (isVideoRoom(room)) palette.find(entry => entry.material === sign).day.setHex(0x8a8a8a);
    surface(2.6, .42, sign, -width / 2 + 1.3, high, .12, 0, group);
  }

  // ---------- video rooms: banks of stacked CRTs, and one big projection ----------
  const screenSlots = [];
  const plastic = immaterial(0x2b2b2b, 0x111111);
  const bezel = immaterial(0x161616, 0x060606);
  // a dead tube until its video arrives; then scanlines and a darker rim, like glass over phosphor
  function tube(scanlines) {
    const material = new T.MeshBasicMaterial({color: 0x0b0b0b, toneMapped: false});
    if (!scanlines) return material;
    material.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        #ifdef USE_MAP
          vec2 tubeAt = vMapUv * 2.0 - 1.0;
          diffuseColor.rgb *= (.78 + .22 * sin(vMapUv.y * 1100.0)) * smoothstep(1.32, .55, length(tubeAt * vec2(1.0, .9)));
          diffuseColor.rgb += .012;
        #endif`);
    };
    return material;
  }
  // the light a screen throws: a pool on the floor in front, a halo on the wall behind.
  // additive, black until the video plays; app code sets its brightness from the picture
  const glowMap = pattern(256, 256, (c, w, h) => {
    const glow = c.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    glow.addColorStop(0, '#ffffff'); glow.addColorStop(.35, '#ffffff80'); glow.addColorStop(.7, '#ffffff1c'); glow.addColorStop(1, '#ffffff00');
    c.fillStyle = glow; c.fillRect(0, 0, w, h);
  }, 255);
  const screenGlows = [];
  const scriptMounts = [];
  function glowing(w, h, x, y, z, flat, group) {
    const material = new T.MeshBasicMaterial({color: 0x000000, map: glowMap, transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false});
    const mesh = surface(w, h, material, x, y, z, 0, group);
    if (flat) mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = -1;
    return material;
  }
  // a fixed wobble per set, so the stack looks piled by hand
  let wobbleSeed = 9157;
  function wobble() {
    wobbleSeed = (Math.imul(wobbleSeed, 1664525) + 1013904223) >>> 0;
    return (wobbleSeed >>> 8) / 16777216 - .5;
  }
  for (const room of rooms) {
    for (const screen of room.screens ?? []) {
      if (screen.kind === 'script') {
        // a station: the picture, framed like a print, and its code beside it on the wall.
        // blank paper until the script compiles; app code hands both canvases over then
        const center = new T.Group(); center.position.set(screen.x, 1.58, screen.z); center.rotation.y = screen.yaw;
        roomGroups[room.index].add(center);
        const side = screen.dh, codeWidth = screen.dw - side - .3;
        const artX = -screen.dw / 2 + side / 2, codeX = screen.dw / 2 - codeWidth / 2;
        const pool = surface(screen.dw + 1.2, side + 1.6, wash, 0, .35, -.0125, 0, center);
        pool.renderOrder = -1;
        surface(side * 1.2, side * 1.24, printShade, artX + .014, -.063, -.012, 0, center);
        box(side + .106, side + .106, .047, dark, artX, 0, .028, center);
        box(side + .053, side + .053, .006, edge, artX, 0, .053, center);
        const art = new T.MeshBasicMaterial({color: 0xd6d6d4, toneMapped: false});
        surface(side, side, art, artX, 0, .058, 0, center);
        const code = new T.MeshBasicMaterial({color: 0xd6d6d4, toneMapped: false});
        surface(codeWidth, side, code, codeX, 0, .012, 0, center);
        scriptMounts.push({room: room.index, screen, art, code, center});
        continue;
      }
      const group = new T.Group(); group.position.set(screen.x, 0, screen.z); group.rotation.y = screen.yaw;
      roomGroups[room.index].add(group);
      const slots = [];
      let top = 0;
      if (screen.kind === 'crt') {
        const deepest = Math.max(...screen.stack.map(([, w]) => w * .78));
        box(screen.dw + .3, PLINTH, deepest + .25, plastic, 0, PLINTH / 2, (deepest + .25) / 2, group);
        let y = PLINTH;
        screen.stack.forEach(([count, w, h], row) => {
          const depth = w * .78;
          const rowWidth = count * w + (count - 1) * CRT_GAP;
          for (let col = 0; col < count; col++) {
            const set = new T.Group();
            set.position.set(-rowWidth / 2 + w / 2 + col * (w + CRT_GAP), y + h / 2, .06 + wobble() * .08);
            set.rotation.y = wobble() * .12;
            group.add(set);
            box(w, h, depth, plastic, 0, 0, depth / 2, set);
            const material = tube(true);
            surface(w * .78, h * .76, material, -w * .06, .01, depth + .003, 0, set);
            // neighbours show different channels: run them along the diagonals
            slots.push({room: room.index, src: screen.src[(row + col) % screen.src.length], material});
          }
          y += h + CRT_GAP;
        });
        top = y;
      } else {
        const y = 2.15;
        box(screen.dw + .1, screen.dh + .1, .04, bezel, 0, y, .02, group);
        const material = tube(false);
        surface(screen.dw, screen.dh, material, 0, y, .045, 0, group);
        slots.push({room: room.index, src: screen.src[0], material});
        top = y + screen.dh / 2;
      }
      screenSlots.push(...slots);
      const reach = screen.dw + 2.6;
      screenGlows.push({
        src: screen.src, slots, kind: screen.kind,
        halo: glowing(reach + 1.2, top + 1.6, 0, top / 2 + .2, .015, false, group),
        pool: glowing(reach, 4.2, 0, .004, 1.6, true, group),
      });
    }
  }

  for (const work of works) {
    const parent = roomGroups[work.room];
    const center = new T.Group(); center.position.set(work.x, work.y, work.z); center.rotation.y = work.yaw; parent.add(center);
    const height = work.dh;
    let margin = .053;
    if (work.kind === 'flux') margin = .045;
    const pool = surface(work.width + 1, height + 1.6, wash, 0, .35, -.0125, 0, center);
    pool.renderOrder = -1;
    surface(work.width * 1.20, height * 1.24, printShade, .014, -.063, -.012, 0, center);
    box(work.width + margin * 2, height + margin * 2, .047, dark, 0, 0, .028, center);
    box(work.width + margin, height + margin, .006, edge, 0, 0, .053, center);
    const screen = surface(work.width, height, new T.MeshBasicMaterial({color: 0xd6d6d4, toneMapped: false}), 0, 0, .058, 0, center);
    screen.userData.work = work; faces.push(screen);
    surface(.63, .158, lettering([`no. ${work.id}`, String(work.year)], false, 512, 128), work.width / 2 - .26, -height / 2 - .145, 0, 0, center);
  }
  return {faces, palette, roomGroups, screenSlots, screenGlows, scriptMounts};
}

// ---------- tour ----------

function viewFrom(x, z, [targetX, targetY, targetZ]) {
  const dx = targetX - x;
  const dz = targetZ - z;
  return {x, z, yaw: -Math.atan2(dx, -dz), pitch: Math.atan2(targetY - 1.75, Math.hypot(dx, dz))};
}

function standOff(work) {
  return Math.min(3.4, Math.max(2.2, work.width * 1.2 + .9));
}

function lookAtPrint(work, hold = 6) {
  // step back from the wall, then closer or further if that spot is on a bench
  let d = standOff(work);
  for (const tryD of [d, d - .6, d + .8, d + 1.6, 1.8]) {
    if (canStand(work.x + Math.sin(work.yaw) * tryD, work.z + Math.cos(work.yaw) * tryD)) { d = tryD; break; }
  }
  const x = work.x + Math.sin(work.yaw) * d;
  const z = work.z + Math.cos(work.yaw) * d;
  return {
    pose: viewFrom(x, z, [work.x, work.y, work.z]),
    stop: {room: work.room, title: work.title, subtitle: work.medium, work},
    hold,
  };
}

function entryView(room) {
  const [cx, cz] = centre(room);
  const [ex, ez] = room.entry;
  // a script room turns you to its first station: it may hang on a side wall
  if (isScriptRoom(room)) {
    const first = room.screens[0];
    return viewFrom(ex, ez, [first.x, 1.58, first.z]);
  }
  return viewFrom(ex, ez, [cx + (cx - ex), 2.1, cz + (cz - ez)]);
}

// ---------- page ----------

const $ = (id) => document.getElementById(id);
const view = $('viewport');
const printDialog = $('inspect');
const indexDialog = $('index');
const stage = $('print-stage');
const print = $('print');
const clock = new Intl.DateTimeFormat('en-GB', {hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/New_York'});
const keys = new Set();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const autoTour = $('auto-tour');
const endTour = $('end-tour');
const tourCaption = $('tour-caption');
const tourProgress = $('tour-progress');
let currentRoom = 0;
let nightOverride;
let night = false;
let zoom = 1, panX = 0, panY = 0, fitWidth = 0, fitHeight = 0;
let activePrintDrag;
let sceneView;
let lastFocus;
let tour;

const years = works.map(work => work.year);
const printRooms = rooms.filter(room => room.works.length).length;
$('intro-text').textContent = `${works.length} works, ${Math.min(...years)}–${Math.max(...years)}. ${printRooms} rooms, hung by likeness.`;

for (const room of rooms) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'room'; button.dataset.room = String(room.index);
  const number = document.createElement('span'); number.className = 'room-number'; number.textContent = room.number;
  let label = `Room ${room.number}, ${plural(room.works.length, 'work')}`;
  if (isVideoRoom(room)) label = `Room ${room.number}, video`;
  if (isScriptRoom(room)) label = `Room ${room.number}, scripts running live`;
  button.setAttribute('aria-label', label);
  const tally = document.createElement('span'); tally.className = 'room-seen'; tally.title = 'Seen';
  button.append(number, tally);
  $('rooms').append(button);
}
const roomButtons = [...document.querySelectorAll('[data-room]')];

// dark: your system's setting, or 4:17 a.m. in New York; the 4:17 button overrides and is remembered
const NIGHT_KEY = 'print-room-night';
const prefersDark = matchMedia('(prefers-color-scheme: dark)');
try {
  const saved = localStorage.getItem(NIGHT_KEY);
  if (saved === '1') nightOverride = true;
  if (saved === '0') nightOverride = false;
} catch { /* storage blocked: follow the system */ }
function autoNight() {
  return prefersDark.matches || clock.format(new Date()) === '04:17';
}
function updateNight() {
  night = nightOverride ?? autoNight();
  document.documentElement.classList.toggle('night-mode', night);
  let chrome = '#ffffff';
  if (night) chrome = '#000000';
  document.querySelector('meta[name=theme-color]').content = chrome;
  $('night').setAttribute('aria-pressed', String(night));
  let hint = 'Preview the late-night gallery';
  if (night) hint = 'Return to the daytime gallery';
  $('night').title = hint;
  for (const live of readyStations) live.theme(night);
  sceneView?.invalidate();
  drawMap();
}
$('night').addEventListener('click', () => {
  nightOverride = !night;
  // back in step with the system: stop overriding it
  if (nightOverride === autoNight()) nightOverride = undefined;
  try {
    if (nightOverride === undefined) localStorage.removeItem(NIGHT_KEY);
    else localStorage.setItem(NIGHT_KEY, String(Number(nightOverride)));
  } catch { /* fine */ }
  updateNight();
});
prefersDark.addEventListener('change', updateNight);
setInterval(updateNight, 1000);

const mapCanvas = $('map');
const plan = (() => {
  const xs = rooms.flatMap(room => [room.rect[0], room.rect[2]]);
  const zs = rooms.flatMap(room => [room.rect[1], room.rect[3]]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const pad = 8;
  const scale = Math.min((mapCanvas.width - pad * 2) / (maxX - minX), (mapCanvas.height - pad * 2) / (maxZ - minZ));
  const offX = (mapCanvas.width - (maxX - minX) * scale) / 2;
  const offZ = (mapCanvas.height - (maxZ - minZ) * scale) / 2;
  return {
    point: (x, z) => [offX + (x - minX) * scale, offZ + (z - minZ) * scale],
    world: (px, py) => [minX + (px - offX) / scale, minZ + (py - offZ) / scale],
    scale,
  };
})();
mapCanvas.addEventListener('click', event => {
  const bounds = mapCanvas.getBoundingClientRect();
  const [x, z] = plan.world((event.clientX - bounds.left) * mapCanvas.width / bounds.width, (event.clientY - bounds.top) * mapCanvas.height / bounds.height);
  const index = roomAt(x, z, -1);
  if (index >= 0) visit(index);
});

function tone(dayColor, nightColor) {
  if (night) return nightColor;
  return dayColor;
}

function drawMap(position, yaw) {
  const c = mapCanvas.getContext('2d');
  c.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
  for (const room of rooms) {
    const [x1, z1, x2, z2] = room.rect;
    const [x, y] = plan.point(x1, z1);
    const w = (x2 - x1) * plan.scale, h = (z2 - z1) * plan.scale;
    if (room.index === currentRoom) c.fillStyle = tone('#e4e4e4', '#333333');
    else c.fillStyle = tone('#ffffff', '#000000');
    c.strokeStyle = tone('#111111', '#ffffff'); c.fillRect(x, y, w, h); c.strokeRect(x + .5, y + .5, w - 1, h - 1);
    c.fillStyle = tone('#8a8a8a', '#8a8a8a'); c.font = '9px "Helvetica Neue", Helvetica, Arial, sans-serif'; c.textAlign = 'center';
    c.fillText(room.number, x + w / 2, y + h / 2 + 3);
  }
  c.strokeStyle = tone('#ffffff', '#000000'); c.lineWidth = 2;
  for (const [x, z, axis] of DATA.doors) {
    c.beginPath();
    if (axis === 'x') { c.moveTo(...plan.point(x, z - DOOR / 2)); c.lineTo(...plan.point(x, z + DOOR / 2)); }
    else { c.moveTo(...plan.point(x - DOOR / 2, z)); c.lineTo(...plan.point(x + DOOR / 2, z)); }
    c.stroke();
  }
  c.lineWidth = 1;
  const p = position ?? sceneView?.position?.() ?? {x: rooms[currentRoom].entry[0], z: rooms[currentRoom].entry[1]};
  const angle = yaw ?? sceneView?.yaw?.() ?? 0;
  const [x, y] = plan.point(p.x, p.z);
  c.save(); c.translate(x, y); c.rotate(-angle); c.fillStyle = tone('#111111', '#ffffff');
  c.beginPath(); c.moveTo(0, -7); c.lineTo(4.5, 4); c.lineTo(0, 2.5); c.lineTo(-4.5, 4); c.closePath(); c.fill(); c.restore();
}

function setRoom(index) {
  currentRoom = index;
  track('print-room-room', {room: rooms[index].number}, rooms[index].number);
  roomButtons.forEach((button, i) => {
    if (i === index) {
      button.setAttribute('aria-current', 'location');
      button.scrollIntoView({block: 'nearest', inline: 'nearest'});
    } else button.removeAttribute('aria-current');
  });
  const room = rooms[index];
  $('room-label').textContent = room.number;
  let next = 'Next ';
  if (index === rooms.length - 1) next = 'First ';
  $('tour').firstChild.textContent = next;
  // video rooms have no pieces to tour; the button rests there
  if (!tour) autoTour.classList.toggle('resting', !room.works.length);
  sceneView?.nearRoom?.(index);
  drawMap();
}
function visit(index) {
  stopTour();
  keys.clear();
  // the 3D view walks there when it can (setRoom follows the camera); otherwise cut
  if (sceneView?.travel) { sceneView.travel(index); return; }
  sceneView?.go(index);
  setRoom(index);
}
// stand in front of one work, wherever it hangs
function visitWork(work) {
  stopTour();
  keys.clear();
  if (sceneView?.standAt) {
    setRoom(work.room);
    sceneView.standAt(lookAtPrint(work).pose);
    return;
  }
  visit(work.room);
}

// ---------- seen: every print you stop in front of, kept in this browser ----------

const SEEN_KEY = 'print-room-seen';
const seen = new Set();
try {
  for (const id of JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]')) if (byId.has(id)) seen.add(id);
} catch { /* private window or blocked storage: start fresh */ }
const checklistButtons = new Map();
let seenFlash;

function seenIn(room) {
  return room.works.filter(id => seen.has(id)).length;
}
function paintSeen(index) {
  const room = rooms[index];
  const count = seenIn(room);
  const tally = roomButtons[index].querySelector('.room-seen');
  $('seen-count').textContent = `${seen.size} / ${works.length}`;
  if (isVideoRoom(room)) { tally.textContent = 'video'; return; }
  if (isScriptRoom(room)) { tally.textContent = 'live'; return; }
  tally.textContent = `${count}/${room.works.length}`;
  roomButtons[index].classList.toggle('complete', count === room.works.length);
  $('seen-count').textContent = `${seen.size} / ${works.length}`;
}
function markSeen(work) {
  if (seen.has(work.id)) return;
  seen.add(work.id);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen])); } catch { /* keep the tally in memory */ }
  checklistButtons.get(work.id)?.classList.add('seen');
  paintSeen(work.room);
  const room = rooms[work.room];
  const hud = $('seen');
  let note = '';
  if (seen.size === works.length) note = 'All';
  else if (seenIn(room) === room.works.length) note = `${room.number} ●`;
  if (!note) return;
  $('seen-note').textContent = note;
  hud.classList.add('flash');
  clearTimeout(seenFlash);
  seenFlash = setTimeout(() => hud.classList.remove('flash'), 3200);
}
rooms.forEach(room => paintSeen(room.index));
roomButtons.forEach((button, i) => button.addEventListener('click', () => visit(i)));
$('tour').addEventListener('click', () => {
  // during a tour, Next is the next piece; otherwise the next room
  if (tour) { stepTour(1); return; }
  visit((currentRoom + 1) % rooms.length);
});
$('reset').addEventListener('click', () => visit(currentRoom));

// ---------- tour: the room you're in, piece by piece, at a viewing distance ----------
// Walking off, looking around or opening a print only sets the tour aside; Resume
// glides you back to the piece you left. End (or Esc) ends it.

const HOLDS = [4, 8, 15, 30];
const HOLD_KEY = 'print-room-hold';
let holdSeconds = 8;
try {
  const saved = Number(localStorage.getItem(HOLD_KEY));
  if (HOLDS.includes(saved)) holdSeconds = saved;
} catch { /* storage blocked: default */ }
const holdButton = $('tour-hold');
function paintHold() {
  holdButton.textContent = `${holdSeconds} s`;
  holdButton.setAttribute('aria-label', `${holdSeconds} seconds on each piece`);
}
paintHold();
holdButton.addEventListener('click', () => {
  holdSeconds = HOLDS[(HOLDS.indexOf(holdSeconds) + 1) % HOLDS.length];
  try { localStorage.setItem(HOLD_KEY, String(holdSeconds)); } catch { /* fine */ }
  paintHold();
  if (tour) paintProgress();
});

function setTourControls(state) {
  const labels = {idle: 'Tour', playing: 'Pause', paused: 'Resume', finished: 'Again'};
  const icons = {idle: '▶', playing: 'Ⅱ', paused: '▶', finished: '↻'};
  $('auto-tour-label').textContent = labels[state];
  $('auto-tour-icon').textContent = icons[state];
  const off = state === 'idle' || state === 'finished';
  endTour.hidden = off;
  holdButton.hidden = off;
}

// start at the piece nearest to you, then carry on around the walls in hanging order
function tourOrder(room) {
  const pieces = room.works.map(id => byId.get(id));
  const here = sceneView?.position?.();
  let first = 0;
  if (here) {
    let best = Infinity;
    pieces.forEach((work, i) => {
      const d = Math.hypot(work.x - here.x, work.z - here.z);
      if (d < best) { best = d; first = i; }
    });
  }
  return [...pieces.slice(first), ...pieces.slice(0, first)];
}

function paintProgress() {
  tourProgress.firstElementChild.style.transform = `scaleX(${Math.min(1, tour.held / holdSeconds)})`;
}

function moveToStop() {
  const work = tour.order[tour.index];
  tour.phase = 'moving'; tour.held = 0; tour.last = undefined;
  tourCaption.hidden = false;
  $('tour-stop').textContent = `${tour.index + 1} / ${tour.order.length}`;
  $('tour-title').textContent = work.title;
  $('tour-medium').textContent = `${work.year} · ${work.medium}`;
  paintProgress();
  const token = {};
  tour.token = token;
  sceneView.tourTo(work, () => {
    if (!tour || tour.token !== token) return;
    tour.phase = 'holding';
    queueTourFrame();
  });
}

function queueTourFrame() {
  if (tour?.playing && tour.phase === 'holding' && !tour.frame && !document.hidden) tour.frame = requestAnimationFrame(advanceTour);
}

function advanceTour(now) {
  tour.frame = 0;
  if (!tour.playing || tour.phase !== 'holding' || document.hidden) return;
  if (tour.last !== undefined) tour.held += Math.min(100, now - tour.last) / 1000;
  tour.last = now;
  paintProgress();
  if (tour.held >= holdSeconds) stepTour(1);
  else queueTourFrame();
}

function stepTour(by) {
  const index = tour.index + by;
  if (index >= tour.order.length) { finishTour('finished'); return; }
  tour.index = Math.max(0, index);
  tour.playing = true;
  setTourControls('playing');
  moveToStop();
}

function pauseTour() {
  tour.playing = false;
  cancelAnimationFrame(tour.frame);
  tour.frame = 0; tour.last = undefined;
  setTourControls('paused');
}

// any hands-on move (walk, drag, kick, inspect, another room): set the tour aside
function stopTour() {
  if (!tour || tour.phase === 'away') return;
  pauseTour();
  tour.phase = 'away';
  tour.token = undefined;
}

function finishTour(state = 'idle') {
  if (!tour) return;
  cancelAnimationFrame(tour.frame);
  tour = undefined;
  sceneView?.clearTour?.();
  tourCaption.hidden = true;
  tourProgress.hidden = true;
  setTourControls(state);
  if (document.activeElement === endTour || document.activeElement === holdButton) autoTour.focus();
}

autoTour.addEventListener('click', () => {
  if (tour?.playing) { pauseTour(); return; }
  if (tour) {
    tour.playing = true;
    setTourControls('playing');
    if (tour.phase === 'away') moveToStop();
    else queueTourFrame();
    return;
  }
  const order = tourOrder(rooms[currentRoom]);
  if (!order.length) return;  // a video room: nothing to step through
  track('print-room-tour', {room: rooms[currentRoom].number}, rooms[currentRoom].number);
  keys.clear();
  tour = {order, index: 0, held: 0, playing: true, frame: 0};
  tourProgress.hidden = false;
  setTourControls('playing');
  moveToStop();
});
endTour.addEventListener('click', () => finishTour());
document.addEventListener('visibilitychange', () => {
  if (!tour) return;
  tour.last = undefined;
  if (document.hidden) {
    cancelAnimationFrame(tour.frame);
    tour.frame = 0;
  } else queueTourFrame();
});

function showPrint(work, restoreFocus) {
  stopTour();
  if (indexDialog.open) indexDialog.close();
  if (!printDialog.open) lastFocus = restoreFocus ?? document.activeElement;
  keys.clear();
  const room = rooms[work.room];
  track('print-room-work', {work: work.id, room: room.number}, work.id);
  $('piece-room').textContent = room.number;
  $('piece-title').textContent = `${work.title}, ${work.year}`;
  $('piece-medium').textContent = work.medium;
  $('piece-size').textContent = `${work.dimensions.map(v => v.toLocaleString('en-US')).join(' × ')} px`;
  $('original').href = work.url;
  print.alt = work.title;
  print.classList.toggle('dither', work.dither);
  print.hidden = true;
  $('print-status').textContent = 'Loading';
  if (!printDialog.open) printDialog.showModal();
  zoom = 1; panX = 0; panY = 0;
  print.src = work.original;
  if (print.complete && print.naturalWidth) fitPrint();
  history.replaceState(null, '', `#${work.id}`);
  markSeen(work);
  showNeighbours(work);
}
// the works an image model finds most like this one, wherever they hang
function showNeighbours(work) {
  const list = $('near-list');
  list.replaceChildren();
  for (const id of work.near ?? []) {
    const other = byId.get(id);
    if (!other) continue;
    const room = rooms[other.room];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'near';
    button.setAttribute('aria-label', `Inspect ${other.title}, room ${room.number}`);
    const image = new Image(); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
    image.src = other.texture(240);
    if (other.dither) image.classList.add('dither');
    const label = document.createElement('span');
    let where = room.number;
    if (other.room === work.room) where = 'here';
    label.textContent = `${other.id} · ${where}`;
    button.classList.toggle('seen', seen.has(other.id));
    button.append(image, label);
    button.addEventListener('click', () => { visitWork(other); showPrint(other); });
    list.append(button);
  }
}
function fitPrint() {
  if (!printDialog.open || !print.naturalWidth) return;
  const factor = Math.min(1, (stage.clientWidth - 24) / print.naturalWidth, (stage.clientHeight - 24) / print.naturalHeight);
  fitWidth = print.naturalWidth * factor; fitHeight = print.naturalHeight * factor;
  print.width = Math.round(fitWidth); print.height = Math.round(fitHeight);
  print.hidden = false;
  $('print-status').textContent = '';
  renderPrint();
}
function renderPrint() {
  const maxX = Math.max(0, (fitWidth * zoom - stage.clientWidth) / 2);
  const maxY = Math.max(0, (fitHeight * zoom - stage.clientHeight) / 2);
  panX = Math.min(maxX, Math.max(-maxX, panX)); panY = Math.min(maxY, Math.max(-maxY, panY));
  print.style.transform = `translate(calc(-50% + ${panX}px),calc(-50% + ${panY}px)) scale(${zoom})`;
  let label = `${Math.round(zoom * 100)}%`;
  if (zoom === 1) label = 'Fit';
  $('zoom-reset').textContent = label;
  $('zoom-out').disabled = zoom <= 1; $('zoom-in').disabled = zoom >= maxZoom();
}
function maxZoom() { return Math.min(12, Math.max(4, print.naturalWidth / Math.max(1, fitWidth))); }
function magnify(factor, clientX, clientY) {
  if (print.hidden) return;
  const previous = zoom;
  zoom = Math.min(maxZoom(), Math.max(1, zoom * factor));
  const bounds = stage.getBoundingClientRect();
  let x = 0, y = 0;
  if (clientX !== undefined) { x = clientX - bounds.left - bounds.width / 2; y = clientY - bounds.top - bounds.height / 2; }
  panX = x - (x - panX) * zoom / previous; panY = y - (y - panY) * zoom / previous;
  renderPrint();
}
print.addEventListener('load', fitPrint);
print.addEventListener('error', () => { $('print-status').textContent = 'Not available. See the page.'; });
$('zoom-in').addEventListener('click', () => magnify(1.5));
$('zoom-out').addEventListener('click', () => magnify(1 / 1.5));
$('zoom-reset').addEventListener('click', () => { zoom = 1; panX = 0; panY = 0; renderPrint(); });
stage.addEventListener('wheel', event => {
  event.preventDefault();
  let factor = 1 / 1.15;
  if (event.deltaY < 0) factor = 1.15;
  magnify(factor, event.clientX, event.clientY);
}, {passive: false});
stage.addEventListener('keydown', event => {
  if (!['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === '+' || event.key === '=') magnify(1.5);
  if (event.key === '-') magnify(1 / 1.5);
  if (event.key === '0') $('zoom-reset').click();
  if (event.key === 'ArrowLeft') panX += 40;
  if (event.key === 'ArrowRight') panX -= 40;
  if (event.key === 'ArrowUp') panY += 40;
  if (event.key === 'ArrowDown') panY -= 40;
  renderPrint();
});
stage.addEventListener('pointerdown', event => { stage.setPointerCapture(event.pointerId); activePrintDrag = {x: event.clientX, y: event.clientY}; });
stage.addEventListener('pointermove', event => {
  if (!activePrintDrag) return;
  panX += event.clientX - activePrintDrag.x; panY += event.clientY - activePrintDrag.y;
  activePrintDrag = {x: event.clientX, y: event.clientY}; renderPrint();
});
stage.addEventListener('lostpointercapture', () => { activePrintDrag = undefined; });
new ResizeObserver(fitPrint).observe(stage);
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
printDialog.addEventListener('close', () => {
  history.replaceState(null, '', location.pathname + location.search);
  lastFocus?.focus();
});
indexDialog.addEventListener('close', () => { if (!printDialog.open) $('checklist').focus(); });
$('checklist').addEventListener('click', () => { stopTour(); keys.clear(); indexDialog.showModal(); });
for (const room of rooms.filter(room => room.works.length)) {
  const section = document.createElement('section');
  const heading = document.createElement('h3'); heading.textContent = room.number; section.append(heading);
  for (const id of room.works) {
    const work = byId.get(id);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'index-piece'; button.textContent = work.title;
    const medium = document.createElement('small'); medium.textContent = `${work.year} · ${work.medium}`; button.append(medium);
    button.classList.toggle('seen', seen.has(work.id));
    checklistButtons.set(work.id, button);
    button.addEventListener('click', () => { visitWork(work); showPrint(work, $('checklist')); });
    section.append(button);
  }
  $('index-list').append(section);
}

const moveKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE']);
window.addEventListener('keydown', event => {
  if (printDialog.open || indexDialog.open || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.code === 'Escape' && tour) { event.preventDefault(); finishTour(); return; }
  // on tour, the arrows step through the pieces
  if (tour && (event.code === 'ArrowRight' || event.code === 'ArrowLeft') && (event.target === document.body || event.target.tagName === 'CANVAS')) {
    event.preventDefault();
    let by = 1;
    if (event.code === 'ArrowLeft') by = -1;
    stepTour(by);
    return;
  }
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') { keys.add('Shift'); return; }
  if (event.code === 'Space' && (event.target === document.body || event.target.tagName === 'CANVAS')) {
    event.preventDefault();
    if (!event.repeat) { stopTour(); sceneView?.kick?.(); }
    return;
  }
  if (!moveKeys.has(event.code)) return;
  if (event.target !== document.body && event.target.tagName !== 'CANVAS' && event.code.startsWith('Arrow')) return;
  event.preventDefault(); stopTour(); keys.add(event.code); sceneView?.invalidate();
});
window.addEventListener('keyup', event => {
  keys.delete(event.code);
  if (!event.shiftKey) keys.delete('Shift');
});
window.addEventListener('blur', () => keys.clear());

// ---------- flat fallback (no WebGL) ----------

function fallback() {
  track('print-room-flat', {});
  const mount = $('mount');
  view.dataset.mode = 'images';
  mount.innerHTML = ''; mount.classList.add('flat-mount');
  const grid = document.createElement('div'); grid.className = 'flat-room';
  mount.append(grid);
  // the scripts on show in the flat view, stepped while they are on the page
  // one frame loop at most: it stops itself when the room's stations leave the page
  let flatLive = [], flatLast = 0, flatFrame = 0;
  function runFlat(now) {
    flatFrame = 0;
    const live = flatLive.filter(entry => entry.art.isConnected);
    if (!live.length) { flatLast = 0; return; }
    let seconds = 0;
    if (flatLast) seconds = Math.min(.1, (now - flatLast) / 1000);
    flatLast = now;
    for (const entry of live) entry.step(seconds);
    flatFrame = requestAnimationFrame(runFlat);
  }
  function go(index, workAtStop, touring = false) {
    grid.replaceChildren();
    grid.classList.toggle('flat-spotlight', Boolean(workAtStop));
    grid.classList.toggle('flat-salon', touring && !workAtStop);
    let shown = works.filter(piece => piece.room === index);
    if (workAtStop) shown = [workAtStop];
    for (const work of shown) {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('aria-label', `Inspect ${work.title}`);
      const image = new Image(); image.alt = '';
      if (workAtStop) { image.src = work.texture(2048); image.loading = 'eager'; }
      else { image.src = work.texture(PREVIEW); image.loading = 'lazy'; }
      const label = document.createElement('span'); label.textContent = work.title;
      button.append(image, label); button.addEventListener('click', () => showPrint(work)); grid.append(button);
    }
    // a script room without 3D: the picture and the code, side by side, still running
    flatLive = [];
    for (const screen of rooms[index].screens ?? []) {
      if (screen.kind !== 'script') continue;
      const pair = document.createElement('div'); pair.className = 'flat-live';
      grid.append(pair);
      liveStation(screen).then(live => {
        if (!pair.isConnected) return;
        pair.append(live.art, live.code);
        flatLive.push(live);
        if (!flatFrame) flatFrame = requestAnimationFrame(runFlat);
      }).catch(error => console.warn(screen.id, error));
    }
    // a video room without 3D: just the clips, muted and looping
    const clips = new Set((rooms[index].screens ?? []).flatMap(screen => screen.src ?? []));
    for (const src of clips) {
      const video = document.createElement('video');
      video.src = src; video.muted = true; video.loop = true; video.autoplay = true; video.playsInline = true;
      video.setAttribute('playsinline', ''); video.className = 'flat-video';
      video.addEventListener('click', () => video.play().catch(() => {}));  // autoplay refused: tap starts it
      grid.append(video);
    }
  }
  $('status').hidden = true;
  autoTour.disabled = false;
  $('reset').hidden = true;
  document.querySelector('.desktop-help').textContent = 'Click';
  $('touch-hint').hidden = true;
  go(currentRoom);
  return {
    go,
    invalidate() {},
    tourTo(work, arrive) { if (work.room !== currentRoom) setRoom(work.room); go(work.room, work, true); arrive(); },
    clearTour() { go(currentRoom); },
  };
}

// ---------- walkable 3D ----------

function walkable(T) {
  const renderer = new T.WebGLRenderer({antialias: true, powerPreference: 'high-performance'});
  renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.NoToneMapping;
  renderer.domElement.tabIndex = 0; renderer.domElement.setAttribute('aria-label', '3D gallery. Use WASD to move, Q and E to turn, or drag to look.');
  const canvas = renderer.domElement; $('mount').append(canvas);
  const scene = new T.Scene(); scene.background = new T.Color(0xdcdcdc);
  // fog to the background colour so rooms beyond the drawn window fade instead of popping
  const dayAir = new T.Color(0xdcdcdc), nightAir = new T.Color(0x000000);
  const markerDay = new T.Color(0x111111), markerNight = new T.Color(0xf2f2f2);
  scene.fog = new T.Fog(scene.background, 24, 64);
  const camera = new T.PerspectiveCamera(58, 1, .07, 90); camera.rotation.order = 'YXZ';
  const {faces, palette, roomGroups, screenSlots, screenGlows, scriptMounts} = buildSpace(T, scene, works);
  // ---------- live scripts: compile when you come near, run only in the room you're in ----------
  function scriptsNear(index) {
    for (const mount of scriptMounts) {
      if (mount.live || !near(mount.room, index, 1)) continue;
      mount.live = 'loading';
      liveStation(mount.screen).then(live => {
        mount.live = live;
        for (const [material, canvas] of [[mount.art, live.art], [mount.code, live.code]]) {
          const texture = new T.CanvasTexture(canvas);
          texture.colorSpace = T.SRGBColorSpace;
          texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
          material.map = texture; material.color.setHex(0xffffff); material.needsUpdate = true;
        }
        track('print-room-script', {script: mount.screen.id}, mount.screen.id);
        invalidate();
      }).catch(error => { console.warn(mount.screen.id, error); mount.live = 'failed'; });
    }
  }
  const facing = new T.Vector3(), toward = new T.Vector3();
  // step the scripts in this room; repaint the textures of those you can see. True while any run.
  function stepScripts(seconds) {
    let running = false;
    camera.getWorldDirection(facing);
    for (const mount of scriptMounts) {
      if (mount.room !== currentRoom || typeof mount.live !== 'object') continue;
      mount.live.step(seconds);
      running = true;
      mount.center.getWorldPosition(toward).sub(camera.position);
      if (toward.length() > 16 || toward.normalize().dot(facing) < .2) continue;
      mount.art.map.needsUpdate = true; mount.code.map.needsUpdate = true;
    }
    return running;
  }
  // ---------- video: one <video> per clip, loaded and playing only within a room of you ----------
  const channels = new Map();
  for (const slot of screenSlots) {
    if (!channels.has(slot.src)) channels.set(slot.src, {slots: [], rooms: new Set()});
    channels.get(slot.src).slots.push(slot);
    channels.get(slot.src).rooms.add(slot.room);
  }
  function tune(src, channel) {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous'; video.muted = true; video.loop = true; video.playsInline = true;
    video.setAttribute('playsinline', ''); video.preload = 'auto'; video.src = src;
    channel.video = video;
    channel.texture = new T.VideoTexture(video);
    channel.texture.colorSpace = T.SRGBColorSpace;
    // each new frame asks for one render, so the page still idles between frames
    // one callback chain per clip: a pause ends it, the next 'playing' starts it again
    let waiting = false;
    const ask = () => {
      if (waiting || video.paused || !video.requestVideoFrameCallback) return;
      waiting = true; video.requestVideoFrameCallback(onFrame);
    };
    const onFrame = () => { waiting = false; sample(channel); updateScreens(); invalidate(); ask(); };
    video.addEventListener('playing', () => { channel.started = true; updateScreens(); ask(); invalidate(); });
  }
  // how bright the picture is right now: a tiny draw, read back, ten times a second per clip
  const probe = document.createElement('canvas'); probe.width = 8; probe.height = 6;
  const probeContext = probe.getContext('2d', {willReadFrequently: true});
  function sample(channel) {
    const now = performance.now();
    if (now - (channel.sampled ?? 0) < 100) return;
    channel.sampled = now;
    try {
      probeContext.drawImage(channel.video, 0, 0, 8, 6);
      const pixels = probeContext.getImageData(0, 0, 8, 6).data;
      let sum = 0;
      for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
      const level = sum / (pixels.length / 4) / 765;
      channel.level = (channel.level ?? level) * .4 + level * .6;
    } catch { channel.level = .35; /* a tainted frame: glow at a steady middle */ }
  }
  // every so often the whole stack snaps to one channel for a beat, then scatters back
  const UNISON_EVERY = 26, UNISON_FOR = 2.6;
  function updateScreens() {
    const t = performance.now() / 1000;
    const together = t % UNISON_EVERY < UNISON_FOR;
    for (const glow of screenGlows) {
      const lead = glow.src[Math.floor(t / UNISON_EVERY) % glow.src.length];
      let light = 0, lit = 0;
      for (const slot of glow.slots) {
        let channel = channels.get(slot.src);
        if (together && glow.kind === 'crt' && channels.get(lead).started) channel = channels.get(lead);
        if (!channel.started) {
          // not playing (yet, or ever): a dead tube, not someone else's picture
          if (slot.material.map) { slot.material.map = null; slot.material.color.setHex(0x0b0b0b); slot.material.needsUpdate = true; }
          continue;
        }
        if (slot.material.map !== channel.texture) {
          slot.material.map = channel.texture; slot.material.color.setHex(0xffffff); slot.material.needsUpdate = true;
        }
        light += channel.level ?? .3; lit += 1;
      }
      let level = 0;
      if (lit) level = light / lit;
      // the stack's glow follows its pictures; a projection throws more
      let gain = .5;
      if (glow.kind !== 'crt') gain = .7;
      glow.halo.color.setScalar(level * gain * .55);
      glow.pool.color.setScalar(level * gain * .4);
    }
  }
  function screensNear(index) {
    for (const [src, channel] of channels) {
      const live = [...channel.rooms].some(room => near(room, index, 1));
      if (live && !channel.video) tune(src, channel);
      if (!channel.video) continue;
      if (live) channel.video.play().catch(() => { /* autoplay refused: the next tap starts it */ });
      else channel.video.pause();
    }
  }
  // some browsers only start video after a gesture
  addEventListener('pointerdown', () => screensNear(currentRoom));
  function videoPlaying() {
    for (const channel of channels.values()) if (channel.video && !channel.video.paused) return true;
    return false;
  }
  // where a floor click is headed
  const marker = new T.Mesh(new T.RingGeometry(.17, .23, 40), new T.MeshBasicMaterial({color: 0x111111, toneMapped: false, transparent: true, opacity: .85, depthWrite: false}));
  marker.rotation.x = -Math.PI / 2; marker.visible = false; scene.add(marker);
  const pileRect = rooms[PILE_ROOM].rect;
  const pile = makePile(T, {
    count: PILE_COUNT,
    rect: pileRect,
    inside: (x, z) => insideRect(pileRect, x, z, .2),
    works,
    thumb: work => work.texture(160),
    onchange: () => { if (pileActive()) invalidate(); },
  });
  roomGroups[PILE_ROOM].add(pile.mesh);
  const paperDay = new T.Color(0xffffff), paperNight = new T.Color(0x5a5a5a);
  const foot = {x: 0, z: 0};
  function pileActive() {
    return Math.abs(currentRoom - PILE_ROOM) <= 1;
  }
  function kick() {
    if (!pileActive()) return;
    const dirX = -Math.sin(yaw), dirZ = -Math.cos(yaw);
    if (pile.kick(camera.position.x + dirX * .75, camera.position.z + dirZ * .75, dirX, dirZ)) invalidate();
  }
  const ground = new T.Plane(new T.Vector3(0, 1, 0), 0);
  const target = new T.Vector3();
  const velocity = {x: 0, z: 0};
  let stride = 0;
  let glide;
  let dwell;
  const loader = new T.TextureLoader(); loader.setCrossOrigin('anonymous');
  const ray = new T.Raycaster(), pointer = new T.Vector2();
  let yaw = 0, pitch = 0, light = Number(night), frame = 0, last = 0, active = false, drag;
  // hold the middle mouse button to zoom, eased in and out like a spyglass
  const ZOOM = 4;
  let baseFov = 58, zoom = 1, zoomTarget = 1;
  function applyZoom() {
    camera.fov = 2 * Math.atan(Math.tan(baseFov * Math.PI / 360) / zoom) * 180 / Math.PI;
    camera.updateProjectionMatrix();
  }
  function easeZoom(wall) {
    if (zoom === zoomTarget) return false;
    if (reducedMotion.matches) zoom = zoomTarget;
    else zoom += (zoomTarget - zoom) * (1 - Math.exp(-wall * 11));
    if (Math.abs(zoomTarget - zoom) < .004) zoom = zoomTarget;
    applyZoom();
    return zoom !== zoomTarget;
  }
  const sharpFaces = [];
  let sharpRequest;
  const forward = new T.Vector3();
  const printPosition = new T.Vector3();
  const offset = new T.Vector3();
  const coarse = matchMedia('(pointer: coarse)').matches;
  // a 4K texture is ~45–90 MB of GPU memory; phones get 2K ones
  let SHARP_KEEP = 3;
  if (coarse) SHARP_KEEP = 2;

  function configure(texture, work) {
    texture.colorSpace = T.SRGBColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    // dither stays crisp pixels at every size, preview included; smoothing it reads as blur
    if (work.dither) texture.magFilter = T.NearestFilter;
    return texture;
  }
  function assign(face, texture) {
    face.material.map = texture; face.material.color.setHex(0xffffff); face.material.needsUpdate = true;
    invalidate();
  }
  function blank(face) {
    face.material.map = null; face.material.color.setHex(0xd6d6d4); face.material.needsUpdate = true;
  }

  // only rooms near the visitor are drawn and textured; far rooms are hidden and freed
  const near = (room, around, reach) => Math.abs(room - around) <= reach;
  function loadPreview(face) {
    const data = face.userData;
    if (data.preview || data.loading) return data.loading ?? Promise.resolve();
    const work = data.work;
    data.loading = loader.loadAsync(work.texture(PREVIEW)).catch(() => loader.loadAsync(work.original)).then(texture => {
      if (!near(work.room, currentRoom, 2)) { texture.dispose(); return; }
      data.preview = configure(texture, work);
      if (data.sharp) return;
      assign(face, texture);
    }).finally(() => { data.loading = undefined; });
    return data.loading;
  }
  function release(face) {
    const data = face.userData;
    dropSharp(face);
    data.preview?.dispose(); delete data.preview;
    blank(face);
  }
  function nearRoom(index) {
    roomGroups.forEach((group, i) => { group.visible = near(i, index, 2); });
    screensNear(index);
    scriptsNear(index);
    for (const face of faces) {
      const room = face.userData.work.room;
      if (near(room, index, 1)) loadPreview(face).catch(() => {});
      else if (!near(room, index, 2) && face.userData.preview) release(face);
    }
    invalidate();
  }

  function aim(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) * 2 / rect.width - 1, 1 - (event.clientY - rect.top) * 2 / rect.height);
    ray.setFromCamera(pointer, camera);
  }
  function pick(event) {
    aim(event);
    const hit = ray.intersectObjects(faces.filter(face => face.userData.work.room === currentRoom), false)[0];
    return hit?.object;
  }
  function go(index) {
    const pose = entryView(rooms[index]);
    glide = undefined; marker.visible = false;
    velocity.x = 0; velocity.z = 0;
    camera.position.set(pose.x, EYE_HEIGHT, pose.z);
    yaw = pose.yaw; pitch = pose.pitch;
    if (!reducedMotion.matches && active) view.animate([{opacity: .54}, {opacity: 1}], {duration: 280, easing: 'ease-out'});
    active = true; invalidate();
  }
  function updateCurrentRoom() {
    const room = roomAt(camera.position.x, camera.position.z, currentRoom);
    if (room !== currentRoom) setRoom(room);
  }
  // the tour: a slow glide to a viewing spot in front of the work; a cut if it hangs in another room
  function tourTo(work, arrive) {
    keys.clear();
    const pose = lookAtPrint(work).pose;
    if (roomAt(camera.position.x, camera.position.z, currentRoom) !== work.room) {
      setRoom(work.room);
      standAt(pose);
      arrive();
      return;
    }
    glideAlong([pose], arrive, true);
  }
  function resize() {
    const w = view.clientWidth, h = view.clientHeight;
    if (!w || !h) return;
    const ratio = w / h; camera.aspect = ratio;
    camera.fov = 58;
    if (ratio < 1) camera.fov = Math.min(91, 58 + (1 - ratio) * 54);
    baseFov = camera.fov; applyZoom(); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(w, h, false); invalidate();
  }
  function invalidate() {
    if (!frame) frame = requestAnimationFrame(render);
  }
  // walking has weight: velocity eases toward the keys, the head bobs with the stride
  function step(dt) {
    const forwardAmount = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
    const strafeAmount = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    const turnAmount = Number(keys.has('KeyQ')) - Number(keys.has('KeyE'));
    if (turnAmount) yaw += turnAmount * dt * 1.7;
    let speed = 3.4;
    if (keys.has('Shift')) speed = 7;
    const scale = speed / (Math.hypot(forwardAmount, strafeAmount) || 1);
    const wantX = (strafeAmount * Math.cos(yaw) - forwardAmount * Math.sin(yaw)) * scale;
    const wantZ = (-strafeAmount * Math.sin(yaw) - forwardAmount * Math.cos(yaw)) * scale;
    const ease = Math.min(1, dt * 9);
    velocity.x += (wantX - velocity.x) * ease;
    velocity.z += (wantZ - velocity.z) * ease;
    if (Math.hypot(velocity.x, velocity.z) < .02 && !forwardAmount && !strafeAmount) { velocity.x = 0; velocity.z = 0; }
    move(velocity.x * dt, velocity.z * dt);
    const pace = Math.hypot(velocity.x, velocity.z);
    stride += pace * dt * 2.1;
    let lift = 0;
    if (pace > .05) lift = Math.abs(Math.sin(stride)) * .045 * Math.min(1, pace / 3.4) - .02;
    camera.position.y += (EYE_HEIGHT + lift - camera.position.y) * Math.min(1, dt * 14);
  }
  function move(dx, dz) {
    const p = camera.position;
    // a tour pose can leave the visitor on a blocked spot; let them walk off it
    const stuck = !canStand(p.x, p.z) && roomAt(p.x, p.z, -1) >= 0;
    if (stuck || canStand(p.x + dx, p.z)) p.x += dx;
    else velocity.x = 0;
    if (stuck || canStand(p.x, p.z + dz)) p.z += dz;
    else velocity.z = 0;
    updateCurrentRoom();
  }
  function steering() {
    return [...keys].some(key => key !== 'Shift');
  }
  function walking() {
    return steering() || Math.hypot(velocity.x, velocity.z) > 0 || Math.abs(camera.position.y - EYE_HEIGHT) > .002;
  }

  // ---------- glides: walking on your behalf (room list, map, clicks) ----------
  function place(pose) {
    camera.position.set(pose.x, EYE_HEIGHT, pose.z);
    yaw = pose.yaw; pitch = pose.pitch;
    updateCurrentRoom();
  }
  function clearPath(a, b) {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    for (let s = .2; s < length; s += .2) {
      if (onBench(a.x + (b.x - a.x) * s / length, a.z + (b.z - a.z) * s / length)) return false;
    }
    return true;
  }
  // step around a bench rather than through it
  function detour(a, b) {
    if (clearPath(a, b)) return;
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    let bench = DATA.benches[0];
    for (const candidate of DATA.benches) {
      if (Math.hypot(candidate[0] - mx, candidate[1] - mz) < Math.hypot(bench[0] - mx, bench[1] - mz)) bench = candidate;
    }
    const [bx, bz, width, alongX] = bench;
    const around = [[0, 1.3], [0, -1.3], [width / 2 + 1, 0], [-width / 2 - 1, 0], [width / 2 + 1, 1.3], [-width / 2 - 1, 1.3], [width / 2 + 1, -1.3], [-width / 2 - 1, -1.3]];
    for (const [along, across] of around) {
      let x = bx + along, z = bz + across;
      if (!alongX) { x = bx + across; z = bz + along; }
      const via = {x, z};
      if (canStand(x, z) && clearPath(a, via) && clearPath(via, b)) return via;
    }
  }
  function glideAlong(poses, arrive, gentle = false) {
    velocity.x = 0; velocity.z = 0;
    glide = undefined;
    if (reducedMotion.matches) {
      marker.visible = false;
      place(poses.at(-1)); invalidate(); arrive?.();
      return;
    }
    const points = [{x: camera.position.x, z: camera.position.z, yaw, pitch}];
    for (const pose of poses) {
      const via = detour(points.at(-1), pose);
      if (via) {
        const previous = points.at(-1);
        const facing = viewFrom(via.x, via.z, [via.x + (via.x - previous.x), EYE_HEIGHT, via.z + (via.z - previous.z)]);
        const turn = facing.yaw - previous.yaw;
        points.push({...facing, pitch: (previous.pitch + pose.pitch) / 2, yaw: previous.yaw + Math.atan2(Math.sin(turn), Math.cos(turn))});
      }
      const previous = points.at(-1);
      const turn = pose.yaw - previous.yaw;
      // unwrap so every turn goes the short way round
      points.push({...pose, yaw: previous.yaw + Math.atan2(Math.sin(turn), Math.cos(turn))});
    }
    const lengths = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      lengths.push(lengths[i - 1] + Math.max(.05, Math.hypot(b.x - a.x, b.z - a.z) + Math.abs(b.yaw - a.yaw) * .9));
    }
    const total = lengths.at(-1);
    let duration = Math.min(5, Math.max(.45, .35 + total / 7));
    // the tour strolls: a few unhurried seconds from piece to piece
    if (gentle) duration = Math.min(9, Math.max(2.4, 1.2 + total / 1.5));
    glide = {points, lengths, total, elapsed: 0, duration, arrive};
    invalidate();
  }
  function advanceGlide(dt) {
    glide.elapsed += dt;
    const t = Math.min(1, glide.elapsed / glide.duration);
    const along = t * t * (3 - 2 * t) * glide.total;
    let i = 1;
    while (i < glide.lengths.length - 1 && glide.lengths[i] < along) i++;
    const a = glide.points[i - 1], b = glide.points[i];
    const f = Math.min(1, Math.max(0, (along - glide.lengths[i - 1]) / (glide.lengths[i] - glide.lengths[i - 1])));
    camera.position.x = a.x + (b.x - a.x) * f;
    camera.position.z = a.z + (b.z - a.z) * f;
    yaw = a.yaw + (b.yaw - a.yaw) * f;
    pitch = a.pitch + (b.pitch - a.pitch) * f;
    // a gentle stride while gliding, settling at the end
    stride += dt * 6;
    camera.position.y = EYE_HEIGHT + Math.abs(Math.sin(stride)) * .03 * Math.sin(Math.PI * t);
    updateCurrentRoom();
    if (t < 1) return;
    const arrive = glide.arrive;
    glide = undefined;
    marker.visible = false;
    camera.position.y = EYE_HEIGHT;
    arrive?.();
  }
  function heading(from, to) {
    return viewFrom(to[0], to[1], [to[0] + (to[0] - from[0]), EYE_HEIGHT, to[1] + (to[1] - from[1])]);
  }
  // room list, map and Next room: walk through the doors when the room is close, cut when it isn't
  function travel(index) {
    const from = currentRoom;
    if (index === from || Math.abs(index - from) > 2 || !active) {
      go(index); setRoom(index);
      return;
    }
    const poses = [];
    const direction = Math.sign(index - from);
    let here = [camera.position.x, camera.position.z];
    for (let k = from; k !== index; k += direction) {
      // the door between rooms k and k±1 belongs to the later room
      const door = rooms[Math.max(k, k + direction)].door;
      poses.push(heading(here, door));
      here = door;
    }
    const [cx, cz] = centre(rooms[index]);
    const reach = Math.hypot(cx - here[0], cz - here[1]);
    const x = here[0] + (cx - here[0]) / reach * 2.2;
    const z = here[1] + (cz - here[1]) / reach * 2.2;
    poses.push(viewFrom(x, z, [cx + (cx - x), 2.1, cz + (cz - z)]));
    glideAlong(poses, () => setRoom(index));
  }
  function standAt(pose) {
    glide = undefined; marker.visible = false;
    velocity.x = 0; velocity.z = 0;
    place(pose);
    if (!reducedMotion.matches) view.animate([{opacity: .54}, {opacity: 1}], {duration: 280, easing: 'ease-out'});
    invalidate();
  }
  // a click on a print: walk up to it, and inspect it once you're there
  function approach(work, face) {
    face.getWorldPosition(printPosition);
    camera.getWorldDirection(forward);
    offset.subVectors(printPosition, camera.position);
    const d = offset.length();
    if (d < 4.8 && offset.dot(forward) / d > .55) { showPrint(work, canvas); return; }
    glideAlong([lookAtPrint(work).pose]);
  }
  // a click on the floor: walk toward it until a wall or bench is in the way
  function walkTo(event) {
    aim(event);
    if (!ray.ray.intersectPlane(ground, target)) return;
    const p = camera.position;
    const dx = target.x - p.x, dz = target.z - p.z;
    const distance = Math.min(30, Math.hypot(dx, dz));
    if (distance < .4) return;
    let reach = 0;
    for (let s = .15; s <= distance; s += .15) {
      if (!canStand(p.x + dx / Math.hypot(dx, dz) * s, p.z + dz / Math.hypot(dx, dz) * s)) break;
      reach = s;
    }
    reach = Math.max(0, reach - .35);
    if (reach < .4) return;
    const x = p.x + dx / Math.hypot(dx, dz) * reach;
    const z = p.z + dz / Math.hypot(dx, dz) * reach;
    marker.position.set(x, .012, z); marker.visible = true;
    glideAlong([{x, z, yaw, pitch: pitch * .5}]);
  }
  // swap in a sharper texture for the one print the visitor is standing in front of
  function refine() {
    camera.getWorldDirection(forward);
    // the print you're looking at: the one nearest the middle of the view, within reach
    // (zoomed in, a far print fills the view as a near one would: same test, scaled)
    let candidate, centred = -1;
    // judge by where the zoom is headed, so the sharp copy is requested the moment you press
    const reach = Math.max(zoom, zoomTarget);
    const cone = Math.cos(Math.atan(Math.tan(Math.acos(.65)) / reach));
    for (const face of faces) {
      const work = face.userData.work;
      if (work.room !== currentRoom || !face.userData.preview) continue;
      face.getWorldPosition(printPosition);
      offset.subVectors(printPosition, camera.position);
      const d = offset.length();
      const aim = offset.dot(forward) / d;
      if (d / reach > 4.6 || aim < cone || aim <= centred) continue;
      candidate = face; centred = aim;
    }
    // stopping in front of a print for a moment counts as seeing it; walking past doesn't
    const still = !glide && Math.hypot(velocity.x, velocity.z) < .6;
    if (!candidate || !still) dwell = undefined;
    else if (dwell?.face !== candidate) {
      dwell = {face: candidate, since: performance.now()};
      setTimeout(invalidate, 750);
    } else if (performance.now() - dwell.since >= 700) markSeen(candidate.userData.work);
    if (candidate && (Math.max(candidate.userData.work.w, candidate.userData.work.hw || 0) <= PREVIEW || candidate.userData.sharpFailed)) candidate = undefined;
    if (!candidate) return;
    // already sharp: keep it, and mark it most recently looked at
    if (candidate.userData.sharp) {
      sharpFaces.splice(sharpFaces.indexOf(candidate), 1); sharpFaces.push(candidate);
      return;
    }
    if (sharpRequest) return;
    sharpRequest = candidate;
    const work = candidate.userData.work;
    let limit = 4096;
    if (coarse) limit = 2048;
    limit = Math.min(renderer.capabilities.maxTextureSize, limit);
    loader.loadAsync(work.texture(limit)).then(texture => {
      if (!near(work.room, currentRoom, 1) || !candidate.userData.preview) { texture.dispose(); return; }
      candidate.userData.sharp = configure(texture, work); assign(candidate, texture);
      sharpFaces.push(candidate);
      // keep the last few prints you looked at sharp, so looking back (or zooming again) is instant
      while (sharpFaces.length > SHARP_KEEP) dropSharp(sharpFaces[0]);
    }).catch(() => { candidate.userData.sharpFailed = true; }).finally(() => { sharpRequest = undefined; invalidate(); });
  }
  function dropSharp(face) {
    const index = sharpFaces.indexOf(face);
    if (index >= 0) sharpFaces.splice(index, 1);
    if (!face.userData.sharp) return;
    if (face.userData.preview) assign(face, face.userData.preview);
    face.userData.sharp.dispose(); delete face.userData.sharp;
  }
  function render(now) {
    frame = 0;
    let dt = 0, wall = 0;
    if (last) { wall = Math.min(.25, (now - last) / 1000); dt = Math.min(.045, wall); }
    last = now;
    if (glide && steering()) { glide = undefined; marker.visible = false; }
    // glides keep wall-clock time so a slow frame doesn't turn them into slow motion
    if (glide) advanceGlide(wall);
    else if (walking()) step(dt);
    const zooming = easeZoom(wall);
    camera.rotation.set(pitch, yaw, 0, 'YXZ'); camera.updateMatrixWorld();
    const lit = Number(night);
    if (light !== lit) {
      if (reducedMotion.matches) light = lit;
      else light += Math.sign(lit - light) * Math.min(Math.abs(lit - light), dt * 2.5);
      tint();
    }
    if (marker.visible) marker.material.opacity = .55 + Math.sin(now / 140) * .3;
    // paper: whatever your feet go through gets scuffed along, then physics
    let paper = false;
    if (pileActive()) {
      const p = camera.position;
      const moved = Math.hypot(p.x - foot.x, p.z - foot.z);
      if (wall > 0 && moved < .6) pile.scuff(p.x, p.z, (p.x - foot.x) / wall, (p.z - foot.z) / wall);
      paper = pile.step(Math.min(wall, .05));
    }
    foot.x = camera.position.x; foot.z = camera.position.z;
    refine();
    renderer.render(scene, camera);
    drawMap(camera.position, yaw);
    // without per-frame video callbacks, a playing screen keeps the loop running
    const screensLive = !('requestVideoFrameCallback' in HTMLVideoElement.prototype) && videoPlaying();
    if (screensLive) {
      for (const channel of channels.values()) if (channel.started) sample(channel);
      updateScreens();
    }
    const scriptsLive = stepScripts(wall);
    if (glide || walking() || light !== lit || paper || zooming || screensLive || scriptsLive) invalidate();
    else last = 0;
  }
  function tint() {
    for (const entry of palette) entry.material.color.copy(entry.day).lerp(entry.night, light);
    scene.background.copy(dayAir).lerp(nightAir, light);
    scene.fog.color.copy(scene.background);
    pile.material.color.copy(paperDay).lerp(paperNight, light);
    marker.material.color.copy(markerDay).lerp(markerNight, light);
  }
  function zoomTo(target) {
    if (zoomTarget === target) return;
    if (target > 1) track('print-room-zoom', {});
    zoomTarget = target; invalidate();
  }
  let peeking = false;
  canvas.addEventListener('mousedown', event => {
    if (event.button !== 1) return;
    event.preventDefault();  // no autoscroll
    peeking = true;
    zoomTo(ZOOM);
  });
  // zoomed in, moving the mouse drifts the view across the painting, slowed by the zoom
  addEventListener('mousemove', event => {
    if (!peeking || !(event.buttons & 4)) return;
    yaw -= event.movementX * .0028 / zoom;
    pitch = T.MathUtils.clamp(pitch - event.movementY * .0028 / zoom, -1.05, 1.05);
    invalidate();
  });
  addEventListener('mouseup', event => { if (event.button === 1) { peeking = false; zoomTo(1); } });
  addEventListener('blur', () => { peeking = false; zoomTo(1); });
  canvas.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });
  // two fingers: pinch to zoom; the view follows the fingers and eases back out when they lift
  const touches = new Map();
  let pinch;
  function spread() {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }
  function liftTouch(event) {
    touches.delete(event.pointerId);
    if (pinch && touches.size < 2) { pinch = undefined; zoomTo(1); }
    // a third finger came and went: measure from the pair that's left, no jump
    else if (pinch) pinch = {spread: spread(), zoom};
  }
  canvas.addEventListener('pointerdown', event => {
    $('touch-hint').classList.add('gone');
    if (event.pointerType !== 'touch') return;
    touches.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (touches.size !== 2) return;
    // a second finger turns the gesture into a pinch: no look, no tap
    drag = undefined; canvas.classList.remove('dragging');
    pinch = {spread: spread(), zoom};
  }, true);
  canvas.addEventListener('pointermove', event => {
    if (!touches.has(event.pointerId)) return;
    touches.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (!pinch) return;
    zoom = T.MathUtils.clamp(pinch.zoom * spread() / pinch.spread, 1, ZOOM);
    zoomTarget = zoom; applyZoom(); invalidate();
    event.stopImmediatePropagation();
  }, true);
  canvas.addEventListener('pointerup', liftTouch, true);
  canvas.addEventListener('pointercancel', liftTouch, true);
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag || pinch) return;
    stopTour();
    glide = undefined; marker.visible = false;
    canvas.focus({preventScroll: true}); canvas.setPointerCapture(event.pointerId);
    drag = {x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, id: event.pointerId, moved: false};
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) { canvas.classList.toggle('over-print', Boolean(pick(event))); return; }
    if (drag.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
    if (!drag.moved) return;
    canvas.classList.add('dragging');
    // looking slows down as you zoom, so the view stays steady under the mouse
    yaw -= (event.clientX - drag.x) * .0035 / zoom;
    pitch = T.MathUtils.clamp(pitch - (event.clientY - drag.y) * .0035 / zoom, -1.05, 1.05);
    drag.x = event.clientX; drag.y = event.clientY; invalidate();
  });
  canvas.addEventListener('pointerup', event => {
    if (!drag || drag.id !== event.pointerId || drag.moved) return;
    const printFace = pick(event);
    if (printFace) { approach(printFace.userData.work, printFace); return; }
    // a sheet of paper within reach: punt it
    if (pileActive()) {
      const sheet = ray.intersectObject(pile.mesh, false)[0];
      if (sheet && sheet.distance < 4.5) {
        const dx = sheet.point.x - camera.position.x, dz = sheet.point.z - camera.position.z;
        const d = Math.hypot(dx, dz) || 1;
        pile.kick(sheet.point.x, sheet.point.z, dx / d, dz / d, .8);
        invalidate();
        return;
      }
    }
    walkTo(event);
  });
  // two-finger scroll / wheel walks forward and back
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    stopTour();
    glide = undefined; marker.visible = false;
    let amount = -event.deltaY * .012;
    if (event.deltaMode === 1) amount *= 16;
    amount = Math.max(-.7, Math.min(.7, amount));
    move(-Math.sin(yaw) * amount, -Math.cos(yaw) * amount);
    invalidate();
  }, {passive: false});
  canvas.addEventListener('lostpointercapture', () => { drag = undefined; canvas.classList.remove('dragging'); });
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); stopTour(); keys.clear(); resizeObserver.disconnect(); sceneView = fallback(); });
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(view);
  go(currentRoom); resize();
  tint();

  const opening = faces.filter(face => face.userData.work.room === currentRoom);
  // End: stop where you are, mid-stride if need be
  function clearTour() {
    if (!glide) return;
    glide = undefined; camera.position.y = EYE_HEIGHT; invalidate();
  }
  const api = {go, travel, standAt, kick, invalidate, tourTo, clearTour, nearRoom, position: () => camera.position, yaw: () => yaw};
  Promise.allSettled(opening.map(loadPreview)).then(results => {
    if (results.length && results.every(result => result.status === 'rejected')) { resizeObserver.disconnect(); renderer.dispose(); sceneView = fallback(); return; }
    $('status').hidden = true;
    autoTour.disabled = false;
    nearRoom(currentRoom);
  });
  return api;
}

// deep links: #0123 opens a work, #room-07 starts in a room
let startRoom = 0;
const linked = byId.get(location.hash.slice(1));
if (linked) startRoom = linked.room;
const roomLink = rooms.findIndex(room => location.hash === `#room-${room.number}`);
if (roomLink >= 0) startRoom = roomLink;
setRoom(startRoom); updateNight();
const engine = 'https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.module.min.js';
try {
  let T;
  try { T = await import(engine); }
  catch { T = await import('https://unpkg.com/three@0.186.0/build/three.module.js'); }
  sceneView = walkable(T);
  view.dataset.mode = '3d';
  sceneView.nearRoom(startRoom);
} catch (error) {
  console.warn('3D renderer unavailable', error);
  sceneView = fallback();
}
if (linked) showPrint(linked, $('checklist'));

window.addEventListener('hashchange', () => {
  const work = byId.get(location.hash.slice(1));
  if (work) { visit(work.room); showPrint(work, $('checklist')); return; }
  const index = rooms.findIndex(room => location.hash === `#room-${room.number}`);
  if (index >= 0) visit(index);
});

// ---------- the catalogue: what comes out when you print ----------
// With a work open, printing makes one sheet for it; otherwise every room, in hanging order.
// Built only when someone prints, so nobody else downloads it.
const catalogue = $('catalogue');
const preparing = $('preparing');
let catalogueFor = '';

function tag(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function yearsOf(list) {
  const years = list.map(work => work.year);
  const first = Math.min(...years), last = Math.max(...years);
  if (first === last) return String(first);
  return `${first}–${last}`;
}
function plateImage(work, limit) {
  const image = new Image();
  image.alt = work.title; image.loading = 'eager'; image.decoding = 'async';
  if (work.dither) image.classList.add('dither');
  // a size nobody has asked for yet is made on first request; with hundreds at once a few
  // fail. Try again, spaced out, and say when it's settled either way.
  image.ready = new Promise(resolve => {
    let tries = 0;
    image.addEventListener('load', resolve);
    image.addEventListener('error', () => {
      tries += 1;
      if (tries > 3) { resolve(); return; }
      setTimeout(() => { image.src = `${work.texture(limit)}#retry${tries}`; }, 1500 * tries);
    });
  });
  image.src = work.texture(limit);
  return image;
}
function plate(work) {
  const figure = tag('figure', 'plate');
  const frame = tag('div', 'plate-frame');
  // dithered work keeps its dots: more pixels, drawn hard
  let limit = 900;
  if (work.dither) limit = 1600;
  frame.append(plateImage(work, limit));
  const caption = tag('figcaption');
  caption.append(tag('b', '', work.title), tag('span', '', String(work.year)), tag('span', 'cat-mid', work.medium));
  figure.append(frame, caption);
  return figure;
}
// the floor plan, drawn as hairlines
function planDrawing() {
  const xs = rooms.flatMap(room => [room.rect[0], room.rect[2]]);
  const zs = rooms.flatMap(room => [room.rect[1], room.rect[3]]);
  const x0 = Math.min(...xs), z0 = Math.min(...zs);
  const width = Math.max(...xs) - x0, depth = Math.max(...zs) - z0;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `-1 -1 ${width + 2} ${depth + 2}`);
  svg.setAttribute('class', 'cat-plan');
  for (const room of rooms) {
    const [x1, z1, x2, z2] = room.rect;
    const rect = document.createElementNS(svg.namespaceURI, 'rect');
    rect.setAttribute('x', x1 - x0); rect.setAttribute('y', z1 - z0);
    rect.setAttribute('width', x2 - x1); rect.setAttribute('height', z2 - z1);
    const label = document.createElementNS(svg.namespaceURI, 'text');
    label.setAttribute('x', x1 - x0 + 1); label.setAttribute('y', z1 - z0 + 3);
    label.textContent = room.number;
    svg.append(rect, label);
  }
  return svg;
}
function wholeCatalogue() {
  const hung = rooms.filter(room => room.works.length);
  const cover = tag('section', 'cat-cover');
  const title = tag('div', 'cat-title');
  title.append(tag('h1', '', 'Print Room'), tag('p', 'cat-lede', `${works.length} works, ${yearsOf(works)}, hung by likeness in ${hung.length} rooms.`));
  const meta = tag('p', 'cat-meta');
  const printed = new Intl.DateTimeFormat('en-US', {day: 'numeric', month: 'long', year: 'numeric'}).format(new Date());
  meta.append(tag('span', '', '417am.party/print-room'), tag('span', '', printed));
  cover.append(tag('p', 'cat-mark', '417am'), title, planDrawing(), meta);
  catalogue.append(cover);

  for (const room of hung) {
    const pieces = room.works.map(id => byId.get(id));
    const section = tag('section', 'cat-room');
    const head = tag('header', 'cat-room-head');
    head.append(tag('span', 'cat-num', room.number), tag('span', '', `${plural(pieces.length, 'work')}, ${yearsOf(pieces)}`));
    const plates = tag('div', 'cat-plates');
    for (const work of pieces) plates.append(plate(work));
    section.append(head, plates);
    catalogue.append(section);
  }

  const index = tag('section', 'cat-index');
  index.append(tag('h2', '', 'Checklist'));
  const list = tag('div', 'cat-list');
  for (const room of hung) {
    const block = tag('div', 'cat-list-room');
    block.append(tag('h3', '', room.number));
    for (const id of room.works) {
      const work = byId.get(id);
      const row = tag('p');
      row.append(tag('b', '', work.title), tag('span', '', String(work.year)), tag('span', 'cat-mid', work.medium));
      block.append(row);
    }
    list.append(block);
  }
  const live = rooms.filter(isScriptRoom).map(room => room.number);
  const video = rooms.filter(isVideoRoom).map(room => room.number);
  const colophon = tag('p', 'cat-colophon', 'The order is the hang: each work sits beside the ones it most resembles.');
  if (live.length) colophon.textContent += ` Rooms ${roomRange(live)} run the bot's original scripts on fresh seeds.`;
  if (video.length) colophon.textContent += ` Rooms ${roomRange(video)} hold video.`;
  if (live.length || video.length) colophon.textContent += ' None of these are in print.';
  index.append(list, colophon);
  catalogue.append(index);
}
function singleSheet(work) {
  const room = rooms[work.room];
  const sheet = tag('section', 'cat-single');
  const frame = tag('div', 'plate-frame');
  let limit = 2400;
  if (work.dither) limit = 3000;
  frame.append(plateImage(work, limit));
  const caption = tag('div', 'cat-single-caption');
  const left = tag('div');
  left.append(tag('h1', '', `${work.title}, ${work.year}`), tag('p', '', work.medium),
    tag('p', 'cat-mid', `${work.dimensions.map(v => v.toLocaleString('en-US')).join(' × ')} px`));
  const right = tag('div', 'cat-where');
  right.append(tag('p', '', `Room ${room.number}`), tag('p', 'cat-mid', work.url.replace(/^https?:\/\//, '')));
  caption.append(left, right);
  const near = tag('div', 'cat-near');
  for (const id of work.near ?? []) {
    const other = byId.get(id);
    if (!other) continue;
    const figure = tag('figure');
    const box = tag('div', 'cat-near-frame');
    box.append(plateImage(other, 400));
    figure.append(box, tag('figcaption', '', other.title));
    near.append(figure);
  }
  const alike = tag('div', 'cat-alike');
  alike.append(tag('h2', '', 'Most alike'), near);
  const meta = tag('p', 'cat-meta');
  meta.append(tag('span', '', '417am · Print Room'), tag('span', '', '417am.party/print-room'));
  sheet.append(frame, caption, alike, meta);
  catalogue.append(sheet);
}
// the work on screen, if any: the inspect dialog's
function openWork() {
  if (!printDialog.open) return null;
  return byId.get(location.hash.slice(1)) ?? null;
}
function setCatalogue() {
  const work = openWork();
  let key = 'all';
  if (work) key = work.id;
  if (catalogueFor !== key) {
    catalogueFor = key;
    catalogue.replaceChildren();
    if (work) singleSheet(work);
    else wholeCatalogue();
  }
  return [...catalogue.querySelectorAll('img')];
}
// ⌘P / Ctrl+P: set the catalogue, wait for its pictures, then print
let settingCatalogue = false;
function printCatalogue() {
  if (settingCatalogue) return;  // a second ⌘P while the pictures load: one print is enough
  settingCatalogue = true;
  const images = setCatalogue();
  let done = 0;
  const say = () => { preparing.textContent = `Setting the catalogue · ${done}/${images.length}`; };
  preparing.hidden = false; say();
  const ready = images.map(image => image.ready.then(() => { done += 1; say(); }));
  const patience = new Promise(resolve => setTimeout(resolve, 45000));
  Promise.race([Promise.all(ready), patience]).then(() => {
    preparing.hidden = true;
    settingCatalogue = false;
    print();
  });
}
addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'p') return;
  event.preventDefault(); event.stopPropagation();
  printCatalogue();
}, true);
// the browser's own Print menu: set it now; pictures fill in as they arrive
addEventListener('beforeprint', () => {
  setCatalogue();
  let kind = 'catalogue';
  if (catalogueFor !== 'all') kind = 'sheet';
  try { window.umami?.track('print-room-print', {kind, work: catalogueFor}); } catch { /* optional */ }
});
