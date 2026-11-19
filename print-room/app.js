// The Print Room: a walkable gallery of every 417am work, generated from gallery.json
// (pipeline/layout.py). Rooms, walls, doors, hang positions and the tour all come from
// the data; nothing about the plan is hard-coded here.

import {makePile} from './pile.js';

const DATA = await fetch('gallery.json').then(response => response.json());
// the entrance room's floor is covered in letter-size prints you can kick around
const PILE_ROOM = 0;
const PILE_COUNT = 1024;

const DOOR = 2.3;
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

function onBench(x, z) {
  return DATA.benches.some(([bx, bz, width, alongX]) => {
    if (alongX) return Math.abs(x - bx) < width / 2 + .25 && Math.abs(z - bz) < .565;
    return Math.abs(z - bz) < width / 2 + .25 && Math.abs(x - bx) < .565;
  });
}

function canStand(x, z) {
  if (onBench(x, z)) return false;
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
  function pattern(width, height, paint) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    paint(canvas.getContext('2d'), width, height);
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
  const ceiling = immaterial(0xe2e2e0, 0x161616);
  const edge = immaterial(0xc8c8c6, 0x202020);
  const recess = immaterial(0x7a7a78, 0x0c0c0c);
  const timber = immaterial(0x1c1c1c, 0x111111);
  const dark = immaterial(0x111111, 0x080808);
  const light = immaterial(0xffffff, 0x2c2c2c);
  const softLight = immaterial(0xf2f2f0, 0x1c1c1c);
  const walls = new Map();
  function wall(x1, z1, x2, z2) {
    const width = Math.hypot(x2 - x1, z2 - z1);
    const yaw = Math.atan2(z1 - z2, x2 - x1);
    const x = (x1 + x2) / 2, z = (z1 + z2) / 2;
    const key = width.toFixed(0);
    if (!walls.has(key)) walls.set(key, immaterial(0xffffff, 0x2e2e2e, {map: plaster(width), side: T.DoubleSide}));
    const group = new T.Group(); group.position.set(x, 0, z); group.rotation.y = yaw; scene.add(group);
    box(width, H, .12, walls.get(key), 0, H / 2, 0, group);
    box(width, .096, .15, recess, 0, .048, 0, group);
    box(width, .034, .17, edge, 0, .112, 0, group);
    box(width, .08, .18, edge, 0, H - .04, 0, group);
  }
  for (const spec of DATA.walls) wall(...spec);

  for (const room of rooms) {
    const [x1, z1, x2, z2] = room.rect;
    const [x, z] = centre(room);
    const map = concreteCanvas.clone();
    map.wrapS = map.wrapT = T.RepeatWrapping;
    map.repeat.set((x2 - x1) / 6, (z2 - z1) / 6);
    map.needsUpdate = true;
    const floor = immaterial(0xffffff, 0x262626, {map});
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
  });
  const shadowMat = new T.MeshBasicMaterial({map: shadow, transparent: true, depthWrite: false, opacity: .5});
  const printShade = new T.MeshBasicMaterial({map: shadow, transparent: true, depthWrite: false, opacity: .48});
  // a pool of track light on the wall around each print; brighter after hours
  const washMap = pattern(256, 256, (c, w, h) => {
    const glow = c.createRadialGradient(w / 2, h * .34, 2, w / 2, h * .46, w / 2);
    glow.addColorStop(0, '#ffffff'); glow.addColorStop(.42, '#ffffff8c'); glow.addColorStop(.78, '#ffffff1f'); glow.addColorStop(1, '#ffffff00');
    c.fillStyle = glow; c.fillRect(0, 0, w, h);
  });
  const wash = immaterial(0x1a1a1a, 0x707070, {map: washMap, transparent: true, depthWrite: false, blending: T.AdditiveBlending});

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

  function lettering(lines, large, width, height) {
    return immaterial(0xffffff, 0x9a9a9a, {map: pattern(width, height, (c) => {
      c.textBaseline = 'middle';
      const face = '"Helvetica Neue", Helvetica, Arial, sans-serif';
      if (large) {
        c.fillStyle = '#111111'; c.font = `92px ${face}`; c.fillText(lines[0], 14, height * .5);
      } else {
        c.fillStyle = '#111111'; c.font = `30px ${face}`; c.fillText(lines[0], 10, 42);
        c.fillStyle = '#8a8a8a'; c.font = `24px ${face}`; c.fillText(lines[1], 10, 83);
      }
    }), transparent: true, depthWrite: false});
  }

  for (const room of rooms) {
    const first = byId.get(room.works[0]);
    const group = new T.Group();
    group.position.set(first.x, 0, first.z); group.rotation.y = first.yaw;
    roomGroups[room.index].add(group);
    surface(2.6, .42, lettering([room.number], true, 1024, 166), -first.width / 2 + 1.3, 3.45, .005, 0, group);
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
  return {faces, palette, roomGroups};
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
  return viewFrom(ex, ez, [cx + (cx - ex), 2.1, cz + (cz - ez)]);
}

