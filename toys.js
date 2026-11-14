// Things that drop onto the backgrounds when the page is clicked:
//   silver balls onto the dot field, rubber ducks onto the sea.
// Rigid-body physics runs on the CPU in fixed steps; rendering is raw WebGL
// like the rest of the scene. The physics has no WebGL dependency so it can
// also be exercised from Node (see the module.exports at the bottom).
(() => {
  const G = 9.8;
  const STEP = 1 / 120;
  // Shared with the scene shaders: clip z = w - 2 * DEPTH_NEAR, i.e. a 1/w depth.
  const DEPTH_NEAR = 0.5;

  // ---------------------------------------------------------------- math

  // Quaternions are [w, x, y, z]; vectors are [x, y, z].
  function qmul(a, b) {
    return [
      a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ];
  }
  function qnormalize(q) {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    for (let i = 0; i < 4; i++) q[i] /= l;
    return q;
  }
  function qaxis(axis, angle) {
    const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    const s = Math.sin(angle / 2) / l;
    return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
  }
  function qrotate(q, v) {
    // v + 2 q.xyz × (q.xyz × v + q.w v)
    const qx = q[1], qy = q[2], qz = q[3], qw = q[0];
    const tx = 2 * (qy * v[2] - qz * v[1]);
    const ty = 2 * (qz * v[0] - qx * v[2]);
    const tz = 2 * (qx * v[1] - qy * v[0]);
    return [
      v[0] + qw * tx + (qy * tz - qz * ty),
      v[1] + qw * ty + (qz * tx - qx * tz),
      v[2] + qw * tz + (qx * ty - qy * tx),
    ];
  }
  // Column-major 3x3 rotation matrix for WebGL.
  function qmatrix(q, out) {
    const w = q[0], x = q[1], y = q[2], z = q[3];
    out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y + w * z);     out[2] = 2 * (x * z - w * y);
    out[3] = 2 * (x * y - w * z);     out[4] = 1 - 2 * (x * x + z * z); out[5] = 2 * (y * z + w * x);
    out[6] = 2 * (x * z + w * y);     out[7] = 2 * (y * z - w * x);     out[8] = 1 - 2 * (x * x + y * y);
    return out;
  }
  function qintegrate(q, omega, dt) {
    const d = qmul([0, omega[0] * dt / 2, omega[1] * dt / 2, omega[2] * dt / 2], q);
    for (let i = 0; i < 4; i++) q[i] += d[i];
    return qnormalize(q);
  }
  const rand = (a, b) => a + Math.random() * (b - a);

  // Equal spheres bumping into each other: positional separation plus an impulse.
  function collideSpheres(bodies, radius, restitution) {
    const minDist = radius * 2;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1], dz = b.p[2] - a.p[2];
        const dist = Math.hypot(dx, dy, dz);
        if (dist >= minDist || dist < 1e-6) continue;
        const nx = dx / dist, ny = dy / dist, nz = dz / dist;
        const push = (minDist - dist) / 2;
        a.p[0] -= nx * push; a.p[1] -= ny * push; a.p[2] -= nz * push;
        b.p[0] += nx * push; b.p[1] += ny * push; b.p[2] += nz * push;
        const vn = (b.v[0] - a.v[0]) * nx + (b.v[1] - a.v[1]) * ny + (b.v[2] - a.v[2]) * nz;
        if (vn >= 0) continue;
        const impulse = -(1 + restitution) * vn / 2;
        a.v[0] -= nx * impulse; a.v[1] -= ny * impulse; a.v[2] -= nz * impulse;
        b.v[0] += nx * impulse; b.v[1] += ny * impulse; b.v[2] += nz * impulse;
      }
    }
  }

  // Runs `substep` at a fixed rate, at most a few steps per frame.
  function makeStepper(substep) {
    let accumulator = 0;
    return (dt, time) => {
      accumulator = Math.min(accumulator + dt, STEP * 6);
      while (accumulator >= STEP) {
        substep(STEP, time);
        accumulator -= STEP;
      }
    };
  }

  const VIEW_GLSL = `
    uniform vec3 uCam;
    uniform vec2 uYaw;
    uniform vec2 uPitch;
    uniform float uFocal;
    uniform float uAspect;
    vec3 toView(vec3 world) {
      vec3 p = world - uCam;
      p = vec3(uYaw.x * p.x - uYaw.y * p.z, p.y, uYaw.y * p.x + uYaw.x * p.z);
      return vec3(p.x, uPitch.x * p.y - uPitch.y * p.z, uPitch.y * p.y + uPitch.x * p.z);
    }
    vec4 toClip(vec3 view) {
      float w = -view.z;
      return vec4(view.x * uFocal / uAspect, view.y * uFocal, w - ${(2 * DEPTH_NEAR).toFixed(1)}, w);
    }
  `;

  function setView(gl, u, camera, FOCAL, aspect) {
    gl.uniform3f(u.uCam, camera.x, camera.y, camera.z);
    gl.uniform2f(u.uYaw, camera.cy, camera.sy);
    gl.uniform2f(u.uPitch, camera.cp, camera.sp);
    gl.uniform1f(u.uFocal, FOCAL);
    gl.uniform1f(u.uAspect, aspect);
  }

  // ---------------------------------------------------------------- balls

  const BALL = {
    RADIUS: 0.22,
    MAX: 16,
    RESTITUTION: 0.52,
    FRICTION: 0.3,       // friction coefficient against the surface
    ROLLING: 2.5,        // rolling resistance, 1/s (the field is bumpy; balls should linger)
    BOUNCE_MIN: 0.5,     // slower impacts settle instead of bouncing
    SHRINK: 0.35,        // seconds a retiring ball takes to vanish
  };

  // `surface(x, z, t, out)` fills out.y, out.nx/ny/nz (unit normal) and out.vy
  // (vertical speed of the surface) for the dot field.
  function createBalls({ surface, gl, createProgram, FOCAL, view, foreground, background }) {
    const balls = [];
    const sample = { y: 0, nx: 0, ny: 1, nz: 0, vy: 0 };

    function spawn(x, z) {
      balls.push({
        p: [x, 3.2 + rand(0, 0.4), z],
        v: [rand(-0.3, 0.3), 0, rand(-0.3, 0.3)],
        scale: 1,
        retiring: false,
        resting: 0,
      });
      let live = balls.filter(b => !b.retiring).length;
      for (let i = 0; i < balls.length && live > BALL.MAX; i++) {
        if (!balls[i].retiring) {
          balls[i].retiring = true;
          live--;
        }
      }
    }

    function substep(h, t) {
      const R = BALL.RADIUS;
      for (const b of balls) {
        if (b.retiring) {
          b.scale -= h / BALL.SHRINK;
          continue;
        }
        b.v[1] -= G * h;
        b.p[0] += b.v[0] * h; b.p[1] += b.v[1] * h; b.p[2] += b.v[2] * h;

        surface(b.p[0], b.p[2], t, sample);
        const { nx, ny, nz } = sample;
        // Signed distance from the centre to the tangent plane under it.
        const dist = (b.p[1] - sample.y) * ny;
        if (dist < R) {
          const pen = R - dist;
          b.p[0] += nx * pen; b.p[1] += ny * pen; b.p[2] += nz * pen;
          // Velocity relative to the moving surface.
          const rvx = b.v[0], rvy = b.v[1] - sample.vy, rvz = b.v[2];
          const vn = rvx * nx + rvy * ny + rvz * nz;
          if (vn < 0) {
            const bounce = vn < -BALL.BOUNCE_MIN;
            const j = bounce ? -(1 + BALL.RESTITUTION) * vn : -vn;
            b.v[0] += nx * j; b.v[1] += ny * j; b.v[2] += nz * j;
            if (bounce) {
              // Friction on impact spins the ball up: a sliding sphere keeps
              // 5/7 of its tangential speed once it rolls.
              const tx = rvx - nx * vn, ty = rvy - ny * vn, tz = rvz - nz * vn;
              const tl = Math.hypot(tx, ty, tz);
              if (tl > 1e-5) {
                const f = Math.min(BALL.FRICTION * j, tl * 2 / 7);
                b.v[0] -= (tx / tl) * f; b.v[1] -= (ty / tl) * f; b.v[2] -= (tz / tl) * f;
              }
            }
          }
          // Rolling, not sliding, down the slope: a solid sphere accelerates at
          // 5/7 of the tangential gravity, so take the other 2/7 back out.
          const an = -G * ny;
          const atx = -nx * an, aty = -G - ny * an, atz = -nz * an;
          b.v[0] -= atx * h * 2 / 7; b.v[1] -= aty * h * 2 / 7; b.v[2] -= atz * h * 2 / 7;
          const k = Math.max(0, 1 - BALL.ROLLING * h);
          b.v[0] *= k; b.v[2] *= k;
          b.resting = 1;
        } else {
          b.resting = Math.max(0, b.resting - h * 4);
        }
      }
      collideSpheres(balls.filter(b => !b.retiring), R, 0.7);

      for (let i = balls.length - 1; i >= 0; i--) {
        const b = balls[i];
        const gone = b.scale <= 0 || b.p[1] < -4 || Math.abs(b.p[0]) > 18 || b.p[2] < -19.5 || b.p[2] > 1.2;
        if (gone) balls.splice(i, 1);
      }
    }
    const step = makeStepper(substep);

    // Rendering: one quad per ball, the sphere is ray-cast in the fragment shader.
    let gfx = null;
    function graphics() {
      if (gfx) return gfx;
      const VERT = `
        attribute vec2 aCorner;
        uniform vec4 uBall; // centre, radius
        ${VIEW_GLSL}
        varying vec3 vPos;
        varying vec3 vCenter;
        void main() {
          vec3 c = toView(uBall.xyz);
          vec3 p = c + vec3(aCorner * uBall.w * 1.15, 0.0);
          vPos = p;
          vCenter = c;
          gl_Position = toClip(p);
        }
      `;
      const FRAG = `
        precision highp float;
        uniform float uRadius;
        uniform vec3 uBg;
        uniform vec3 uFg;
        uniform vec3 uKey;  // key light direction, world
        uniform vec3 uFill;
        uniform vec2 uYaw;
        uniform vec2 uPitch;
        varying vec3 vPos;
        varying vec3 vCenter;

        // What the chrome reflects: the page above, the dot field below.
        vec3 env(vec3 d) {
          float up = d.y;
          vec3 sky = mix(uBg, vec3(1.0), 0.8 * pow(clamp(up, 0.0, 1.0), 0.8));
          vec3 ground = mix(uBg, uFg, 0.3 * pow(clamp(-up, 0.0, 1.0), 0.6));
          vec3 c = mix(ground, sky, smoothstep(-0.04, 0.04, up));
          c += (uFg - uBg) * 0.06 * exp(-abs(up) * 14.0); // dense dots along the horizon
          c += vec3(1.0) * pow(max(dot(d, uKey), 0.0), 90.0) * 1.3;
          c += vec3(1.0) * pow(max(dot(d, uFill), 0.0), 10.0) * 0.12;
          return c;
        }

        void main() {
          vec3 dir = normalize(vPos);
          float tca = dot(vCenter, dir);
          float d2 = dot(vCenter, vCenter) - tca * tca;
          float dmin = sqrt(max(d2, 0.0));
          if (dmin > uRadius) discard;
          float thc = sqrt(max(uRadius * uRadius - d2, 0.0));
          vec3 hit = dir * (tca - thc);
          vec3 n = (hit - vCenter) / uRadius;
          vec3 r = reflect(dir, n);
          // View space back to world for the environment lookup.
          r = vec3(r.x, uPitch.x * r.y + uPitch.y * r.z, -uPitch.y * r.y + uPitch.x * r.z);
          r = vec3(uYaw.x * r.x + uYaw.y * r.z, r.y, -uYaw.y * r.x + uYaw.x * r.z);
          float fresnel = pow(1.0 - max(dot(n, -dir), 0.0), 5.0);
          vec3 c = env(r) * mix(0.86, 1.0, fresnel);
          float a = smoothstep(uRadius, uRadius * 0.965, dmin);
          gl_FragColor = vec4(c * a, a);
        }
      `;
      const { program, uniforms } = createProgram(VERT, FRAG, 'aCorner', [
        'uBall', 'uCam', 'uYaw', 'uPitch', 'uFocal', 'uAspect',
        'uRadius', 'uBg', 'uFg', 'uKey', 'uFill',
      ]);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gfx = { program, u: uniforms, buffer };
      return gfx;
    }

    function draw(camera) {
      if (!balls.length) return;
      const { program, u, buffer } = graphics();
      gl.useProgram(program);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      setView(gl, u, camera, FOCAL, view.aspect);
      gl.uniform3f(u.uBg, background[0], background[1], background[2]);
      gl.uniform3f(u.uFg, foreground[0], foreground[1], foreground[2]);
      const key = [-0.45, 0.8, 0.4], fill = [0.7, 0.3, -0.6];
      const kl = Math.hypot(...key), fl = Math.hypot(...fill);
      gl.uniform3f(u.uKey, key[0] / kl, key[1] / kl, key[2] / kl);
      gl.uniform3f(u.uFill, fill[0] / fl, fill[1] / fl, fill[2] / fl);
      for (const b of balls) {
        const r = BALL.RADIUS * Math.max(0, b.scale);
        gl.uniform4f(u.uBall, b.p[0], b.p[1], b.p[2], r);
        gl.uniform1f(u.uRadius, r);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }

    // Positions and radii for the contact shadows the dot shader draws.
    const shadowData = new Float32Array(BALL.MAX * 4);
    function shadows() {
      let n = 0;
      for (const b of balls) {
        if (n >= BALL.MAX) break;
        shadowData[n * 4] = b.p[0];
        shadowData[n * 4 + 1] = b.p[1];
        shadowData[n * 4 + 2] = b.p[2];
        shadowData[n * 4 + 3] = BALL.RADIUS * Math.max(0, b.scale);
        n++;
      }
      return { data: shadowData, count: n };
    }

    return { spawn, step, draw, shadows, bodies: balls, MAX: BALL.MAX };
  }

  // ---------------------------------------------------------------- ducks

  const DUCK = {
    MAX: 16,
    MASS: 1,
    INERTIA: 0.02,
    DENSITY: 0.3,        // relative to water: floats with ~30 % submerged
    DRAG: 6,             // water drag per unit mass on a submerged hull point, 1/s
    AIR_DRAG: 0.08,
    SPIN_DRAG: 0.3,
    POINT_RADIUS: 0.07,  // a hull point goes from dry to submerged over twice this
    BALLAST: 0.14,       // the weighted bottom: how far the centre of mass sits below the pivot
    BOUND: 0.22,         // collision sphere
  };
  // Where buoyancy and drag act, in the duck's frame (forward = +x, up = +y),
  // with the share of the duck's volume each point stands for.
  // The wide ring sits at the waterline, which keeps the duck upright; the back
  // is narrow, so upside down it rolls over instead of finding a second rest.
  const HULL = [
    [0.18, -0.09, 0, 1], [-0.18, -0.09, 0, 1], [0, -0.09, 0.13, 1], [0, -0.09, -0.13, 1],
    [0.12, -0.09, 0.09, 1], [0.12, -0.09, -0.09, 1], [-0.12, -0.09, 0.09, 1], [-0.12, -0.09, -0.09, 1],
    [0, -0.14, 0, 1.5], [0.1, 0.08, 0, 0.5], [-0.1, 0.08, 0, 0.5], [0.15, 0.17, 0, 0.5],
  ];
  const HULL_VOLUME = HULL.reduce((sum, point) => sum + point[3], 0);

  // `water(x, z, t, out)` fills out.y and out.vx/vy/vz (surface height and the
  // water's velocity there); `splash(x, z, depth, radius)` stamps a ripple.
  function createDucks({ water, splash, gl, createProgram, FOCAL, view }) {
    const ducks = [];
    const sample = { y: 0, vx: 0, vy: 0, vz: 0 };
    const force = [0, 0, 0];
    const torque = [0, 0, 0];

    function spawn(x, z) {
      let q = qaxis([0, 1, 0], rand(0, Math.PI * 2));
      q = qmul(q, qaxis([rand(-1, 1), 0, rand(-1, 1)], rand(0.2, 0.9)));
      ducks.push({
        p: [x, 3 + rand(0, 0.5), z],
        v: [rand(-0.3, 0.3), 0, rand(-0.3, 0.3)],
        q: qnormalize(q),
        w: [rand(-3, 3), rand(-2, 2), rand(-3, 3)],
        wet: false,
      });
      while (ducks.length > DUCK.MAX) ducks.shift();
    }

    function substep(h, t) {
      const m = DUCK.MASS;
      const unitBuoyancy = (m * G) / DUCK.DENSITY / HULL_VOLUME;
      const unitMass = m / HULL_VOLUME;
      for (const d of ducks) {
        force[0] = 0; force[1] = -m * G; force[2] = 0;
        // Gravity pulls at the ballast, below the pivot, which rights the duck.
        const g = qrotate(d.q, [0, -DUCK.BALLAST, 0]);
        torque[0] = g[1] * 0 - g[2] * (-m * G);
        torque[1] = 0;
        torque[2] = g[0] * (-m * G) - 0;

        let submerged = 0;
        for (const local of HULL) {
          const r = qrotate(d.q, local);
          const px = d.p[0] + r[0], py = d.p[1] + r[1], pz = d.p[2] + r[2];
          water(px, pz, t, sample);
          const s = Math.min(1, Math.max(0, (sample.y - py) / (2 * DUCK.POINT_RADIUS) + 0.5));
          if (s <= 0) continue;
          submerged += s * local[3] / HULL_VOLUME;
          // Point velocity = v + ω × r, drag toward the water's own motion.
          const vx = d.v[0] + d.w[1] * r[2] - d.w[2] * r[1];
          const vy = d.v[1] + d.w[2] * r[0] - d.w[0] * r[2];
          const vz = d.v[2] + d.w[0] * r[1] - d.w[1] * r[0];
          const k = s * DUCK.DRAG * unitMass * local[3];
          const fx = -k * (vx - sample.vx);
          const fy = s * unitBuoyancy * local[3] - k * (vy - sample.vy);
          const fz = -k * (vz - sample.vz);
          force[0] += fx; force[1] += fy; force[2] += fz;
          torque[0] += r[1] * fz - r[2] * fy;
          torque[1] += r[2] * fx - r[0] * fz;
          torque[2] += r[0] * fy - r[1] * fx;
        }
        if (submerged > 0 && !d.wet) {
          d.wet = true;
          if (splash) splash(d.p[0], d.p[2], Math.min(0.5, 0.1 + Math.abs(d.v[1]) * 0.07), 2.6);
        }
        if (submerged === 0) {
          force[0] -= d.v[0] * DUCK.AIR_DRAG; force[1] -= d.v[1] * DUCK.AIR_DRAG; force[2] -= d.v[2] * DUCK.AIR_DRAG;
        }
        for (let i = 0; i < 3; i++) {
          torque[i] -= d.w[i] * DUCK.SPIN_DRAG * DUCK.INERTIA * (1 + submerged * 6);
          d.v[i] += (force[i] / m) * h;
          d.w[i] += (torque[i] / DUCK.INERTIA) * h;
          d.p[i] += d.v[i] * h;
        }
        qintegrate(d.q, d.w, h);
      }
      collideSpheres(ducks, DUCK.BOUND, 0.25);

      for (let i = ducks.length - 1; i >= 0; i--) {
        const p = ducks[i].p;
        if (p[2] > 0.8 || p[2] < -80 || Math.abs(p[0]) > 60 || p[1] < -3) ducks.splice(i, 1);
      }
    }
    const step = makeStepper(substep);

    // ---- mesh: a few ellipsoids
    function buildMesh() {
      const SEG = 22, RING = 14;
      const verts = [];
      const index = [];
      function part(cx, cy, cz, rx, ry, rz, color, tilt) {
        const base = verts.length / 9;
        const ct = Math.cos(tilt), st = Math.sin(tilt);
        for (let r = 0; r <= RING; r++) {
          const phi = (Math.PI * r) / RING;
          const uy = Math.cos(phi), ur = Math.sin(phi);
          for (let s = 0; s <= SEG; s++) {
            const th = (2 * Math.PI * s) / SEG;
            const ux = ur * Math.cos(th), uz = ur * Math.sin(th);
            let px = ux * rx, py = uy * ry, pz = uz * rz;
            let nx = ux / rx, ny = uy / ry, nz = uz / rz;
            const nl = Math.hypot(nx, ny, nz);
            nx /= nl; ny /= nl; nz /= nl;
            // Tilt about the z axis.
            [px, py] = [px * ct - py * st, px * st + py * ct];
            [nx, ny] = [nx * ct - ny * st, nx * st + ny * ct];
            verts.push(px + cx, py + cy, pz + cz, nx, ny, nz, color[0], color[1], color[2]);
          }
        }
        for (let r = 0; r < RING; r++) {
          for (let s = 0; s < SEG; s++) {
            const a = base + r * (SEG + 1) + s;
            const b = a + SEG + 1;
            index.push(a, b, a + 1, a + 1, b, b + 1);
          }
        }
      }
      const yellow = [1.0, 0.72, 0.04];  // linear-light colours
      const orange = [1.0, 0.2, 0.015];
      const dark = [0.015, 0.012, 0.01];
      part(0, 0, 0, 0.26, 0.15, 0.19, yellow, 0);               // body
      part(0.15, 0.17, 0, 0.115, 0.115, 0.105, yellow, 0);      // head
      part(0.265, 0.155, 0, 0.075, 0.032, 0.05, orange, -0.12); // beak
      part(-0.22, 0.07, 0, 0.10, 0.045, 0.07, yellow, -0.6);    // tail, rising at the back
      part(0.225, 0.205, 0.078, 0.02, 0.02, 0.02, dark, 0);     // eyes
      part(0.225, 0.205, -0.078, 0.02, 0.02, 0.02, dark, 0);
      return { verts: new Float32Array(verts), index: new Uint16Array(index) };
    }

    let gfx = null;
    function graphics() {
      if (gfx) return gfx;
      const VERT = `
        attribute vec3 aPos;
        attribute vec3 aNormal;
        attribute vec3 aColor;
        uniform mat3 uRot;
        uniform vec3 uPos;
        ${VIEW_GLSL}
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying vec3 vColor;
        void main() {
          vec3 world = uRot * aPos + uPos;
          vWorld = world;
          vNormal = uRot * aNormal;
          vColor = aColor;
          gl_Position = toClip(toView(world));
        }
      `;
      const FRAG = `
        precision mediump float;
        uniform vec3 uSun;
        uniform vec3 uBg;    // page background, linear
        uniform vec3 uHaze;  // horizon colour, linear
        uniform vec3 uEye;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying vec3 vColor;
        const vec3 LIGHT = vec3(1.0, 0.95, 0.86);
        void main() {
          vec3 n = normalize(vNormal);
          vec3 toEye = uEye - vWorld;
          float dist = length(toEye);
          vec3 V = toEye / dist;
          float diffuse = max(dot(n, uSun), 0.0);
          vec3 H = normalize(uSun + V);
          float spec = pow(max(dot(n, H), 0.0), 60.0);
          float ambient = 0.12 + 0.6 * dot(uBg, vec3(0.2126, 0.7152, 0.0722));
          float hemi = mix(0.45, 1.0, 0.5 + 0.5 * n.y);
          vec3 c = vColor * (ambient * hemi + diffuse * 1.1 * LIGHT) + LIGHT * spec * 0.5;
          c += vColor * pow(1.0 - max(dot(n, V), 0.0), 3.0) * 0.1;
          float fog = 1.0 - exp(-dist * 0.005);
          c = mix(c, uHaze, fog);
          gl_FragColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
        }
      `;
      const { program, uniforms } = createProgram(VERT, FRAG, 'aPos', [
        'uRot', 'uPos', 'uCam', 'uYaw', 'uPitch', 'uFocal', 'uAspect', 'uSun', 'uBg', 'uHaze', 'uEye',
      ]);
      const mesh = buildMesh();
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.verts, gl.STATIC_DRAW);
      const indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.index, gl.STATIC_DRAW);
      gfx = {
        program, u: uniforms, buffer, indexBuffer, count: mesh.index.length,
        aNormal: gl.getAttribLocation(program, 'aNormal'),
        aColor: gl.getAttribLocation(program, 'aColor'),
      };
      return gfx;
    }

    const matrix = new Float32Array(9);

    function draw(camera, sun, bgLinear) {
      if (!ducks.length) return;
      const { program, u, buffer, indexBuffer, count, aNormal, aColor } = graphics();
      gl.useProgram(program);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.enableVertexAttribArray(0);
      gl.enableVertexAttribArray(aNormal);
      gl.enableVertexAttribArray(aColor);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
      gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 36, 12);
      gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 36, 24);
      setView(gl, u, camera, FOCAL, view.aspect);
      gl.uniform3f(u.uEye, camera.x, camera.y, camera.z);
      gl.uniform3f(u.uSun, sun[0], sun[1], sun[2]);
      gl.uniform3f(u.uBg, bgLinear[0], bgLinear[1], bgLinear[2]);
      // Same haze the sky shader shows at the horizon.
      gl.uniform3f(u.uHaze,
        bgLinear[0] + (1 - bgLinear[0]) * 0.02,
        bgLinear[1] + (1 - bgLinear[1]) * 0.036,
        bgLinear[2] + (1 - bgLinear[2]) * 0.06);
      for (const d of ducks) {
        gl.uniformMatrix3fv(u.uRot, false, qmatrix(d.q, matrix));
        gl.uniform3f(u.uPos, d.p[0], d.p[1], d.p[2]);
        gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
      }
      gl.disableVertexAttribArray(aNormal);
      gl.disableVertexAttribArray(aColor);
    }

    return { spawn, step, draw, bodies: ducks, MAX: DUCK.MAX };
  }

  const api = { createBalls, createDucks, qrotate, DEPTH_NEAR };
  if (typeof window !== 'undefined') window.toys = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
