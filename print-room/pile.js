// A floor covered in letter-size prints (8.5 x 11 in) that you can kick around.
// One InstancedMesh, one texture atlas of thumbnails, a small hand-rolled paper physics:
// heavy air drag when falling, flutter while airborne, friction on the floor,
// and a little chain reaction when a sliding sheet runs into a resting one.

const SHEET_W = .216, SHEET_H = .279;
const COLS = 16, ROWS = 8;            // atlas: 128 different prints
const CELL_W = 128, CELL_H = 166;     // px per atlas cell, 8.5:11
const GRAVITY = 9.8;
const CELL = .5;                      // spatial grid for kicks and knock-ons

export function makePile(T, {count, rect, inside, works, thumb, onchange, seed = 4170}) {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };

  // ---------- atlas: every sheet is one of 128 prints with a white paper margin ----------
  const atlas = document.createElement('canvas');
  atlas.width = COLS * CELL_W; atlas.height = ROWS * CELL_H;
  const ctx = atlas.getContext('2d');
  ctx.fillStyle = '#f4f1ea'; ctx.fillRect(0, 0, atlas.width, atlas.height);
  const map = new T.CanvasTexture(atlas);
  map.colorSpace = T.SRGBColorSpace;
  map.anisotropy = 4;
  const picks = [];
  for (let k = 0; k < COLS * ROWS; k++) picks.push(works[Math.floor(k * works.length / (COLS * ROWS))]);
  let dirty = false;
  picks.forEach((work, k) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => {
      const cx = (k % COLS) * CELL_W, cy = Math.floor(k / COLS) * CELL_H;
      const margin = 11;
      const fit = Math.min((CELL_W - margin * 2) / image.naturalWidth, (CELL_H - margin * 2.6) / image.naturalHeight);
      const w = image.naturalWidth * fit, h = image.naturalHeight * fit;
      ctx.drawImage(image, cx + (CELL_W - w) / 2, cy + margin * 1.2, w, h);
      dirty = true;
      onchange?.();
    };
    image.src = thumb(work);
  });

  // ---------- mesh ----------
  const geometry = new T.PlaneGeometry(SHEET_W, SHEET_H);
  const cells = new Float32Array(count * 2);
  const material = new T.MeshBasicMaterial({map, side: T.DoubleSide, toneMapped: false});
  material.onBeforeCompile = shader => {
    shader.uniforms.cellScale = {value: new T.Vector2(1 / COLS, 1 / ROWS)};
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aCell;\nuniform vec2 cellScale;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = vMapUv * cellScale + aCell;');
    // the back of a sheet is blank paper
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', '#include <map_fragment>\nif (!gl_FrontFacing) diffuseColor.rgb = diffuse * vec3(.95, .94, .91);');
  };
  const mesh = new T.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);

  // ---------- state ----------
  const px = new Float32Array(count), py = new Float32Array(count), pz = new Float32Array(count);
  const vx = new Float32Array(count), vy = new Float32Array(count), vz = new Float32Array(count);
  const yaw = new Float32Array(count), spin = new Float32Array(count);
  const tilt = new Float32Array(count), tiltSpeed = new Float32Array(count);
  const rest = new Float32Array(count), phase = new Float32Array(count);
  const awake = new Uint8Array(count);
  let awakeCount = 0;

  const [x1, z1, x2, z2] = rect;
  // a few drifts plus a general scatter, like someone dropped boxes of proofs
  const drifts = [];
  for (let d = 0; d < 13; d++) drifts.push([x1 + 1 + rand() * (x2 - x1 - 2), z1 + 1 + rand() * (z2 - z1 - 2), .5 + rand() * 1.6]);
  for (let i = 0; i < count; i++) {
    let x = 0, z = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (rand() < .55) {
        const [dx, dz, r] = drifts[Math.floor(rand() * drifts.length)];
        const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * r;
        x = dx + Math.cos(a) * d; z = dz + Math.sin(a) * d;
      } else {
        x = x1 + rand() * (x2 - x1); z = z1 + rand() * (z2 - z1);
      }
      if (inside(x, z)) break;
    }
    px[i] = x; pz[i] = z;
    // every sheet rests at its own height so overlapping sheets never z-fight
    rest[i] = .003 + i * .00005;
    py[i] = rest[i];
    yaw[i] = rand() * Math.PI * 2;
    phase[i] = rand() * Math.PI * 2;
    if (rand() < .08) tilt[i] = Math.PI;       // a few landed face down
    const cell = Math.floor(rand() * COLS * ROWS);
    cells[i * 2] = (cell % COLS) / COLS;
    cells[i * 2 + 1] = 1 - (Math.floor(cell / COLS) + 1) / ROWS;
  }
  geometry.setAttribute('aCell', new T.InstancedBufferAttribute(cells, 2));

  const matrix = new T.Matrix4(), position = new T.Vector3(), quaternion = new T.Quaternion();
  const euler = new T.Euler(0, 0, 0, 'YXZ'), unit = new T.Vector3(1, 1, 1);
  function write(i) {
    euler.set(-Math.PI / 2 + tilt[i], yaw[i], Math.sin(phase[i]) * .35 * Math.min(1, (py[i] - rest[i]) * 4));
    quaternion.setFromEuler(euler);
    position.set(px[i], py[i], pz[i]);
    matrix.compose(position, quaternion, unit);
    mesh.setMatrixAt(i, matrix);
  }
  for (let i = 0; i < count; i++) write(i);

  // ---------- spatial grid ----------
  const grid = new Map();
  const key = (x, z) => Math.floor(x / CELL) * 4096 + Math.floor(z / CELL);
  function rebuild() {
    grid.clear();
    for (let i = 0; i < count; i++) {
      const k = key(px[i], pz[i]);
      let list = grid.get(k);
      if (!list) { list = []; grid.set(k, list); }
      list.push(i);
    }
  }
  rebuild();
  function near(x, z, radius, visit) {
    const reach = Math.ceil(radius / CELL);
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let a = -reach; a <= reach; a++) {
      for (let b = -reach; b <= reach; b++) {
        const list = grid.get((cx + a) * 4096 + cz + b);
        if (!list) continue;
        for (const i of list) {
          const d = Math.hypot(px[i] - x, pz[i] - z);
          if (d < radius) visit(i, d);
        }
      }
    }
  }

  function wake(i) {
    if (!awake[i]) { awake[i] = 1; awakeCount++; }
  }
  function launch(i, ix, iy, iz) {
    vx[i] += ix; vy[i] = Math.max(vy[i], iy); vz[i] += iz;
    spin[i] += (rand() - .5) * 14;
    tiltSpeed[i] += (rand() - .5) * 18 * Math.min(1, iy / 2.5);
    wake(i);
  }

  // feet: anything you walk through gets scuffed along
  function scuff(x, z, mx, mz) {
    const speed = Math.hypot(mx, mz);
    if (speed < .35) return;
    near(x, z, .42, (i, d) => {
      if (py[i] > rest[i] + .25) return;
      // one shove per contact, not one per frame (same feel at 60 Hz and 144 Hz)
      if (Math.hypot(vx[i], vz[i]) > speed * .6) return;
      const away = Math.atan2(pz[i] - z, px[i] - x);
      const push = .6 + rand() * .7;
      launch(i, mx * (.9 + rand() * .7) + Math.cos(away) * push, speed * (.25 + rand() * .45) * (1 - d), mz * (.9 + rand() * .7) + Math.sin(away) * push);
    });
  }
  // a proper kick: everything in front of you goes up
  function kick(x, z, dirX, dirZ, strength = 1) {
    let hit = 0;
    near(x, z, 1.15 * strength, (i, d) => {
      const away = Math.atan2(pz[i] - z, px[i] - x);
      const power = (1 - d / (1.2 * strength)) * strength;
      launch(i,
        (dirX * (3 + rand() * 3) + Math.cos(away) * (1 + rand() * 1.5)) * power,
        (2.4 + rand() * 3.4) * power,
        (dirZ * (3 + rand() * 3) + Math.sin(away) * (1 + rand() * 1.5)) * power);
      hit++;
    });
    return hit;
  }

  let clock = 0;
  function step(dt) {
    if (dirty) { map.needsUpdate = true; dirty = false; }
    if (!awakeCount) return false;
    // the first frame after an idle spell has no elapsed time; keep the loop alive
    if (dt <= 0) return true;
    clock += dt;
    const knocks = [];
    for (let i = 0; i < count; i++) {
      if (!awake[i]) continue;
      // a tilted sheet stands on its lowest edge, not its centre
      const ground = rest[i] + Math.abs(Math.sin(tilt[i])) * SHEET_H / 2;
      const airborne = py[i] > ground + .002 || vy[i] > 0;
      if (airborne) {
        vy[i] -= GRAVITY * dt;
        // paper falls slowly: strong drag on the way down, flutter sideways
        if (vy[i] < 0) vy[i] *= Math.exp(-7 * dt);
        const drag = Math.exp(-1.4 * dt);
        vx[i] *= drag; vz[i] *= drag;
        phase[i] += dt * (5 + (i % 7));
        vx[i] += Math.cos(phase[i]) * dt * 1.4;
        vz[i] += Math.sin(phase[i] * 1.3) * dt * 1.4;
        tilt[i] += tiltSpeed[i] * dt;
        tiltSpeed[i] *= Math.exp(-1.8 * dt);
      } else {
        const friction = Math.exp(-5.5 * dt);
        vx[i] *= friction; vz[i] *= friction;
        tiltSpeed[i] = 0;
        // settle face up or face down
        const flat = Math.round(tilt[i] / Math.PI) * Math.PI;
        tilt[i] += (flat - tilt[i]) * Math.min(1, dt * 12);
      }
      spin[i] *= Math.exp(-(2.5 + Number(!airborne) * 4) * dt);
      yaw[i] += spin[i] * dt;
      const nx = px[i] + vx[i] * dt, nz = pz[i] + vz[i] * dt;
      if (inside(nx, pz[i])) px[i] = nx; else vx[i] *= -.35;
      if (inside(px[i], nz)) pz[i] = nz; else vz[i] *= -.35;
      py[i] += vy[i] * dt;
      if (py[i] > 4.6) { py[i] = 4.6; vy[i] = -Math.abs(vy[i]) * .3; }
      const floor = rest[i] + Math.abs(Math.sin(tilt[i])) * SHEET_H / 2;
      if (py[i] <= floor) { py[i] = floor; vy[i] = Math.max(0, vy[i]); }
      const speed = Math.hypot(vx[i], vz[i]);
      if (!airborne && speed > 1.3) knocks.push(i);
      write(i);
      const settled = py[i] <= rest[i] + .0005 && speed < .03 && Math.abs(spin[i]) < .05 && Math.abs(tilt[i] - Math.round(tilt[i] / Math.PI) * Math.PI) < .01;
      if (settled) { awake[i] = 0; awakeCount--; vx[i] = 0; vz[i] = 0; spin[i] = 0; }
    }
    // a sheet skating across the floor shoves the ones it runs into
    for (const i of knocks.slice(0, 60)) {
      near(px[i], pz[i], .2, j => {
        if (j === i || awake[j]) return;
        launch(j, vx[i] * .5, .2 + rand() * .4, vz[i] * .5);
        vx[i] *= .8; vz[i] *= .8;
      });
    }
    rebuild();
    mesh.instanceMatrix.needsUpdate = true;
    mesh.boundingSphere = null;
    return awakeCount > 0;
  }

  return {
    mesh,
    material,
    step,
    scuff,
    kick,
    moving: () => awakeCount > 0 || dirty,
    point: i => ({x: px[i], z: pz[i]}),
  };
}