const route = [];
for (const room of rooms) {
  if (room.index > 0) {
    const [dx, dz] = room.door;
    const [cx, cz] = centre(room);
    route.push({pose: viewFrom(dx, dz, [cx, 1.75, cz])});
  }
  route.push({pose: entryView(room), stop: {room: room.index, title: room.number, subtitle: plural(room.works.length, 'work')}, hold: 7});
  route.push(lookAtPrint(byId.get(room.medoid)));
}
const entrance = entryView(rooms[0]);
const stopCount = route.filter(waypoint => waypoint.stop).length;

function makeTour(cuts) {
  const timeline = [];
  let duration = 0;
  let from = entrance;
  let number = 0;
  for (const {pose, stop, hold} of route) {
    if (!cuts) {
      const distance = Math.hypot(pose.x - from.x, pose.z - from.z);
      const travel = 1.1 + distance * .4;
      timeline.push({start: duration, end: duration + travel, from, to: pose});
      duration += travel;
    }
    if (stop) {
      const label = {...stop, number: ++number, count: stopCount};
      timeline.push({start: duration, end: duration + hold, to: pose, stop: label});
      duration += hold;
    }
    from = pose;
  }
  return {timeline, duration};
}

function sampleTour(tour, elapsed) {
  const moment = tour.timeline.find(segment => elapsed < segment.end) ?? tour.timeline.at(-1);
  if (!moment.from) return {pose: moment.to, stop: moment.stop};
  const {from, to} = moment;
  const t = Math.max(0, (elapsed - moment.start) / (moment.end - moment.start));
  const eased = t * t * (3 - 2 * t);
  const angle = to.yaw - from.yaw;
  const yawDelta = Math.atan2(Math.sin(angle), Math.cos(angle));
  return {pose: {
    x: from.x + (to.x - from.x) * eased,
    z: from.z + (to.z - from.z) * eased,
    yaw: from.yaw + yawDelta * eased,
    pitch: from.pitch + (to.pitch - from.pitch) * eased,
  }};
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
let playback;

const years = works.map(work => work.year);
$('intro-text').textContent = `${works.length} works, ${Math.min(...years)}–${Math.max(...years)}. ${rooms.length} rooms, hung by likeness.`;

for (const room of rooms) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'room'; button.dataset.room = String(room.index);
  const number = document.createElement('span'); number.className = 'room-number'; number.textContent = room.number;
  button.setAttribute('aria-label', `Room ${room.number}, ${plural(room.works.length, 'work')}`);
  const tally = document.createElement('span'); tally.className = 'room-seen'; tally.title = 'Seen';
  button.append(number, tally);
  $('rooms').append(button);
}
const roomButtons = [...document.querySelectorAll('[data-room]')];

function updateNight() {
  night = nightOverride ?? clock.format(new Date()) === '04:17';
  document.body.classList.toggle('night-mode', night);
  $('night').setAttribute('aria-pressed', String(night));
  let hint = 'Preview the late-night gallery';
  if (night) hint = 'Return to the daytime gallery';
  $('night').title = hint;
  sceneView?.invalidate();
  drawMap();
}
$('night').addEventListener('click', () => { nightOverride = !night; updateNight(); });
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
$('tour').addEventListener('click', () => visit((currentRoom + 1) % rooms.length));
$('reset').addEventListener('click', () => visit(currentRoom));

function setTourControls(state) {
  const labels = {idle: 'Tour', playing: 'Pause', paused: 'Resume', finished: 'Again'};
  const icons = {idle: '▶', playing: 'Ⅱ', paused: '▶', finished: '↻'};
  $('auto-tour-label').textContent = labels[state];
  $('auto-tour-icon').textContent = icons[state];
  endTour.hidden = state === 'idle' || state === 'finished';
}

