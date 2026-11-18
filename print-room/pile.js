// A floor covered in prints that you can kick around. Each sheet is cut to its work's
// proportions, edge to edge, long side 11 in.
// One InstancedMesh, one texture atlas of thumbnails, a small hand-rolled paper physics:
// heavy air drag when falling, flutter while airborne, friction on the floor,
// and a little chain reaction when a sliding sheet runs into a resting one.

const LONG = .279;                    // long edge of every sheet, 11 in
const COLS = 16, ROWS = 8;            // atlas: 128 different prints
const CELL_PX = 160;                  // square atlas cells; each print is stretched to fill its cell
const GUTTER = 8;                     // px around each cell filled with the print's own edge, so mipmaps never bleed a neighbour in
const SLOT = CELL_PX + GUTTER * 2;
const GRAVITY = 9.8;
const CELL = .5;                      // spatial grid for kicks and knock-ons

export function makePile(T, {count, rect, inside, works, thumb, onchange, seed = 4170}) {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };

  // ---------- atlas: every sheet is one of 128 prints, no margin ----------
  const atlas = document.createElement('canvas');
  atlas.width = COLS * SLOT; atlas.height = ROWS * SLOT;
  const ctx = atlas.getContext('2d');
  ctx.fillStyle = '#d8d8d8'; ctx.fillRect(0, 0, atlas.width, atlas.height);
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
      const sx = (k % COLS) * SLOT, sy = Math.floor(k / COLS) * SLOT;
      // the whole slot first (its gutter gets the print's outer edge), then the print itself inside
      ctx.drawImage(image, sx, sy, SLOT, SLOT);
      ctx.drawImage(image, sx + GUTTER, sy + GUTTER, CELL_PX, CELL_PX);
      dirty = true;
      onchange?.();
    };
    image.src = thumb(work);
  });

  // ---------- mesh ----------
  // sheet size per atlas cell, from the work's own pixel dimensions
  const sizes = picks.map(work => {
    const aspect = (work.w || 1) / (work.h || 1);
    if (aspect >= 1) return [LONG, LONG / aspect];
    return [LONG * aspect, LONG];
  });
  const geometry = new T.PlaneGeometry(1, 1);
  const cells = new Float32Array(count * 2);
  const material = new T.MeshBasicMaterial({map, side: T.DoubleSide, toneMapped: false});
  material.onBeforeCompile = shader => {
    const pad = new T.Vector2(GUTTER / atlas.width, GUTTER / atlas.height);
    shader.uniforms.cellScale = {value: new T.Vector2(1 / COLS - pad.x * 2, 1 / ROWS - pad.y * 2)};
    shader.uniforms.cellPad = {value: pad};
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aCell;\nuniform vec2 cellScale;\nuniform vec2 cellPad;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = vMapUv * cellScale + aCell + cellPad;');
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
  const sw = new Float32Array(count), sh = new Float32Array(count);
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
    [sw[i], sh[i]] = sizes[cell];
    cells[i * 2] = (cell % COLS) / COLS;
    cells[i * 2 + 1] = 1 - (Math.floor(cell / COLS) + 1) / ROWS;
  }
  geometry.setAttribute('aCell', new T.InstancedBufferAttribute(cells, 2));

  const matrix = new T.Matrix4(), position = new T.Vector3(), quaternion = new T.Quaternion();
  const euler = new T.Euler(0, 0, 0, 'YXZ'), scale = new T.Vector3(1, 1, 1);
  function write(i) {
    euler.set(-Math.PI / 2 + tilt[i], yaw[i], Math.sin(phase[i]) * .35 * Math.min(1, (py[i] - rest[i]) * 4));
    quaternion.setFromEuler(euler);
    position.set(px[i], py[i], pz[i]);
    scale.set(sw[i], sh[i], 1);
    matrix.compose(position, quaternion, scale);
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
      const ground = rest[i] + Math.abs(Math.sin(tilt[i])) * sh[i] / 2;
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
      const floor = rest[i] + Math.abs(Math.sin(tilt[i])) * sh[i] / 2;
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
