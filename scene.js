// Two 3D backgrounds rendered with raw WebGL (no dependencies):
//   "dots"  – a field of points riding a sine wave; while music plays the same
//             points line up into a graphic equalizer driven by music.js
//   "ocean" – a lit Gerstner-wave sea with an interactive ripple simulation
(() => {
  const canvas = document.querySelector('#scene');
  if (!canvas) return;

  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    depth: true, // the balls and ducks sit in front of / behind the background
    stencil: false,
    premultipliedAlpha: true,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    canvas.remove();
    return;
  }

  const root = document.documentElement;
  const profile = document.querySelector('.profile');
  const modeToggle = document.querySelector('#mode-toggle');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const FOCAL = 1 / Math.tan((50 * Math.PI) / 360); // 50° vertical FOV

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  // Every program takes its single vertex attribute at location 0.
  function createProgram(vert, frag, attribute, uniformNames) {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vert));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(program, 0, attribute);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
    const uniforms = {};
    for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
    return { program, uniforms };
  }

  // ---------------------------------------------------------------- shared state

  const view = { width: 1, height: 1, aspect: 1 };
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    view.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== view.width || canvas.height !== view.height) {
      canvas.width = view.width;
      canvas.height = view.height;
    }
    gl.viewport(0, 0, view.width, view.height);
    view.aspect = view.width / view.height;
  }

  // Colors follow the page background / foreground chosen by the slider.
  const foreground = [0.96, 0.96, 0.96];
  const background = [0, 0, 0];
  let targetForeground = foreground.slice();
  let targetBackground = background.slice();
  function parseColor(name) {
    let hex = getComputedStyle(root).getPropertyValue(name).trim().replace('#', '');
    if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
    if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
    return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  }
  function readColors() {
    targetForeground = parseColor('--page-foreground') || targetForeground;
    targetBackground = parseColor('--page-background') || targetBackground;
  }

  // Pointer: target values are set by events, current values ease toward them.
  const pointer = {
    x: 0, y: 0, tx: 0, ty: 0,
    active: false, strength: 0,
  };
  function onPointerMove(event) {
    pointer.tx = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.ty = 1 - (event.clientY / window.innerHeight) * 2;
    pointer.active = true;
  }
  function onPointerGone() {
    pointer.active = false;
    pointer.tx = 0;
    pointer.ty = 0;
  }

  // Builds the camera for a frame and casts a pointer ray onto the y = 0 plane.
  // `raw` aims the ray at the live cursor position instead of the eased one.
  function makeCamera(height, z, basePitch, swayX, still, raw) {
    const sway = still ? 0 : 1;
    const yaw = pointer.x * 0.07 * sway;
    const pitch = basePitch + pointer.y * 0.03 * sway;
    const camera = {
      x: pointer.x * swayX * sway,
      y: height,
      z,
      cy: Math.cos(yaw), sy: Math.sin(yaw),
      cp: Math.cos(pitch), sp: Math.sin(pitch),
      hit: null,
    };
    // Inverse of the shaders' view rotation.
    const vx = ((raw ? pointer.tx : pointer.x) * view.aspect) / FOCAL;
    const vy = (raw ? pointer.ty : pointer.y) / FOCAL;
    const ry = camera.cp * vy - camera.sp;
    const rz1 = -camera.sp * vy - camera.cp;
    const rx = camera.cy * vx + camera.sy * rz1;
    const rz = -camera.sy * vx + camera.cy * rz1;
    if (ry < -0.02) {
      const t = height / -ry;
      camera.hit = { x: camera.x + rx * t, z: z + rz * t };
    }
    return camera;
  }

  // Clip-space depth used by every program: z = w - 1, i.e. 1 / w depth.
  const CLIP_Z = 'w - 1.0';
  const toys = window.toys || null;
  const toyContext = { gl, createProgram, FOCAL, view, foreground, background };

  // ---------------------------------------------------------------- dots mode

  const dots = (() => {
    const SHADOWS = toys ? 16 : 1;
    // Grid on the XZ plane, stretching away from the camera.
    const COLS = 210;
    const ROWS = 120;
    const HALF_WIDTH = 17;
    const DEPTH = 19;

    // Equalizer layout: every band is a bar of dot columns plus one empty
    // column. The nearest rows stand up as the bars, the rest mirror them below.
    const BAND_COLS = 7;
    const BANDS = COLS / BAND_COLS;
    const BAR_ROWS = 80;
    const MIRROR_ROWS = ROWS - BAR_ROWS;
    const WALL_DISTANCE = 10;
    const MORPH_SECONDS = 1.6;

    const VERT = `
      attribute vec2 aGrid;
      uniform float uTime;
      uniform float uAspect;
      uniform float uFocal;
      uniform float uHeight;
      uniform vec3 uCam;
      uniform vec2 uYaw;
      uniform vec2 uPitch;
      uniform vec3 uPointer; // xz on the plane + strength
      uniform float uMorph;  // 0 = wave field, 1 = equalizer
      uniform vec4 uWall;    // column pitch, row pitch, base height, distance (view space)
      uniform vec2 uTilt;
      uniform vec4 uLayout;  // columns per bar, gap columns, spectrum bands per bar, dot scale
      uniform vec2 uBand[${BANDS}]; // level and peak marker per band, 0..1
      uniform vec4 uShadow[${SHADOWS}]; // ball centre and radius
      uniform int uShadowCount;
      varying float vAlpha;

      void main() {
        float x = aGrid.x;
        float z = aGrid.y;

        float wave =
          sin(x * 0.55 + uTime * 0.50) * cos(z * 0.45 + uTime * 0.35) +
          0.50 * sin((x + z) * 1.10 - uTime * 0.80) +
          0.14 * sin(z * 1.60 + x * 0.40 + uTime * 1.10);
        float h = wave / 1.64; // -1..1

        float d = distance(vec2(x, z), uPointer.xy);
        float bump = exp(-d * d * 0.5) * uPointer.z;
        float ripple = bump * (0.8 + 0.2 * sin(d * 2.2 - uTime * 3.0));

        vec3 p = vec3(x, h * 0.32 + ripple * 0.3, z) - uCam;
        p = vec3(uYaw.x * p.x - uYaw.y * p.z, p.y, uYaw.y * p.x + uYaw.x * p.z);
        p = vec3(p.x, uPitch.x * p.y - uPitch.y * p.z, uPitch.y * p.y + uPitch.x * p.z);

        float w = -p.z;
        float crest = h * 0.5 + 0.5;
        float size = (0.016 + 0.014 * crest + 0.012 * bump) * uFocal / max(w, 0.001) * uHeight * 0.5;
        float fog = smoothstep(19.0, 4.0, w) * smoothstep(0.6, 2.6, w);
        float side = smoothstep(17.0, 9.0, abs(x));
        float alpha = fog * side * (0.22 + 0.58 * crest + 0.45 * bump);

        // Contact shadows under the balls, fading as they rise off the surface.
        float dotY = h * 0.32 + ripple * 0.3;
        for (int i = 0; i < ${SHADOWS}; i++) {
          if (i >= uShadowCount) break;
          vec4 b = uShadow[i];
          float dd = distance(vec2(x, z), b.xz);
          float lift = 1.0 - smoothstep(0.0, 1.8, b.y - b.w - dotY);
          alpha *= 1.0 - 0.85 * lift * exp(-dd * dd / (b.w * b.w * 1.7));
        }

        if (uMorph > 0.0) {
          float col = floor((x + ${HALF_WIDTH}.0) * ${(COLS - 1) / (2 * HALF_WIDTH)} + 0.5);
          float row = floor(-z * ${(ROWS - 1) / DEPTH} + 0.5);
          float band = min(floor(col / uLayout.x), ${BANDS - 1}.0);
          float bar = step(col - band * uLayout.x, uLayout.x - uLayout.y - 0.5); // 0 in the gap columns
          vec2 level = uBand[int(band * uLayout.z)];

          // Rows past the bar height are its reflection, counted from the base down.
          float mirror = step(${BAR_ROWS}.0, row);
          float k = row - ${BAR_ROWS}.0 * mirror;
          float lit = clamp(level.x * ${BAR_ROWS}.0 - k, 0.0, 1.0);
          float cap = step(abs(k - floor(level.y * ${BAR_ROWS}.0)), 0.5) * step(0.03, level.y);
          float glow = max(lit, cap);

          vec3 e = vec3(
            (col - ${(COLS - 1) / 2}) * uWall.x,
            uWall.z + (k + 0.5) * uWall.y * (1.0 - 2.0 * mirror),
            -uWall.w);
          e.z += e.x * uTilt.x + (e.y - uWall.z) * uTilt.y;

          float eSize = uWall.x * uLayout.w * mix(0.3, 0.66, glow) * uFocal / -e.z * uHeight * 0.5;
          // Unlit dots only linger just above the bar, so the wall itself stays invisible.
          float unlit = 0.1 * exp(-max(0.0, k - level.x * ${BAR_ROWS}.0) / 4.0);
          float eAlpha = bar * max(mix(unlit, 0.5 + 0.5 * k / ${BAR_ROWS}.0, lit), cap);
          // The base must stay >= 0: a negative one makes pow() NaN, which Apple GPUs
          // carry through to the alpha and draw as a solid dot.
          eAlpha *= mix(1.0, 0.32 * pow(max(0.0, 1.0 - k / ${MIRROR_ROWS}.0), 1.5), mirror);

          // The field folds up from the front edge, each dot slightly out of step.
          float seed = fract(sin(dot(aGrid, vec2(12.9898, 78.233))) * 43758.5453);
          float m = clamp(uMorph * 1.7 - 0.4 * row / ${ROWS - 1}.0 - 0.3 * seed, 0.0, 1.0);
          m = m * m * (3.0 - 2.0 * m);
          p = mix(p, e, m);
          p.xy += sin(m * 3.14159) * vec2(seed - 0.5, fract(seed * 7.13) - 0.2) * 0.3;
          w = -p.z;
          size = mix(size, eSize, m);
          alpha = mix(alpha, eAlpha, m);
        }

        gl_Position = vec4(p.x * uFocal / uAspect, p.y * uFocal, ${CLIP_Z}, w);
        float maxSize = uHeight * 0.008;
        gl_PointSize = clamp(size, 1.0, maxSize);
        float thin = clamp(size, 0.35, 1.0); // sub-pixel dots fade instead of shimmering
        vAlpha = clamp(alpha * thin, 0.0, 1.0);
      }
    `;
    const FRAG = `
      precision mediump float;
      uniform vec3 uColor;
      varying float vAlpha;

      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.32, d) * clamp(vAlpha, 0.0, 1.0);
        gl_FragColor = vec4(uColor * a, a);
      }
    `;

    const { program, uniforms: u } = createProgram(VERT, FRAG, 'aGrid', [
      'uTime', 'uAspect', 'uFocal', 'uHeight', 'uCam', 'uYaw', 'uPitch', 'uPointer', 'uColor',
      'uMorph', 'uWall', 'uTilt', 'uLayout', 'uBand', 'uShadow', 'uShadowCount',
    ]);

    const grid = new Float32Array(COLS * ROWS * 2);
    for (let r = 0, i = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        grid[i++] = (c / (COLS - 1)) * 2 * HALF_WIDTH - HALF_WIDTH;
        grid[i++] = -(r / (ROWS - 1)) * DEPTH;
      }
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, grid, gl.STATIC_DRAW);

    const swell = { x: 0, z: -8, strength: 0 };
    const bandData = new Float32Array(BANDS * 2);
    let morph = 0;

    // The surface the shader draws, evaluated on the CPU for the balls.
    function heightAt(x, z, t) {
      const wave =
        Math.sin(x * 0.55 + t * 0.5) * Math.cos(z * 0.45 + t * 0.35) +
        0.5 * Math.sin((x + z) * 1.1 - t * 0.8) +
        0.14 * Math.sin(z * 1.6 + x * 0.4 + t * 1.1);
      const d = Math.hypot(x - swell.x, z - swell.z);
      const bump = Math.exp(-d * d * 0.5) * swell.strength;
      const ripple = bump * (0.8 + 0.2 * Math.sin(d * 2.2 - t * 3));
      return (wave / 1.64) * 0.32 + ripple * 0.3;
    }
    function surfaceAt(x, z, t, out) {
      const e = 0.05;
      const y = heightAt(x, z, t);
      const sx = (heightAt(x + e, z, t) - heightAt(x - e, z, t)) / (2 * e);
      const sz = (heightAt(x, z + e, t) - heightAt(x, z - e, t)) / (2 * e);
      const l = Math.hypot(sx, 1, sz);
      out.y = y;
      out.nx = -sx / l; out.ny = 1 / l; out.nz = -sz / l;
      out.vy = (heightAt(x, z, t + 0.01) - y) / 0.01;
    }
    const balls = toys ? toys.createBalls({ surface: surfaceAt, ...toyContext }) : null;
    const noShadows = { data: new Float32Array(4), count: 0 };

    // `spectrum` is music.js's live analysis while music is playing, else null.
    function draw(time, dt, still, spectrum) {
      const camera = makeCamera(1.9, 0.5, 0.16, 0.5, still, false);
      const sceneTime = still ? 4.0 : time;

      morph = Math.min(1, Math.max(0, morph + (spectrum ? dt : -dt) / MORPH_SECONDS));
      const source = spectrum || window.musicSpectrum;
      // Portrait screens get half as many, twice as wide bars: each shows the
      // louder of two neighbouring spectrum bands.
      const portrait = view.aspect < 0.9;
      const perBar = portrait ? 2 : 1;
      const barCols = BAND_COLS * perBar;
      if (morph > 0 && source) {
        source.update(dt); // keeps running while the bars fold away so they sink first
        const count = Math.min(BANDS, source.levels.length);
        for (let band = 0; band < count; band += perBar) {
          let level = 0, peak = 0;
          for (let i = band; i < Math.min(count, band + perBar); i++) {
            level = Math.max(level, source.levels[i]);
            peak = Math.max(peak, source.peaks[i]);
          }
          bandData[band * 2] = level;
          bandData[band * 2 + 1] = peak;
        }
      }
      // The bars span most of the viewport's width; on tall screens the rows are
      // stretched so the bars fill a good part of the height instead.
      const halfHeight = WALL_DISTANCE / FOCAL;
      const colPitch = (2 * halfHeight * view.aspect * 0.88) / (COLS - 1);
      const minHeight = portrait ? 1.15 : 0.68;
      const rowPitch = (halfHeight * Math.min(1.3, Math.max(minHeight, colPitch * BAR_ROWS / halfHeight))) / BAR_ROWS;
      let hit = 0;
      if (camera.hit) {
        swell.x = camera.hit.x;
        swell.z = camera.hit.z;
        // Fade the swell out toward the horizon, where the ray grazes the plane.
        hit = Math.min(1, Math.max(0, (14 + swell.z) / 6));
      }
      swell.strength = still ? 0 : pointer.strength * hit;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // Balls live on the wave field; while it stands up as the equalizer they wait.
      const ballsShown = balls && morph === 0;
      if (ballsShown) {
        if (!still) balls.step(dt, sceneTime);
        balls.draw(camera);
      }
      const shadows = ballsShown ? balls.shadows() : noShadows;

      gl.useProgram(program);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(false);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      gl.uniform1f(u.uTime, sceneTime);
      gl.uniform1f(u.uAspect, view.aspect);
      gl.uniform1f(u.uFocal, FOCAL);
      gl.uniform1f(u.uHeight, view.height);
      gl.uniform3f(u.uCam, camera.x, camera.y, camera.z);
      gl.uniform2f(u.uYaw, camera.cy, camera.sy);
      gl.uniform2f(u.uPitch, camera.cp, camera.sp);
      gl.uniform3f(u.uPointer, swell.x, swell.z, swell.strength);
      gl.uniform4fv(u.uShadow, shadows.data);
      gl.uniform1i(u.uShadowCount, shadows.count);
      gl.uniform3f(u.uColor, foreground[0], foreground[1], foreground[2]);
      gl.uniform1f(u.uMorph, still ? 0 : morph);
      gl.uniform4f(u.uWall, colPitch, rowPitch, portrait ? -halfHeight * 0.6 : -halfHeight * 0.5, WALL_DISTANCE);
      gl.uniform2f(u.uTilt, pointer.x * 0.06, pointer.y * 0.05);
      gl.uniform4f(u.uLayout, barCols, portrait ? 2 : 1, perBar, portrait ? 1.5 : 1);
      gl.uniform2fv(u.uBand, bandData);
      gl.drawArrays(gl.POINTS, 0, COLS * ROWS);
      gl.depthMask(true);
    }

    function drop(x, z) {
      if (balls && morph === 0) balls.spawn(x, z);
    }

    return { draw, drop };
  })();

  // ---------------------------------------------------------------- ocean mode

  function createOcean() {
    const PRECISION = `
      #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
      #else
      precision mediump float;
      #endif
    `;

    // Sky model shared by the backdrop and the water's reflections. The zenith is
    // exactly the page background, so the canvas blends into the rest of the page.
    const SKY = `
      uniform vec3 uBg;  // page background, linear
      uniform vec3 uSun; // direction toward the sun / moon
      const vec3 LIGHT = vec3(1.0, 0.95, 0.86);

      vec3 sky(vec3 d, float disc) {
        vec3 haze = uBg + (1.0 - uBg) * vec3(0.020, 0.036, 0.060);
        float t = pow(1.0 - clamp(d.y, 0.0, 1.0), 6.0);
        vec3 c = mix(uBg, haze, t);
        float s = max(dot(d, uSun), 0.0);
        c += LIGHT * (pow(s, 48.0) * 0.08 + pow(s, 700.0) * 0.5);
        c += LIGHT * disc * smoothstep(0.99962, 0.99976, s) * 4.0;
        return c;
      }

      vec3 toScreen(vec3 c) {
        float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)) + (n - 0.5) / 255.0;
      }
    `;

    const SKY_VERT = `
      attribute vec2 aPos;
      void main() {
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;
    const SKY_FRAG = `
      ${PRECISION}
      ${SKY}
      uniform vec2 uRes;
      uniform float uFocal;
      uniform vec2 uYaw;
      uniform vec2 uPitch;

      void main() {
        vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
        vec3 v = vec3(ndc.x * uRes.x / uRes.y / uFocal, ndc.y / uFocal, -1.0);
        float ry = uPitch.x * v.y + uPitch.y * v.z;
        float rz = -uPitch.y * v.y + uPitch.x * v.z;
        vec3 d = normalize(vec3(uYaw.x * v.x + uYaw.y * rz, ry, -uYaw.y * v.x + uYaw.x * rz));
        gl_FragColor = vec4(toScreen(sky(d, 1.0)), 1.0);
      }
    `;

    const WAVES = 13;        // total wave components
    const GERSTNER = 5;      // the largest ones also displace the mesh
    const STEEPNESS = 0.14;  // per-wave Gerstner steepness (Q * k * A)
    const NEAR = 2;
    const FAR = 400;

    const WATER_VERT = `
      attribute vec2 aUV;
      uniform float uTime;
      uniform float uAspect;
      uniform float uFocal;
      uniform float uSpread;
      uniform vec3 uCam;
      uniform vec2 uYaw;
      uniform vec2 uPitch;
      uniform vec4 uWave[${WAVES}]; // direction.xz, wavenumber, amplitude
      varying vec3 vWorld;
      varying vec2 vOrigin;

      void main() {
        // Rows bunch up near the camera and fan out to the horizon.
        float dist = ${NEAR}.0 + ${FAR - NEAR}.0 * pow(aUV.y, 2.5);
        float rowGap = ${FAR - NEAR}.0 * 2.5 * pow(aUV.y, 1.5) / 255.0;
        vec2 o = vec2((aUV.x * 2.0 - 1.0) * (dist * uSpread + 2.0) + uCam.x, -dist);

        vec3 p = vec3(o.x, 0.0, o.y);
        for (int i = 0; i < ${GERSTNER}; i++) {
          vec4 w = uWave[i];
          // Drop waves the mesh can no longer resolve.
          float fade = 1.0 - smoothstep(0.2, 0.5, rowGap * w.z / 6.2832);
          float theta = w.z * dot(w.xy, o) - sqrt(9.8 * w.z) * uTime;
          p.xz += w.xy * (${STEEPNESS} / w.z * cos(theta) * fade);
          p.y += w.w * sin(theta) * fade;
        }
        vWorld = p;
        vOrigin = o;

        vec3 q = p - uCam;
        q = vec3(uYaw.x * q.x - uYaw.y * q.z, q.y, uYaw.y * q.x + uYaw.x * q.z);
        q = vec3(q.x, uPitch.x * q.y - uPitch.y * q.z, uPitch.y * q.y + uPitch.x * q.z);
        float w = -q.z;
        gl_Position = vec4(q.x * uFocal / uAspect, q.y * uFocal, ${CLIP_Z}, w);
      }
    `;

    const WATER_FRAG = `
      ${PRECISION}
      ${SKY}
      uniform float uTime;
      uniform float uFocal;
      uniform vec2 uRes;
      uniform vec3 uCam;
      uniform vec4 uWave[${WAVES}];
      uniform sampler2D uRipple;
      uniform vec4 uRippleRect; // origin.xz, 1 / size
      uniform float uRippleSlope;
      varying vec3 vWorld;
      varying vec2 vOrigin;

      void main() {
        vec3 toCam = uCam - vWorld;
        float dist = length(toCam);
        vec3 V = toCam / dist;

        // World-space footprint of one pixel along the view direction; waves
        // shorter than a few pixels are faded out instead of aliasing.
        float footprint = dist * dist / (uCam.y * uFocal * uRes.y * 0.5);

        vec3 n = vec3(0.0, 1.0, 0.0);
        for (int i = 0; i < ${GERSTNER}; i++) {
          vec4 w = uWave[i];
          float fade = smoothstep(1.5, 5.0, 6.2832 / w.z / footprint);
          float theta = w.z * dot(w.xy, vOrigin) - sqrt(9.8 * w.z) * uTime;
          n.xz -= w.xy * (w.z * w.w * fade * cos(theta));
          n.y -= ${STEEPNESS} * fade * sin(theta);
        }
        for (int i = ${GERSTNER}; i < ${WAVES}; i++) {
          vec4 w = uWave[i];
          float fade = smoothstep(1.5, 5.0, 6.2832 / w.z / footprint);
          float across = dot(vec2(-w.y, w.x), vWorld.xz);
          float theta = w.z * dot(w.xy, vWorld.xz) - sqrt(9.8 * w.z) * uTime
            + 0.7 * sin(across * w.z * 0.37 + float(i) * 1.7);
          n.xz -= w.xy * (w.z * w.w * fade * cos(theta));
        }

        // Interactive ripples from the simulation.
        vec2 uv = (vWorld.xz - uRippleRect.xy) * uRippleRect.zw;
        vec4 ripple = texture2D(uRipple, clamp(uv, 0.0, 1.0));
        vec2 rippleSlope = (ripple.gb * 255.0 - 128.0) / 127.0 * uRippleSlope;
        n.xz -= rippleSlope;
        n = normalize(n);

        float ndv = max(dot(n, V), 0.0);
        float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

        vec3 R = reflect(-V, n);
        R.y = abs(R.y);
        vec3 reflection = sky(R, 0.0);
        float gloss = mix(900.0, 90.0, smoothstep(4.0, 150.0, dist));
        reflection += LIGHT * pow(max(dot(R, uSun), 0.0), gloss) * 12.0;

        float ambient = 0.06 + dot(uBg, vec3(0.2126, 0.7152, 0.0722));
        vec3 body = mix(vec3(0.002, 0.012, 0.022), uBg * vec3(0.06, 0.20, 0.26), 0.7);
        // Light scattering through the crests.
        body += vec3(0.0, 0.10, 0.09) * ambient * smoothstep(-0.15, 0.45, vWorld.y);

        vec3 color = mix(body, reflection, fresnel);
        // Ripple fronts catch a little extra light so they read on dark water.
        color += (sky(vec3(0.0, 0.0, -1.0), 0.0) + LIGHT * 0.07) * pow(min(length(rippleSlope), 1.0), 1.5) * 0.45;

        float fog = max(1.0 - exp(-dist * 0.005), smoothstep(${FAR * 0.6}.0, ${FAR - 10}.0, dist));
        vec3 horizon = sky(normalize(vec3(-V.x, 0.0, -V.z)), 0.0);
        color = mix(color, horizon, fog);

        gl_FragColor = vec4(toScreen(color), 1.0);
      }
    `;

    const skyProgram = createProgram(SKY_VERT, SKY_FRAG, 'aPos', [
      'uBg', 'uSun', 'uRes', 'uFocal', 'uYaw', 'uPitch',
    ]);
    const water = createProgram(WATER_VERT, WATER_FRAG, 'aUV', [
      'uBg', 'uSun', 'uTime', 'uAspect', 'uFocal', 'uSpread', 'uRes', 'uCam', 'uYaw', 'uPitch',
      'uWave', 'uRipple', 'uRippleRect', 'uRippleSlope',
    ]);

    // Wave spectrum: wavelength (m), amplitude (m) and heading relative to the
    // prevailing direction. Speeds follow deep-water dispersion in the shader.
    const spectrum = [
      [18.0, 0.26, 0], [11.5, 0.16, 22], [7.3, 0.10, -18], [4.6, 0.06, 38], [2.9, 0.036, -34],
    ];
    const detail = [
      [1.9, 0.10, 12], [1.4, 0.10, -47], [1.05, 0.09, 55], [0.8, 0.09, -8],
      [0.6, 0.08, 31], [0.45, 0.08, -62], [0.33, 0.07, 70], [0.25, 0.07, -25],
    ];
    const waveData = new Float32Array(WAVES * 4);
    const heading = Math.atan2(0.3, 1); // rolling toward the viewer, slightly across
    [...spectrum, ...detail].forEach(([length, size, angle], i) => {
      const k = (2 * Math.PI) / length;
      const a = heading + (angle * Math.PI) / 180;
      waveData[i * 4] = Math.sin(a);
      waveData[i * 4 + 1] = Math.cos(a);
      waveData[i * 4 + 2] = k;
      // Detail waves are specified by slope (k * A) rather than amplitude.
      waveData[i * 4 + 3] = i < GERSTNER ? size : size / k;
    });

    // Backdrop: one oversized triangle.
    const skyBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, skyBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    // Water mesh: 256 x 256 vertices (the most 16-bit indices allow), indexed
    // from the far rows to the near ones so it can be drawn without a depth buffer.
    const SIZE = 256;
    const uv = new Float32Array(SIZE * SIZE * 2);
    for (let r = 0, i = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        uv[i++] = c / (SIZE - 1);
        uv[i++] = r / (SIZE - 1);
      }
    }
    const indices = new Uint16Array((SIZE - 1) * (SIZE - 1) * 6);
    for (let r = SIZE - 2, i = 0; r >= 0; r--) {
      for (let c = 0; c < SIZE - 1; c++) {
        const a = r * SIZE + c;
        const b = a + SIZE;
        indices[i++] = a; indices[i++] = b; indices[i++] = a + 1;
        indices[i++] = a + 1; indices[i++] = b; indices[i++] = b + 1;
      }
    }
    const meshBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    // ---- Ripple physics: a damped 2D wave equation on a height field covering
    // the water in front of the camera, stepped at a fixed rate on the CPU.
    const N = 176;
    const CELL = 0.16;
    const ORIGIN_X = (-N * CELL) / 2;
    const ORIGIN_Z = 0.5 - N * CELL;
    const WAVE_SPEED2 = 0.25; // (c * dt / dx)^2, must stay below 0.5
    const DAMPING = 0.993;
    const SLOPE_RANGE = 1.6;
    const STEP = 1 / 60;

    const heightField = new Float32Array(N * N);
    const velocity = new Float32Array(N * N);
    const absorb = new Float32Array(N * N); // soaks up waves at the borders
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const edge = Math.min(i, j, N - 1 - i, N - 1 - j);
        absorb[j * N + i] = edge === 0 ? 0 : Math.min(1, 0.86 + edge * 0.014);
      }
    }
    const pixels = new Uint8Array(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = 128;
      pixels[i * 4 + 3] = 255;
    }

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let energy = 0;      // simulation steps left before the water goes idle
    let accumulator = 0;
    let lastTouch = null;

    // Pushes the surface down around a point, like a fingertip in water.
    function press(x, z, depth, radius) {
      const ci = (x - ORIGIN_X) / CELL;
      const cj = (z - ORIGIN_Z) / CELL;
      const reach = Math.ceil(radius * 2.5);
      const i0 = Math.max(1, Math.floor(ci - reach));
      const i1 = Math.min(N - 2, Math.ceil(ci + reach));
      const j0 = Math.max(1, Math.floor(cj - reach));
      const j1 = Math.min(N - 2, Math.ceil(cj + reach));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const d2 = ((i - ci) ** 2 + (j - cj) ** 2) / (radius * radius);
          const index = j * N + i;
          heightField[index] = Math.max(-0.5, heightField[index] - depth * Math.exp(-d2));
        }
      }
      energy = 600;
    }

    function touch(hit) {
      if (!hit) {
        lastTouch = null;
        return;
      }
      if (lastTouch) {
        const dx = hit.x - lastTouch.x;
        const dz = hit.z - lastTouch.z;
        const length = Math.hypot(dx, dz);
        if (length > 0.01) {
          // Stamp along the path so fast strokes leave a continuous wake.
          const steps = Math.min(48, Math.max(1, Math.round(length / CELL)));
          const depth = Math.min(0.07, 0.03 + (length / steps) * 0.25);
          for (let s = 1; s <= steps; s++) {
            press(lastTouch.x + (dx * s) / steps, lastTouch.z + (dz * s) / steps, depth, 1.7);
          }
        }
      }
      lastTouch = hit;
    }

    function stepSimulation() {
      for (let j = 1; j < N - 1; j++) {
        let index = j * N + 1;
        for (let i = 1; i < N - 1; i++, index++) {
          const laplacian =
            heightField[index - 1] + heightField[index + 1] +
            heightField[index - N] + heightField[index + N] - 4 * heightField[index];
          velocity[index] = (velocity[index] + laplacian * WAVE_SPEED2) * DAMPING;
        }
      }
      for (let index = 0; index < N * N; index++) {
        heightField[index] = (heightField[index] + velocity[index]) * absorb[index];
      }
    }

    function uploadRipples() {
      const scale = 127 / (SLOPE_RANGE * 2 * CELL);
      for (let j = 1; j < N - 1; j++) {
        let index = j * N + 1;
        for (let i = 1; i < N - 1; i++, index++) {
          const gx = (heightField[index + 1] - heightField[index - 1]) * scale;
          const gz = (heightField[index + N] - heightField[index - N]) * scale;
          const p = index * 4;
          pixels[p + 1] = 128 + Math.max(-127, Math.min(127, Math.round(gx)));
          pixels[p + 2] = 128 + Math.max(-127, Math.min(127, Math.round(gz)));
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }

    const linear = [0, 0, 0];

    // The water surface for the ducks: the Gerstner waves the mesh shows, the
    // orbital motion and Stokes drift of the water, plus the ripple field.
    const RIPPLE_HEIGHT = 0.7;
    function waterAt(x, z, t, out) {
      // Undo the horizontal Gerstner displacement to find the wave origin point.
      let ox = x, oz = z;
      for (let pass = 0; pass < 2; pass++) {
        let dx = 0, dz = 0;
        for (let i = 0; i < GERSTNER; i++) {
          const wx = waveData[i * 4], wz = waveData[i * 4 + 1], k = waveData[i * 4 + 2];
          const theta = k * (wx * ox + wz * oz) - Math.sqrt(9.8 * k) * t;
          const disp = (STEEPNESS / k) * Math.cos(theta);
          dx += wx * disp; dz += wz * disp;
        }
        ox = x - dx; oz = z - dz;
      }
      let y = 0, vx = 0, vy = 0, vz = 0;
      for (let i = 0; i < GERSTNER; i++) {
        const wx = waveData[i * 4], wz = waveData[i * 4 + 1], k = waveData[i * 4 + 2], a = waveData[i * 4 + 3];
        const omega = Math.sqrt(9.8 * k);
        const theta = k * (wx * ox + wz * oz) - omega * t;
        const sin = Math.sin(theta), cos = Math.cos(theta);
        y += a * sin;
        const orbital = (STEEPNESS / k) * omega * sin + a * a * omega * k; // + Stokes drift
        vx += wx * orbital; vz += wz * orbital;
        vy -= a * omega * cos;
      }
      // Ripples from the simulation, bilinearly sampled.
      const ci = (x - ORIGIN_X) / CELL - 0.5, cj = (z - ORIGIN_Z) / CELL - 0.5;
      if (ci >= 0 && cj >= 0 && ci < N - 1 && cj < N - 1) {
        const i0 = Math.floor(ci), j0 = Math.floor(cj), fi = ci - i0, fj = cj - j0;
        const at = (field, i, j) => field[j * N + i];
        const lerp2 = field =>
          (at(field, i0, j0) * (1 - fi) + at(field, i0 + 1, j0) * fi) * (1 - fj) +
          (at(field, i0, j0 + 1) * (1 - fi) + at(field, i0 + 1, j0 + 1) * fi) * fj;
        y += lerp2(heightField) * RIPPLE_HEIGHT;
        vy += lerp2(velocity) * RIPPLE_HEIGHT / STEP;
      }
      out.y = y; out.vx = vx; out.vy = vy; out.vz = vz;
    }
    const ducks = toys ? toys.createDucks({ water: waterAt, splash: press, ...toyContext }) : null;

    function draw(time, dt, still) {
      const camera = makeCamera(2.4, 0, 0.1, 0.6, still, true);
      const sceneTime = still ? 4.0 : time;

      if (!still) {
        touch(pointer.active ? camera.hit : null);
        if (ducks) ducks.step(dt, sceneTime);
        if (energy > 0) {
          accumulator = Math.min(accumulator + dt, STEP * 3);
          while (accumulator >= STEP) {
            stepSimulation();
            accumulator -= STEP;
            energy--;
          }
          uploadRipples();
        }
      }

      for (let i = 0; i < 3; i++) linear[i] = Math.pow(background[i], 2.2);
      // The light sits upper-left at the same spot on screen for any aspect ratio.
      const sx = -0.2 * view.aspect, sy = 0.22, sz = -1;
      const sl = Math.hypot(sx, sy, sz);

      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enableVertexAttribArray(0);

      gl.useProgram(skyProgram.program);
      let u = skyProgram.uniforms;
      gl.uniform3f(u.uBg, linear[0], linear[1], linear[2]);
      gl.uniform3f(u.uSun, sx / sl, sy / sl, sz / sl);
      gl.uniform2f(u.uRes, view.width, view.height);
      gl.uniform1f(u.uFocal, FOCAL);
      gl.uniform2f(u.uYaw, camera.cy, camera.sy);
      gl.uniform2f(u.uPitch, camera.cp, camera.sp);
      gl.bindBuffer(gl.ARRAY_BUFFER, skyBuffer);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // The water writes depth so the ducks' submerged parts are hidden by it.
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.useProgram(water.program);
      u = water.uniforms;
      gl.uniform3f(u.uBg, linear[0], linear[1], linear[2]);
      gl.uniform3f(u.uSun, sx / sl, sy / sl, sz / sl);
      gl.uniform1f(u.uTime, sceneTime);
      gl.uniform1f(u.uAspect, view.aspect);
      gl.uniform1f(u.uFocal, FOCAL);
      gl.uniform1f(u.uSpread, (view.aspect / FOCAL) * 1.2 + 0.1);
      gl.uniform2f(u.uRes, view.width, view.height);
      gl.uniform3f(u.uCam, camera.x, camera.y, camera.z);
      gl.uniform2f(u.uYaw, camera.cy, camera.sy);
      gl.uniform2f(u.uPitch, camera.cp, camera.sp);
      gl.uniform4fv(u.uWave, waveData);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(u.uRipple, 0);
      gl.uniform4f(u.uRippleRect, ORIGIN_X, ORIGIN_Z, 1 / (N * CELL), 1 / (N * CELL));
      gl.uniform1f(u.uRippleSlope, SLOPE_RANGE);
      gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);

      if (ducks) ducks.draw(camera, [sx / sl, sy / sl, sz / sl], linear);
    }

    function drop(x, z) {
      if (!ducks) return;
      // Far clicks graze the horizon; keep the ducks within sight.
      const dist = Math.hypot(x, z);
      const limit = 32;
      if (dist > limit) {
        x *= limit / dist;
        z *= limit / dist;
      }
      ducks.spawn(x, z);
    }

    return { draw, drop };
  }

  // ---------------------------------------------------------------- mode switching

  const MODES = ['dots', 'ocean'];
  const STORAGE_KEY = 'scene-mode';
  let ocean = null;
  let oceanFailed = false;
  let mode = 'dots';
  let wasPlaying = false;
  let equalizerShown = false;

  function setMode(next, remember) {
    if (next === 'ocean' && !ocean && !oceanFailed) {
      try {
        ocean = createOcean();
      } catch (error) {
        console.warn('ocean disabled:', error);
        oceanFailed = true;
      }
    }
    mode = next === 'ocean' && ocean ? 'ocean' : 'dots';
    root.dataset.scene = mode;
    if (modeToggle) {
      const other = mode === 'ocean' ? '점 물결' : '바다';
      modeToggle.setAttribute('aria-label', `${other} 배경으로 전환`);
      modeToggle.title = `${other} 배경으로 전환`;
      modeToggle.hidden = oceanFailed;
    }
    if (remember) {
      try {
        localStorage.setItem(STORAGE_KEY, mode);
      } catch (error) {
        // Storage can be unavailable (private mode); the choice just won't persist.
      }
    }
  }

  // ---------------------------------------------------------------- frame loop

  let last = performance.now();
  let time = 0;
  let frame = 0;

  function draw(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const still = reducedMotion.matches;
    if (!still) time += dt;

    const ease = rate => (still ? 1 : 1 - Math.exp(-dt * rate));
    pointer.x += (pointer.tx - pointer.x) * ease(5);
    pointer.y += (pointer.ty - pointer.y) * ease(5);
    pointer.strength += ((pointer.active ? 1 : 0) - pointer.strength) * ease(3);
    for (let i = 0; i < 3; i++) {
      foreground[i] += (targetForeground[i] - foreground[i]) * ease(8);
      background[i] += (targetBackground[i] - background[i]) * ease(8);
    }

    // music.js publishes the spectrum of the music that is playing. The dots
    // become its equalizer, so starting music brings the dot field forward.
    const spectrum = window.musicSpectrum;
    const playing = Boolean(spectrum && spectrum.active) && !still;
    if (playing && !wasPlaying && mode !== 'dots') setMode('dots', false);
    wasPlaying = playing;
    const equalizer = playing && mode === 'dots';
    if (equalizer !== equalizerShown) {
      equalizerShown = equalizer;
      root.toggleAttribute('data-equalizer', equalizer);
    }

    if (mode === 'ocean') ocean.draw(time, dt, still);
    else dots.draw(time, dt, still, playing ? spectrum : null);

    // Subtle 3D tilt of the name and links toward the cursor.
    if (profile) {
      if (!still && finePointer.matches) {
        profile.style.transform =
          `perspective(900px) rotateX(${(pointer.y * 5).toFixed(3)}deg) rotateY(${(pointer.x * 7).toFixed(3)}deg)`;
      } else if (profile.style.transform) {
        profile.style.transform = '';
      }
    }
  }

  function loop(now) {
    draw(now);
    frame = reducedMotion.matches ? 0 : requestAnimationFrame(loop);
  }
  function start() {
    cancelAnimationFrame(frame);
    last = performance.now();
    frame = requestAnimationFrame(loop);
  }

  window.addEventListener('resize', () => {
    resize();
    if (reducedMotion.matches) start();
  });
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  // A click on the background drops a ball onto the dots or a duck into the sea.
  window.addEventListener('pointerdown', event => {
    onPointerMove(event);
    if (event.button !== 0 || reducedMotion.matches) return;
    const target = event.target;
    if (target instanceof Element && target.closest('a, button, input, label, .controls')) return;
    const scene = mode === 'ocean' ? ocean : dots;
    const camera = mode === 'ocean'
      ? makeCamera(2.4, 0, 0.1, 0.6, false, true)
      : makeCamera(1.9, 0.5, 0.16, 0.5, false, true);
    if (camera.hit) scene.drop(camera.hit.x, camera.hit.z);
  }, { passive: true });
  window.addEventListener('pointerup', event => {
    if (event.pointerType !== 'mouse') onPointerGone();
  });
  window.addEventListener('pointercancel', onPointerGone);
  root.addEventListener('pointerleave', onPointerGone);
  window.addEventListener('blur', onPointerGone);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(frame);
    else start();
  });
  reducedMotion.addEventListener('change', start);

  new MutationObserver(() => {
    readColors();
    if (reducedMotion.matches) start();
  }).observe(root, { attributes: true, attributeFilter: ['style'] });

  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    cancelAnimationFrame(frame);
  });

  if (modeToggle) {
    modeToggle.addEventListener('click', () => {
      setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length], true);
      if (reducedMotion.matches) start();
    });
  }

  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    // Ignore: fall back to the default mode.
  }

  resize();
  readColors();
  foreground.splice(0, 3, ...targetForeground);
  background.splice(0, 3, ...targetBackground);
  setMode(MODES.includes(stored) ? stored : 'dots', false);
  start();
})();