function displayTourFrame() {
  const {pose, stop} = sampleTour(playback, playback.elapsed);
  if (pose !== playback.pose) sceneView.setTourPose?.(pose);
  playback.pose = pose;
  tourProgress.firstElementChild.style.transform = `scaleX(${Math.min(playback.elapsed / playback.duration, 1)})`;
  if (stop === playback.stop) return;
  playback.stop = stop;
  tourCaption.hidden = !stop;
  if (!stop) return;
  sceneView.showTourStop?.(stop);
  $('tour-stop').textContent = `${stop.number} / ${stop.count}`;
  $('tour-title').textContent = stop.title;
  $('tour-medium').textContent = stop.subtitle;
}

function queueTourFrame() {
  if (playback?.playing && !playback.frame && !document.hidden) playback.frame = requestAnimationFrame(advanceTour);
}

function advanceTour(now) {
  playback.frame = 0;
  if (!playback.playing || document.hidden) return;
  if (playback.last !== undefined) playback.elapsed += Math.min(100, now - playback.last) / 1000;
  playback.last = now;
  displayTourFrame();
  if (playback.elapsed >= playback.duration) stopTour('finished');
  else queueTourFrame();
}

function pauseTour() {
  playback.playing = false;
  playback.last = undefined;
  cancelAnimationFrame(playback.frame);
  playback.frame = 0;
  setTourControls('paused');
}

function stopTour(state = 'idle') {
  if (!playback) return;
  cancelAnimationFrame(playback.frame);
  playback = undefined;
  tourCaption.hidden = true;
  tourProgress.hidden = true;
  sceneView?.clearTour?.();
  setTourControls(state);
  if (document.activeElement === endTour) autoTour.focus();
}

autoTour.addEventListener('click', () => {
  if (playback?.playing) { pauseTour(); return; }
  if (!playback) {
    keys.clear();
    playback = {...makeTour(reducedMotion.matches || !sceneView.setTourPose), elapsed: 0, frame: 0};
    tourProgress.hidden = false;
    displayTourFrame();
  }
  playback.playing = true;
  setTourControls('playing');
  queueTourFrame();
});
endTour.addEventListener('click', () => stopTour());
document.addEventListener('visibilitychange', () => {
  if (!playback) return;
  playback.last = undefined;
  if (document.hidden) {
    cancelAnimationFrame(playback.frame);
    playback.frame = 0;
  } else queueTourFrame();
});

