// Music player: a round button that stretches into a small player for the
// tracks listed in music/tracks.json and for audio files the visitor opens.
// The spectrum of what is playing is published as `window.musicSpectrum`; the
// dot background reads it every frame and turns into a graphic equalizer.
(() => {
  const root = document.querySelector('#music');
  if (!root) return;

  const controls = root.closest('.controls');
  const toggle = root.querySelector('#music-toggle');
  const panel = root.querySelector('#music-panel');
  const title = root.querySelector('#music-title');
  const playButton = root.querySelector('#music-play');
  const nextButton = root.querySelector('#music-next');
  const fileButton = root.querySelector('#music-file');
  const fileInput = root.querySelector('#music-input');
  const status = document.querySelector('#music-status');

  // ---------------------------------------------------------------- spectrum

  // 30 bands, roughly a third of an octave each, like a 30-band graphic EQ.
  const BANDS = 30;
  const LOW_HZ = 32;
  const HIGH_HZ = 16000;
  const BAND_STEP = Math.pow(HIGH_HZ / LOW_HZ, 1 / (BANDS - 1));
  // Bass needs narrow FFT bins, treble needs a short window to stay on the beat,
  // so the two halves of the spectrum are measured with different FFT sizes.
  const SPLIT_HZ = 300;
  const LOW_FFT = 4096;
  const HIGH_FFT = 2048;

  const RANGE_DB = 40;          // level difference between an empty and a full bar
  const HEADROOM = 0.92;        // where the loudest band sits once gain has settled
  const GAIN_FLOOR_DB = -60;    // quieter material than this is not boosted further
  const GAIN_ATTACK = 0.04;     // seconds
  const GAIN_RELEASE_DB = 1.5;  // per second
  const ATTACK = 0.012;         // seconds for a bar to rise
  const RELEASE = 0.16;         // seconds for a bar to fall
  const PEAK_HOLD = 0.4;        // seconds a peak marker stays before falling
  const PEAK_GRAVITY = 2.4;

  const levels = new Float32Array(BANDS);
  const peaks = new Float32Array(BANDS);
  const peakHold = new Float32Array(BANDS);
  const peakSpeed = new Float32Array(BANDS);
  const bandDecibels = new Float32Array(BANDS);

  const audio = new Audio();
  audio.preload = 'auto';

  let analysis = null; // { context, taps, bands }
  let analysisFailed = false;
  let reference = GAIN_FLOOR_DB;

  // FFT bin k covers k ± 0.5; returns how much of each bin lies inside the band.
  function bandWeights(lowHz, highHz, hzPerBin, binCount) {
    const from = lowHz / hzPerBin;
    const to = highHz / hzPerBin;
    const first = Math.max(1, Math.floor(from + 0.5)); // bin 0 is DC
    const last = Math.min(binCount - 1, Math.floor(to + 0.5));
    const weights = [];
    for (let bin = first; bin <= last; bin++) {
      weights.push(Math.max(0, Math.min(to, bin + 0.5) - Math.max(from, bin - 0.5)));
    }
    return { first, weights };
  }

  // Routes the audio element through analysers on its way to the speakers.
  // Must first run inside a click so the browser lets the context start.
  function connectAnalysis() {
    if (analysis) {
      if (analysis.context.state !== 'running') analysis.context.resume().catch(() => {});
      return;
    }
    if (analysisFailed) return;
    let context = null;
    try {
      context = new (window.AudioContext || window.webkitAudioContext)();
      const source = context.createMediaElementSource(audio);
      source.connect(context.destination);
      const taps = [LOW_FFT, HIGH_FFT].map(size => {
        const analyser = context.createAnalyser();
        analyser.fftSize = size;
        analyser.smoothingTimeConstant = 0; // bars get their own attack / release below
        source.connect(analyser);
        return {
          analyser,
          hzPerBin: context.sampleRate / size,
          decibels: new Float32Array(analyser.frequencyBinCount),
          power: new Float32Array(analyser.frequencyBinCount),
        };
      });
      const bands = [];
      const edge = Math.sqrt(BAND_STEP);
      for (let band = 0; band < BANDS; band++) {
        const center = LOW_HZ * Math.pow(BAND_STEP, band);
        const tap = taps[center < SPLIT_HZ ? 0 : 1];
        bands.push({
          tap,
          ...bandWeights(center / edge, center * edge, tap.hzPerBin, tap.power.length),
        });
      }
      analysis = { context, taps, bands };
      if (context.state !== 'running') context.resume().catch(() => {});
    } catch (error) {
      // Without Web Audio the element still plays, just with no equalizer.
      analysisFailed = true;
      if (context) context.close().catch(() => {});
    }
  }

  // Called by the scene once per rendered frame.
  function update(dt) {
    const live = analysis;
    if (live) {
      for (const tap of live.taps) {
        tap.analyser.getFloatFrequencyData(tap.decibels);
        for (let bin = 0; bin < tap.power.length; bin++) {
          tap.power[bin] = Math.pow(10, tap.decibels[bin] / 10); // -Infinity -> 0
        }
      }
      let top = -Infinity;
      for (let band = 0; band < BANDS; band++) {
        const { tap, first, weights } = live.bands[band];
        let power = 0;
        for (let i = 0; i < weights.length; i++) power += tap.power[first + i] * weights[i];
        const decibels = 10 * Math.log10(power);
        bandDecibels[band] = decibels;
        if (decibels > top) top = decibels;
      }
      // Slow automatic gain: only the overall scale adapts to the track's
      // loudness, the shape of the spectrum is shown exactly as measured.
      if (top > reference) reference += (top - reference) * (1 - Math.exp(-dt / GAIN_ATTACK));
      else reference = Math.max(GAIN_FLOOR_DB, top, reference - GAIN_RELEASE_DB * dt);
    }

    for (let band = 0; band < BANDS; band++) {
      let target = 0;
      if (live) {
        target = HEADROOM + (bandDecibels[band] - reference) / RANGE_DB;
        target = target > 0 ? Math.min(target, 1) : 0; // also maps silence (-Infinity) to 0
      }
      const level = levels[band];
      const rate = target > level ? ATTACK : RELEASE;
      const next = level + (target - level) * (1 - Math.exp(-dt / rate));
      levels[band] = next < 0.0005 ? 0 : next;

      if (levels[band] >= peaks[band]) {
        peaks[band] = levels[band];
        peakHold[band] = PEAK_HOLD;
        peakSpeed[band] = 0;
      } else if (peakHold[band] > 0) {
        peakHold[band] -= dt;
      } else {
        peakSpeed[band] += PEAK_GRAVITY * dt;
        peaks[band] = Math.max(levels[band], peaks[band] - peakSpeed[band] * dt);
      }
    }
  }

  const spectrum = { bands: BANDS, levels, peaks, active: false, update };
  window.musicSpectrum = spectrum;

  // ---------------------------------------------------------------- playlist

  const MANIFEST = 'music/tracks.json';
  const EMPTY_TITLE = '음원 파일을 열어 보세요';

  const playlist = []; // { title, url }
  let index = 0;       // track shown in the player
  let loaded = -1;     // track the audio element currently holds
  let wanted = false;  // the visitor asked for playback
  let statusTimer = 0;

  function say(text, duration) {
    if (!status) return;
    clearTimeout(statusTimer);
    if (text) status.textContent = text;
    status.toggleAttribute('data-visible', Boolean(text));
    if (text && duration) statusTimer = setTimeout(say, duration, '');
  }

  function titleFromName(name) {
    const base = name.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    try {
      return decodeURIComponent(base);
    } catch (error) {
      return base;
    }
  }

  // Manifest entries are "file.mp3" or { "title": "…", "file": "file.mp3" },
  // with paths relative to the music/ folder.
  function readManifest(list, base) {
    const tracks = [];
    if (!Array.isArray(list)) return tracks;
    for (const entry of list) {
      const file = typeof entry === 'string' ? entry : entry && entry.file;
      if (typeof file !== 'string' || !file) continue;
      let url;
      try {
        url = new URL(file, base).href;
      } catch (error) {
        continue;
      }
      const name = entry && typeof entry.title === 'string' && entry.title.trim();
      tracks.push({ title: name || titleFromName(file), url });
    }
    return tracks;
  }

  function sync() {
    const track = playlist[index];
    title.textContent = track ? track.title : EMPTY_TITLE;
    title.title = track ? track.title : '';
    root.toggleAttribute('data-empty', !track);
    root.toggleAttribute('data-playing', wanted);
    playButton.setAttribute('aria-label', wanted ? '일시정지' : '재생');
    playButton.title = wanted ? '일시정지' : '재생';
    nextButton.hidden = playlist.length < 2;
    spectrum.active = wanted;
  }

  function select(next) {
    index = next;
    sync();
  }

  function play() {
    const track = playlist[index];
    if (!track) return;
    connectAnalysis();
    if (loaded !== index) {
      loaded = index;
      // Other origins must opt in via CORS, or the analyser would silence them.
      const external = !track.url.startsWith('blob:') && new URL(track.url).origin !== location.origin;
      if (external) audio.crossOrigin = 'anonymous';
      else audio.removeAttribute('crossorigin');
      audio.src = track.url;
    }
    wanted = true;
    sync();
    say('');
    audio.play().catch(error => {
      // AbortError only means another track or a pause took over.
      if (error && error.name === 'AbortError') return;
      wanted = false;
      sync();
    });
  }

  function pause() {
    wanted = false;
    audio.pause();
    sync();
  }

  function next() {
    if (playlist.length < 2) return;
    select((index + 1) % playlist.length);
    if (wanted) play();
  }

  function addFiles(files) {
    const first = playlist.length;
    for (const file of files) {
      playlist.push({ title: titleFromName(file.name), url: URL.createObjectURL(file) });
    }
    if (playlist.length === first) return;
    select(first);
    play();
  }

  audio.addEventListener('ended', () => {
    if (index + 1 < playlist.length) {
      select(index + 1);
      play();
    } else {
      wanted = false;
      select(0);
    }
  });

  // Keep in step with media keys and other controls outside the page.
  audio.addEventListener('play', () => {
    if (wanted) return;
    wanted = true;
    sync();
  });
  audio.addEventListener('pause', () => {
    if (!wanted || audio.ended) return;
    wanted = false;
    sync();
  });

  audio.addEventListener('error', () => {
    if (loaded < 0) return;
    loaded = -1;
    wanted = false;
    sync();
    say('이 음원은 재생할 수 없어요.', 5000);
  });

  // ---------------------------------------------------------------- interface

  let open = false;

  function setOpen(next) {
    open = next;
    root.toggleAttribute('data-open', open);
    if (controls) controls.classList.toggle('music-open', open);
    panel.inert = !open;
    const label = open ? '음악 플레이어 닫기' : '음악 플레이어 열기';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }

  toggle.addEventListener('click', () => {
    connectAnalysis(); // the first click is the gesture browsers want for audio
    setOpen(!open);
  });

  playButton.addEventListener('click', () => {
    if (!playlist.length) fileInput.click();
    else if (wanted) pause();
    else play();
  });

  nextButton.addEventListener('click', next);

  fileButton.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    addFiles(Array.from(fileInput.files || []));
    fileInput.value = ''; // lets the same file be picked again
  });

  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !open) return;
    setOpen(false);
    toggle.focus({ preventScroll: true });
  });

  document.addEventListener('pointerdown', event => {
    if (open && !root.contains(event.target)) setOpen(false);
  });

  setOpen(false);
  sync();

  fetch(MANIFEST)
    .then(response => (response.ok ? response.json() : []))
    .then(list => {
      const tracks = readManifest(list, new URL(MANIFEST, document.baseURI));
      if (!tracks.length) return;
      // Hosted tracks come first, ahead of anything the visitor already opened.
      playlist.unshift(...tracks);
      if (loaded >= 0) loaded += tracks.length;
      index = playlist.length > tracks.length ? index + tracks.length : 0;
      sync();
    })
    .catch(() => {
      // No manifest: the player still works with files the visitor opens.
    });
})();