function showPrint(work, restoreFocus) {
  stopTour();
  if (indexDialog.open) indexDialog.close();
  if (!printDialog.open) lastFocus = restoreFocus ?? document.activeElement;
  keys.clear();
  const room = rooms[work.room];
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
for (const room of rooms) {
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
  if (event.code === 'Escape' && playback) { event.preventDefault(); stopTour(); return; }
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
  const mount = $('mount');
  view.dataset.mode = 'images';
  mount.innerHTML = ''; mount.classList.add('flat-mount');
  const grid = document.createElement('div'); grid.className = 'flat-room';
  mount.append(grid);
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
    showTourStop(stop) { if (stop.room !== currentRoom) setRoom(stop.room); go(stop.room, stop.work, true); },
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
  const dayAir = new T.Color(0xdcdcdc), nightAir = new T.Color(0x050505);
  scene.fog = new T.Fog(scene.background, 24, 64);
  const camera = new T.PerspectiveCamera(58, 1, .07, 90); camera.rotation.order = 'YXZ';
  const {faces, palette, roomGroups} = buildSpace(T, scene, works);
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
  const paperDay = new T.Color(0xffffff), paperNight = new T.Color(0x6e6e6e);
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
  let tourFraming = false;
  let sharpFace;
  let sharpRequest;
  const forward = new T.Vector3();
  const printPosition = new T.Vector3();
  const offset = new T.Vector3();
  const coarse = matchMedia('(pointer: coarse)').matches;

  function configure(texture, work, close = false) {
    texture.colorSpace = T.SRGBColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (work.dither && close) texture.magFilter = T.NearestFilter;
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
    if (sharpFace === face) sharpFace = undefined;
    data.sharp?.dispose(); delete data.sharp;
    data.preview?.dispose(); delete data.preview;
    blank(face);
  }
  function nearRoom(index) {
    roomGroups.forEach((group, i) => { group.visible = near(i, index, 2); });
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
  function frameForTour(enabled) {
    if (tourFraming === enabled) return;
    tourFraming = enabled;
    resize();
  }
  function updateCurrentRoom() {
    const room = roomAt(camera.position.x, camera.position.z, currentRoom);
    if (room !== currentRoom) setRoom(room);
  }
  function setTourPose(pose) {
    frameForTour(true);
    glide = undefined; marker.visible = false;
    velocity.x = 0; velocity.z = 0;
    camera.position.set(pose.x, EYE_HEIGHT, pose.z);
    yaw = pose.yaw; pitch = pose.pitch;
    updateCurrentRoom();
    invalidate();
  }
  function resize() {
    const w = view.clientWidth, h = view.clientHeight;
    if (!w || !h) return;
    const ratio = w / h; camera.aspect = ratio;
    camera.fov = 58;
    if (ratio < 1) camera.fov = Math.min(91, 58 + (1 - ratio) * 54);
    if (tourFraming) {
      const minimum = 2 * Math.atan(Math.tan(34 * Math.PI / 180) / ratio) * 180 / Math.PI;
      camera.fov = Math.min(105, Math.max(camera.fov, minimum));
    }
    baseFov = camera.fov; applyZoom(); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8)); renderer.setSize(w, h, false); invalidate();
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
  function glideAlong(poses, arrive) {
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
    glide = {points, lengths, total, elapsed: 0, duration: Math.min(5, Math.max(.45, .35 + total / 7)), arrive};
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
    let candidate, closest = Infinity;
    for (const face of faces) {
      const work = face.userData.work;
      if (work.room !== currentRoom || !face.userData.preview) continue;
      face.getWorldPosition(printPosition);
      offset.subVectors(printPosition, camera.position);
      const d = offset.length();
      // zoomed in, a far print fills the view as a near one would: same test, scaled
      if (d / zoom > 4.6 || d >= closest || offset.dot(forward) / d < Math.cos(Math.atan(Math.tan(Math.acos(.65)) / zoom))) continue;
      candidate = face; closest = d;
    }
    // stopping in front of a print for a moment counts as seeing it; walking past doesn't
    const still = !glide && Math.hypot(velocity.x, velocity.z) < .6;
    if (!candidate || !still) dwell = undefined;
    else if (dwell?.face !== candidate) {
      dwell = {face: candidate, since: performance.now()};
      setTimeout(invalidate, 750);
    } else if (performance.now() - dwell.since >= 700) markSeen(candidate.userData.work);
    if (candidate && (Math.max(candidate.userData.work.w, candidate.userData.work.hw || 0) <= PREVIEW || candidate.userData.sharpFailed)) candidate = undefined;
    if (sharpFace && sharpFace !== candidate) {
      if (sharpFace.userData.preview) assign(sharpFace, sharpFace.userData.preview);
      sharpFace.userData.sharp?.dispose(); delete sharpFace.userData.sharp; sharpFace = undefined;
    }
    if (!candidate || candidate === sharpFace || sharpRequest) return;
    sharpRequest = candidate;
    const work = candidate.userData.work;
    let limit = 4096;
    if (coarse) limit = 2048;
    limit = Math.min(renderer.capabilities.maxTextureSize, limit);
    loader.loadAsync(work.texture(limit)).then(texture => {
      if (work.room !== currentRoom || !candidate.userData.preview) { texture.dispose(); return; }
      candidate.userData.sharp = configure(texture, work, true); sharpFace = candidate; assign(candidate, texture);
    }).catch(() => { candidate.userData.sharpFailed = true; }).finally(() => { sharpRequest = undefined; });
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
    if (glide || walking() || light !== lit || paper || zooming) invalidate();
    else last = 0;
  }
  function tint() {
    for (const entry of palette) entry.material.color.copy(entry.day).lerp(entry.night, light);
    scene.background.copy(dayAir).lerp(nightAir, light);
    scene.fog.color.copy(scene.background);
    pile.material.color.copy(paperDay).lerp(paperNight, light);
  }
  function zoomTo(target) {
    if (zoomTarget === target) return;
    zoomTarget = target; invalidate();
  }
  canvas.addEventListener('mousedown', event => {
    if (event.button !== 1) return;
    event.preventDefault();  // no autoscroll
    zoomTo(ZOOM);
  });
  addEventListener('mouseup', event => { if (event.button === 1) zoomTo(1); });
  addEventListener('blur', () => zoomTo(1));
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
  const api = {go, travel, standAt, kick, invalidate, setTourPose, nearRoom, clearTour: () => frameForTour(false), position: () => camera.position, yaw: () => yaw};
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
