const $ = (selector) => document.querySelector(selector);
const clamp01 = (value) => Math.min(1, Math.max(0, value));
const pct = (value) => `${Math.round(value * 100)}%`;
const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const library = { music: [], ambience: [], sfx: [], unassigned: [] };
const audio = {
  musicA: Object.assign(new Audio(), { loop: true, preload: 'auto' }),
  musicB: Object.assign(new Audio(), { loop: true, preload: 'auto' }),
};
const vol = { master: 0.8, ambience: 0.6, music: 0.7, sfx: 0.8 };
const musicGain = { musicA: 0, musicB: 0 };
const musicRepeat = { musicA: true, musicB: true };
const musicFadeTokens = new Map();
const itemFadeTokens = new Map();
const itemPlayers = new Map();
const storedRecords = new Map();
const waveformCache = new Map();
let waveformAudioContext = null;
const marqueeObserver = 'ResizeObserver' in window
  ? new ResizeObserver((entries) => {
    for (const { target } of entries) updateMarquee(target);
  })
  : null;
const DB_NAME = 'pocket-bard-clone';
const STORE = 'files';
const PROFILE_KEY = 'pocket-bard-profiles-v1';
const LEGACY_STATE_KEY = 'pocket-bard-state-v1';
const LIBRARY_CATEGORIES = ['music', 'ambience', 'sfx', 'unassigned'];
let db = null;
let profiles = [];
let activeProfile = null;
let crossfade = 0;
let crossfadeFrame = 0;
let pendingCategory = 'unassigned';
const els = {
  masterVol: $('#masterVol'), masterVolOut: $('#masterVolOut'),
  profileSelect: $('#profileSelect'), createProfile: $('#createProfile'),
  ambienceGrid: $('#ambienceGrid'), ambienceVol: $('#ambienceVol'), ambienceVolOut: $('#ambienceVolOut'),
  musicASelect: $('#musicASelect'), musicAWaveform: $('#musicAWaveform'), musicATime: $('#musicATime'),
  musicATitle: $('#musicATitle'),
  musicAToggle: $('#musicAToggle'), musicAStop: $('#musicAStop'), musicARestart: $('#musicARestart'), musicARepeat: $('#musicARepeat'),
  musicBSelect: $('#musicBSelect'), musicBWaveform: $('#musicBWaveform'), musicBTime: $('#musicBTime'),
  musicBTitle: $('#musicBTitle'),
  musicBToggle: $('#musicBToggle'), musicBStop: $('#musicBStop'), musicBRestart: $('#musicBRestart'), musicBRepeat: $('#musicBRepeat'),
  crossfade: $('#crossfade'), musicVol: $('#musicVol'), musicVolOut: $('#musicVolOut'),
  sfxVol: $('#sfxVol'), sfxVolOut: $('#sfxVolOut'), sfxGrid: $('#sfxGrid'),
  libraryList: $('#libraryList'), fileInput: $('#fileInput'), panicBtn: $('#panicBtn'),
  fadeToA: $('#fadeToA'), fadeToB: $('#fadeToB'),
};
const channels = {
  musicA: { el: audio.musicA, select: els.musicASelect, waveform: els.musicAWaveform, time: els.musicATime, toggle: els.musicAToggle, stop: els.musicAStop, restart: els.musicARestart, repeat: els.musicARepeat, peaks: null, overlap: null, dragging: false, suppressRepeat: false },
  musicB: { el: audio.musicB, select: els.musicBSelect, waveform: els.musicBWaveform, time: els.musicBTime, toggle: els.musicBToggle, stop: els.musicBStop, restart: els.musicBRestart, repeat: els.musicBRepeat, peaks: null, overlap: null, dragging: false, suppressRepeat: false },
};

function openDB() {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function dbPut(record) {
  return new Promise((resolve) => {
    if (!db) return resolve(false);
    try {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(record);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

function dbGetAll() {
  return new Promise((resolve) => {
    if (!db) return resolve([]);
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
}

function dbDelete(id) {
  return new Promise((resolve) => {
    if (!db) return resolve();
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).delete(id);
    transaction.oncomplete = transaction.onerror = () => resolve();
  });
}

function applyVolumes() {
  for (const [key, channel] of Object.entries(channels)) {
    const channelVolume = vol.master * vol.music * (key === 'musicA' ? 1 - crossfade : crossfade) * musicGain[key];
    if (channel.overlap) {
      channel.el.volume = clamp01(channelVolume * channel.overlap.oldGain);
      channel.overlap.next.volume = clamp01(channelVolume * channel.overlap.nextGain);
    } else {
      channel.el.volume = clamp01(channelVolume);
    }
  }
  for (const player of itemPlayers.values()) {
    const baseVolume = vol.master * vol[player.mode] * (player.item.volume ?? 1);
    player.audio.volume = clamp01(baseVolume * (player.gain ?? 1) * (player.overlap?.oldGain ?? 1));
    if (player.overlap) player.overlap.next.volume = clamp01(baseVolume * player.gain * player.overlap.nextGain);
  }
  updateAudioAtmosphere();
}

function updateAudioAtmosphere() {
  let activeVolume = 0;
  for (const channel of Object.values(channels)) {
    if (!channel.el.paused) activeVolume += channel.el.volume;
    if (channel.overlap && !channel.overlap.next.paused) activeVolume += channel.overlap.next.volume;
  }
  for (const player of itemPlayers.values()) {
    if (!player.audio.paused) activeVolume += player.audio.volume;
    if (player.overlap && !player.overlap.next.paused) activeVolume += player.overlap.next.volume;
  }
  const glow = activeVolume > 0 ? Math.min(0.22, 0.035 + Math.sqrt(activeVolume) * 0.09) : 0;
  document.documentElement.style.setProperty('--audio-glow', glow.toFixed(3));
}

function updateMarquee(container) {
  const track = container.querySelector('.marquee-track');
  const text = track?.firstElementChild;
  if (!track || !text) return;
  const overflowing = text.scrollWidth > container.clientWidth + 1;
  container.classList.toggle('is-marquee', overflowing);
  if (overflowing) {
    if (track.children.length === 1) {
      const duplicate = text.cloneNode(true);
      duplicate.setAttribute('aria-hidden', 'true');
      track.appendChild(duplicate);
    }
    track.style.setProperty('--marquee-shift', `-${text.scrollWidth + 28}px`);
  } else {
    if (track.children.length > 1) track.lastElementChild.remove();
    track.style.removeProperty('--marquee-shift');
  }
}

function setMarqueeText(container, text) {
  const existing = container.querySelector('.marquee-track > span');
  if (existing?.textContent === text) return;
  const track = document.createElement('span');
  track.className = 'marquee-track';
  const label = document.createElement('span');
  label.textContent = text;
  track.appendChild(label);
  container.replaceChildren(track);
  marqueeObserver?.observe(container);
  requestAnimationFrame(() => updateMarquee(container));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const wholeSeconds = Math.floor(seconds);
  return `${String(Math.floor(wholeSeconds / 60)).padStart(2, '0')}:${String(wholeSeconds % 60).padStart(2, '0')}`;
}

function drawDeckWaveform(key) {
  const channel = channels[key];
  const canvas = channel.waveform.querySelector('canvas');
  const context = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.clearRect(0, 0, width, height);
  const peaks = channel.peaks;
  if (!peaks?.length) {
    context.fillStyle = '#393d49';
    context.fillRect(0, Math.floor(height / 2), width, Math.max(1, ratio));
    return;
  }
  const progress = channel.el.duration ? channel.el.currentTime / channel.el.duration : 0;
  const barStep = Math.max(2, Math.floor(width / peaks.length));
  const barWidth = Math.max(1, Math.floor(barStep * 0.58));
  for (let index = 0; index < peaks.length; index += 1) {
    const x = index * width / peaks.length;
    const barHeight = Math.max(ratio, peaks[index] * height * 0.9);
    context.fillStyle = index / peaks.length <= progress ? '#c4b5fd' : '#555969';
    context.fillRect(x, (height - barHeight) / 2, barWidth, barHeight);
  }
}

function updateDeck(key) {
  const channel = channels[key];
  const playing = !!channel.el.src && (!channel.el.paused ||
    !!(channel.overlap && !channel.overlap.next.paused));
  const deck = channel.waveform.closest('.deck');
  deck.classList.toggle('is-playing', playing);
  const item = library.music.find((entry) => entry.id === channel.select.value);
  const title = key === 'musicA' ? els.musicATitle : els.musicBTitle;
  setMarqueeText(title, item?.name || '');
  channel.toggle.textContent = playing ? '⏸ Pausar' : '▶ Reproduzir';
  channel.toggle.title = playing ? 'Pausar faixa' : 'Reproduzir ou continuar faixa';
  channel.toggle.disabled = !channel.el.src;
  channel.stop.disabled = !channel.el.src;
  channel.restart.disabled = !channel.el.src;
  channel.waveform.setAttribute('aria-label', `${key === 'musicA' ? 'Deck A' : 'Deck B'}: ${playing ? 'pausar' : 'iniciar'} ou navegar pela waveform`);
  const duration = channel.el.duration;
  channel.time.textContent = `${formatTime(channel.el.currentTime)} / ${formatTime(duration)}`;
  drawDeckWaveform(key);
  maybeCrossfadeMusic(key);
  updateAudioAtmosphere();
}

function fadeMusic(key, target, duration = 850, onComplete) {
  const token = {};
  const start = musicGain[key];
  const startedAt = performance.now();
  musicFadeTokens.set(key, token);
  function step(now) {
    if (musicFadeTokens.get(key) !== token) return;
    const progress = Math.min(1, (now - startedAt) / duration);
    musicGain[key] = start + (target - start) * progress;
    applyVolumes();
    if (progress < 1) requestAnimationFrame(step);
    else {
      musicFadeTokens.delete(key);
      onComplete?.();
    }
  }
  requestAnimationFrame(step);
}

function finishMusicOverlap(key) {
  const channel = channels[key];
  if (!channel.overlap) return;
  const previous = channel.el;
  channel.el = channel.overlap.next;
  audio[key] = channel.el;
  channel.overlap = null;
  previous.pause();
  previous.removeAttribute('src');
  previous.load();
}

function maybeCrossfadeMusic(key) {
  const channel = channels[key];
  const current = channel.el;
  if (!musicRepeat[key] || channel.suppressRepeat || !current.src || current.paused || channel.overlap ||
      !Number.isFinite(current.duration) || !current.duration) return;
  const fadeDuration = Math.min(1.5, Math.max(0.12, current.duration * 0.25));
  if (current.duration - current.currentTime > fadeDuration) return;
  const item = library.music.find((entry) => entry.id === channel.select.value);
  if (!item) return;

  const next = new Audio(item.url);
  next.preload = 'auto';
  next.loop = false;
  next.volume = 0;
  channel.overlap = { next, oldGain: 1, nextGain: 0 };
  attachDeckAudioEvents(key, next);
  next.play().then(() => {
    const overlap = channel.overlap;
    if (!overlap || overlap.next !== next) return;
    const startedAt = performance.now();
    const animate = (now) => {
      if (channel.overlap !== overlap) return;
      const progress = Math.min(1, (now - startedAt) / (fadeDuration * 1000));
      overlap.oldGain = 1 - progress;
      overlap.nextGain = progress;
      applyVolumes();
      if (progress < 1) requestAnimationFrame(animate);
      else {
        finishMusicOverlap(key);
        updateDeck(key);
      }
    };
    requestAnimationFrame(animate);
  }).catch((error) => {
    channel.overlap = null;
    console.error(`Não foi possível preparar a repetição do ${key === 'musicA' ? 'Deck A' : 'Deck B'}.`, error);
  });
  applyVolumes();
}

function startMusic(key) {
  const channel = channels[key];
  if (!channel.el.src) return;
  channel.suppressRepeat = false;
  if (channel.el.paused) musicGain[key] = 0;
  applyVolumes();
  channel.el.play().then(() => {
    updateDeck(key);
    fadeMusic(key, 1);
  }).catch((error) => {
    console.error(`Não foi possível reproduzir a faixa do ${key === 'musicA' ? 'Deck A' : 'Deck B'}.`, error);
    updateDeck(key);
  });
}

function stopMusic(key) {
  const channel = channels[key];
  if (!channel.el.src) return;
  if (channel.el.paused && !channel.overlap) {
    channel.el.currentTime = 0;
    musicGain[key] = 0;
    applyVolumes();
    updateDeck(key);
    return;
  }
  channel.suppressRepeat = true;
  fadeMusic(key, 0, 550, () => {
    finishMusicOverlap(key);
    channel.el.pause();
    channel.el.currentTime = 0;
    updateDeck(key);
  });
}

function toggleMusic(key) {
  const channel = channels[key];
  if (!channel.el.src) return;
  if (channel.el.paused && (!channel.overlap || channel.overlap.next.paused)) startMusic(key);
  else {
    channel.suppressRepeat = true;
    fadeMusic(key, 0, 450, () => {
      finishMusicOverlap(key);
      channel.el.pause();
      updateDeck(key);
    });
  }
}

async function setSource(key, id) {
  const channel = channels[key];
  const item = library.music.find((entry) => entry.id === id);
  channel.suppressRepeat = true;
  if (channel.el.src && !channel.el.paused) {
    await new Promise((resolve) => fadeMusic(key, 0, 450, resolve));
    finishMusicOverlap(key);
  }
  musicFadeTokens.delete(key);
  if (channel.overlap) {
    channel.overlap.next.pause();
    channel.overlap = null;
  }
  musicGain[key] = 0;
  if (!item) {
    channel.el.pause();
    channel.el.removeAttribute('src');
    channel.el.load();
    channel.peaks = null;
    channel.el.loop = false;
    updateDeck(key);
    return;
  }
  channel.el.src = item.url;
  channel.el.loop = false;
  channel.el.currentTime = 0;
  channel.peaks = waveformCache.get(item.id) || null;
  updateDeck(key);
  applyVolumes();
  createWaveform(item, key);
}

async function createWaveform(item, key) {
  const channel = channels[key];
  try {
    if (waveformCache.has(item.id)) {
      channel.peaks = waveformCache.get(item.id);
      drawDeckWaveform(key);
      return;
    }
    const record = storedRecords.get(item.id);
    if (!record?.blob) throw new Error('O arquivo de áudio não está disponível para análise.');
    waveformAudioContext ||= new AudioContext();
    const decoded = await waveformAudioContext.decodeAudioData(await record.blob.arrayBuffer());
    const samples = decoded.getChannelData(0);
    const bucketCount = 180;
    const peaks = Array.from({ length: bucketCount }, (_, bucket) => {
      const start = Math.floor(bucket * samples.length / bucketCount);
      const end = Math.max(start + 1, Math.floor((bucket + 1) * samples.length / bucketCount));
      let peak = 0;
      for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
      return peak;
    });
    waveformCache.set(item.id, peaks);
    if (channel.select.value === item.id) {
      channel.peaks = peaks;
      channel.waveform.removeAttribute('title');
      drawDeckWaveform(key);
    }
  } catch (error) {
    if (channel.select.value === item.id) {
      channel.waveform.title = 'Não foi possível gerar a waveform deste formato de áudio.';
    }
    console.warn(`Waveform indisponível para "${item.name}".`, error);
  }
}

function seekMusic(key, position) {
  const channel = channels[key];
  if (!channel.el.src || !Number.isFinite(channel.el.duration)) return;
  channel.el.currentTime = clamp01(position) * channel.el.duration;
  updateDeck(key);
}

function bindDeckControls(key) {
  const channel = channels[key];
  const waveform = channel.waveform;
  const seekFromPointer = (event) => {
    if (!channel.el.src || !Number.isFinite(channel.el.duration)) return;
    const bounds = waveform.getBoundingClientRect();
    seekMusic(key, (event.clientX - bounds.left) / bounds.width);
  };
  waveform.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !channel.el.src) return;
    channel.dragging = true;
    event.preventDefault();
    waveform.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  });
  waveform.addEventListener('pointermove', (event) => {
    if (channel.dragging) seekFromPointer(event);
  });
  const endSeek = (event) => {
    if (!channel.dragging) return;
    seekFromPointer(event);
    channel.dragging = false;
  };
  waveform.addEventListener('pointerup', endSeek);
  waveform.addEventListener('pointercancel', endSeek);
  waveform.addEventListener('click', seekFromPointer);
  waveform.addEventListener('keydown', (event) => {
    if (!channel.el.src) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      toggleMusic(key);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const step = event.shiftKey ? 15 : 5;
      const next = channel.el.currentTime + (event.key === 'ArrowRight' ? step : -step);
      seekMusic(key, channel.el.duration ? next / channel.el.duration : 0);
    }
  });
  channel.stop.addEventListener('click', () => stopMusic(key));
  channel.toggle.addEventListener('click', () => toggleMusic(key));
  channel.restart.addEventListener('click', () => {
    if (!channel.el.src) return;
    if (channel.overlap && channel.el.paused) finishMusicOverlap(key);
    if (channel.el.paused) {
      channel.el.currentTime = 0;
      startMusic(key);
    } else {
      channel.suppressRepeat = true;
      fadeMusic(key, 0, 350, () => {
        finishMusicOverlap(key);
        channel.el.currentTime = 0;
        startMusic(key);
      });
    }
  });
  channel.repeat.addEventListener('change', () => {
    musicRepeat[key] = channel.repeat.checked;
    channel.el.loop = false;
    saveState();
  });
  attachDeckAudioEvents(key, channel.el);
}

function attachDeckAudioEvents(key, element) {
  for (const eventName of ['timeupdate', 'durationchange', 'loadedmetadata', 'play', 'pause', 'ended']) {
    element.addEventListener(eventName, () => updateDeck(key));
  }
}

bindDeckControls('musicA');
bindDeckControls('musicB');
window.addEventListener('resize', () => {
  drawDeckWaveform('musicA');
  drawDeckWaveform('musicB');
});

function fadeTo(target, duration = 2000) {
  cancelAnimationFrame(crossfadeFrame);
  const start = crossfade;
  const startedAt = performance.now();
  function step(now) {
    const progress = Math.min(1, (now - startedAt) / duration);
    crossfade = start + (target - start) * progress;
    els.crossfade.value = crossfade;
    applyVolumes();
    if (progress < 1) crossfadeFrame = requestAnimationFrame(step);
    else saveState();
  }
  crossfadeFrame = requestAnimationFrame(step);
}

function updateItemButtons(id, mode, playing) {
  document.querySelectorAll('[data-item-id]').forEach((button) => {
    if (button.dataset.itemId !== id || button.dataset.playMode !== mode) return;
    button.classList.toggle('playing', playing);
    button.querySelector('.audio-tile-icon').textContent = playing ? '⏸' : '▶';
    const card = button.closest('.audio-item');
    const isPlaying = [...itemPlayers.values()].some((player) =>
      player.item.id === id && (!player.audio.paused || (player.overlap && !player.overlap.next.paused))
    );
    card?.classList.toggle('is-playing', isPlaying);
    const status = card?.querySelector('.audio-state');
    if (status) status.hidden = !isPlaying;
  });
}

function playItem(item, mode) {
  const key = `${item.id}:${mode}`;
  let player = itemPlayers.get(key);
  if (!player) {
    const element = new Audio(item.url);
    element.preload = 'auto';
    player = { audio: element, mode, item, gain: 0, overlap: null };
    itemPlayers.set(key, player);
    attachItemAudioEvents(player, element);
  }
  if (player.audio.paused && (!player.overlap || player.overlap.next.paused)) {
    player.suppressRepeat = false;
    if (Number.isFinite(player.audio.duration) && player.audio.currentTime >= player.audio.duration) player.audio.currentTime = 0;
    player.audio.loop = false;
    applyVolumes();
    player.audio.play().then(() => fadeItem(player, 1)).catch((error) => {
      console.error(`Não foi possível reproduzir "${item.name}".`, error);
    });
  } else {
    player.suppressRepeat = true;
    fadeItem(player, 0, 450, () => {
      finishItemOverlap(player);
      player.audio.pause();
    });
  }
}

function attachItemAudioEvents(player, element) {
  const update = () => {
    updateItemButtons(player.item.id, player.mode, !player.audio.paused ||
      !!(player.overlap && !player.overlap.next.paused));
    updateAudioAtmosphere();
  };
  element.addEventListener('play', update);
  element.addEventListener('pause', update);
  element.addEventListener('ended', update);
  element.addEventListener('timeupdate', () => maybeCrossfadeItem(player));
}

function fadeItem(player, target, duration = 500, onComplete) {
  const token = {};
  const start = player.gain ?? 0;
  const startedAt = performance.now();
  itemFadeTokens.set(player, token);
  const step = (now) => {
    if (itemFadeTokens.get(player) !== token) return;
    const progress = Math.min(1, (now - startedAt) / duration);
    player.gain = start + (target - start) * progress;
    applyVolumes();
    if (progress < 1) requestAnimationFrame(step);
    else {
      itemFadeTokens.delete(player);
      onComplete?.();
    }
  };
  requestAnimationFrame(step);
}

function finishItemOverlap(player) {
  if (!player.overlap) return;
  const previous = player.audio;
  player.audio = player.overlap.next;
  player.overlap = null;
  previous.pause();
  previous.removeAttribute('src');
  previous.load();
}

function maybeCrossfadeItem(player) {
  const current = player.audio;
  if (!player.item.repeat || player.suppressRepeat || current.paused || player.overlap ||
      !Number.isFinite(current.duration) || !current.duration) return;
  const fadeDuration = Math.min(1.25, Math.max(0.12, current.duration * 0.25));
  if (current.duration - current.currentTime > fadeDuration) return;

  const next = new Audio(player.item.url);
  next.preload = 'auto';
  next.loop = false;
  next.volume = 0;
  player.overlap = { next, oldGain: 1, nextGain: 0 };
  attachItemAudioEvents(player, next);
  next.play().then(() => {
    const overlap = player.overlap;
    if (!overlap || overlap.next !== next) return;
    const startedAt = performance.now();
    const animate = (now) => {
      if (player.overlap !== overlap) return;
      const progress = Math.min(1, (now - startedAt) / (fadeDuration * 1000));
      overlap.oldGain = 1 - progress;
      overlap.nextGain = progress;
      applyVolumes();
      if (progress < 1) requestAnimationFrame(animate);
      else finishItemOverlap(player);
    };
    requestAnimationFrame(animate);
  }).catch((error) => {
    player.overlap = null;
    console.error(`Não foi possível preparar a repetição de "${player.item.name}".`, error);
  });
  applyVolumes();
}

function stopItemWithFade(player, reset = true) {
  return new Promise((resolve) => {
    player.suppressRepeat = true;
    if (player.audio.paused && (!player.overlap || player.overlap.next.paused)) {
      finishItemOverlap(player);
      if (reset) player.audio.currentTime = 0;
      resolve();
      return;
    }
    fadeItem(player, 0, 450, () => {
      finishItemOverlap(player);
      player.audio.pause();
      if (reset) player.audio.currentTime = 0;
      resolve();
    });
  });
}

function itemVolumeControl(item) {
  const label = document.createElement('label');
  label.className = 'item-volume';
  const text = document.createElement('span');
  text.textContent = 'Volume';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '1';
  input.step = '0.01';
  input.value = item.volume ?? 1;
  input.setAttribute('aria-label', `Volume de ${item.name}`);
  const output = document.createElement('output');
  output.textContent = pct(item.volume ?? 1);
  input.addEventListener('input', () => {
    item.volume = parseFloat(input.value);
    output.textContent = pct(item.volume);
    applyVolumes();
    saveState();
  });
  makePercentEditable(output, () => item.volume ?? 1, (value) => {
    item.volume = value;
    input.value = value;
    applyVolumes();
    saveState();
  });
  label.append(text, input, output);
  return label;
}

function makePercentEditable(output, getValue, setValue) {
  output.classList.add('editable-percent');
  output.tabIndex = 0;
  output.setAttribute('role', 'button');
  output.title = 'Clique para digitar o volume';
  const edit = () => {
    if (output.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = String(Math.round(getValue() * 100));
    input.setAttribute('aria-label', 'Volume em porcentagem');
    input.addEventListener('click', (event) => event.stopPropagation());
    output.replaceChildren(input);
    const finish = (commit) => {
      if (!input.isConnected) return;
      const value = Number(input.value);
      if (commit && Number.isFinite(value) && input.value.trim() !== '') {
        setValue(clamp01(value / 100));
      }
      output.textContent = pct(getValue());
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true), { once: true });
    input.focus();
    input.select();
  };
  output.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    edit();
  });
  output.addEventListener('keydown', (event) => {
    if (event.target !== output) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      edit();
    }
  });
}

function repeatControl(item) {
  const label = document.createElement('label');
  label.className = 'repeat-control';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = item.repeat;
  checkbox.setAttribute('aria-label', `Repetir ${item.name}`);
  checkbox.addEventListener('change', () => {
    item.repeat = checkbox.checked;
    saveState();
  });
  const text = document.createElement('span');
  text.textContent = 'Repetir';
  label.append(checkbox, text);
  return label;
}

function renderAudioGrid(grid, items, mode) {
  grid.querySelectorAll('.marquee').forEach((element) => marqueeObserver?.unobserve(element));
  grid.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = mode === 'ambience' ? 'Nenhuma ambientação neste perfil.' : 'Nenhum efeito neste perfil.';
    grid.appendChild(empty);
  }
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'audio-item';
    const button = document.createElement('button');
    button.className = `audio-tile-btn ${mode}-btn`;
    const icon = document.createElement('span');
    icon.className = 'audio-tile-icon';
    icon.textContent = '▶';
    const title = document.createElement('span');
    title.className = 'audio-tile-label marquee';
    setMarqueeText(title, item.name.replace(/\.[^.]+$/, ''));
    button.append(icon, title);
    button.dataset.itemName = item.name.replace(/\.[^.]+$/, '');
    button.dataset.itemId = item.id;
    button.dataset.playMode = mode;
    button.title = item.name;
    button.addEventListener('click', () => playItem(item, mode));
    const status = document.createElement('span');
    status.className = 'audio-state';
    status.textContent = 'Tocando';
    status.hidden = true;
    const remove = document.createElement('button');
    remove.className = 'remove-audio';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Remover ${item.name} deste ambiente`;
    remove.setAttribute('aria-label', `Remover ${item.name} deste ambiente`);
    remove.addEventListener('click', () => moveAudio(item, 'unassigned'));
    card.append(button, status, itemVolumeControl(item), repeatControl(item), remove);
    grid.appendChild(card);
  }
  const addCard = document.createElement('button');
  addCard.className = 'audio-add-card';
  addCard.type = 'button';
  addCard.textContent = mode === 'ambience' ? '+ Adicionar ambientação' : '+ Adicionar efeito';
  addCard.addEventListener('click', () => chooseAudioFiles(mode));
  grid.appendChild(addCard);
}

function fillSelect(select, items) {
  const previous = select.value;
  select.innerHTML = '<option value="">— selecionar —</option>';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    select.appendChild(option);
  }
  if (items.some((item) => item.id === previous)) select.value = previous;
}

const categoryNames = { music: 'música', ambience: 'ambientação', sfx: 'efeito', unassigned: 'biblioteca' };
function renderLibrary() {
  els.libraryList.querySelectorAll('.marquee').forEach((element) => marqueeObserver?.unobserve(element));
  els.libraryList.innerHTML = '';
  const items = [
    ...library.music.map((item) => ({ item, category: 'music' })),
    ...library.ambience.map((item) => ({ item, category: 'ambience' })),
    ...library.sfx.map((item) => ({ item, category: 'sfx' })),
    ...library.unassigned.map((item) => ({ item, category: 'unassigned' })),
  ];
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nenhum áudio neste perfil.';
    els.libraryList.appendChild(empty);
    return;
  }
  for (const entry of items) {
    const { item, category: categoryKey } = entry;
    const row = document.createElement('div');
    row.className = 'lib-item';
    const left = document.createElement('div');
    left.className = 'lib-name';
    const name = document.createElement('span');
    name.className = 'name marquee';
    setMarqueeText(name, item.name);
    name.title = item.originalName || item.name;
    const category = document.createElement('span');
    category.className = 'cat';
    category.textContent = categoryNames[categoryKey];
    left.append(name, category);
    const actions = document.createElement('div');
    actions.className = 'lib-actions';
    const destination = document.createElement('select');
    destination.className = 'picker destination-picker';
    destination.setAttribute('aria-label', `Ambiente de ${item.name}`);
    for (const [value, label] of Object.entries({
      unassigned: 'Biblioteca',
      music: 'Música',
      ambience: 'Ambientação',
      sfx: 'Efeito',
    })) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      destination.appendChild(option);
    }
    destination.value = categoryKey;
    destination.addEventListener('change', () => moveAudio(item, destination.value, destination));
    const rename = document.createElement('button');
    rename.className = 'ghost';
    rename.textContent = 'Renomear';
    rename.title = 'Definir um alias sem alterar o arquivo';
    rename.addEventListener('click', () => renameFile(item, row, name));
    const remove = document.createElement('button');
    remove.className = 'danger ghost';
    remove.textContent = 'Remover';
    remove.addEventListener('click', () => removeFile(item.id, categoryKey));
    actions.append(destination, rename, remove);
    row.append(left, actions);
    els.libraryList.appendChild(row);
  }
}

function refreshUI() {
  fillSelect(els.musicASelect, library.music);
  fillSelect(els.musicBSelect, library.music);
  renderAudioGrid(els.ambienceGrid, library.ambience, 'ambience');
  renderAudioGrid(els.sfxGrid, library.sfx, 'sfx');
  renderLibrary();
}

function allLibraryItems() {
  return [...library.music, ...library.ambience, ...library.sfx, ...library.unassigned];
}

function aliasIsAvailable(alias, item) {
  const normalized = alias.trim().toLocaleLowerCase();
  return !normalized || !allLibraryItems().some((other) =>
    other.id !== item?.id && (other.alias || '').trim().toLocaleLowerCase() === normalized
  );
}

function renderProfiles() {
  els.profileSelect.innerHTML = '';
  for (const profile of profiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.name;
    els.profileSelect.appendChild(option);
  }
  if (activeProfile) els.profileSelect.value = activeProfile.id;
}

function saveProfiles() {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ profiles, activeId: activeProfile?.id }));
  } catch {}
}

function stateSnapshot() {
  const items = allLibraryItems();
  return {
    vol: { ...vol },
    musicRepeat: { ...musicRepeat },
    crossfade,
    repeat: Object.fromEntries(items.map((item) => [item.id, item.repeat])),
    itemVolumes: Object.fromEntries(items.map((item) => [item.id, item.volume ?? 1])),
    sel: { musicA: els.musicASelect.value, musicB: els.musicBSelect.value },
  };
}

function saveState() {
  if (!activeProfile) return;
  activeProfile.state = stateSnapshot();
  saveProfiles();
}

function restoreState(state = activeProfile?.state || {}) {
  Object.assign(vol, { master: 0.8, ambience: 0.6, music: 0.7, sfx: 0.8 }, state.vol || {});
  Object.assign(musicRepeat, { musicA: true, musicB: true }, state.musicRepeat || {});
  crossfade = typeof state.crossfade === 'number' ? state.crossfade : 0;
  for (const item of allLibraryItems()) {
    item.repeat = state.repeat?.[item.id] ?? item.category === 'ambience';
    item.volume = state.itemVolumes?.[item.id] ?? item.volume ?? 1;
  }
  els.masterVol.value = vol.master;
  els.masterVolOut.textContent = pct(vol.master);
  els.ambienceVol.value = vol.ambience;
  els.ambienceVolOut.textContent = pct(vol.ambience);
  els.musicVol.value = vol.music;
  els.musicVolOut.textContent = pct(vol.music);
  els.sfxVol.value = vol.sfx;
  els.sfxVolOut.textContent = pct(vol.sfx);
  els.crossfade.value = crossfade;
  for (const [key, channel] of Object.entries(channels)) {
    channel.repeat.checked = musicRepeat[key];
    channel.el.loop = false;
  }
  for (const [key, id] of Object.entries(state.sel || {})) {
    const channel = channels[key];
    if (!channel || !library.music.some((item) => item.id === id)) continue;
    channel.select.value = id;
    setSource(key, id);
  }
  applyVolumes();
  refreshUI();
}

function stopAll() {
  musicFadeTokens.clear();
  const fades = [];
  for (const [key, channel] of Object.entries(channels)) {
    if (!channel.el.src) continue;
    if (channel.el.paused && !channel.overlap) {
      channel.el.currentTime = 0;
      musicGain[key] = 0;
      updateDeck(key);
      continue;
    }
    fades.push(new Promise((resolve) => fadeMusic(key, 0, 500, () => {
      finishMusicOverlap(key);
      channel.el.pause();
      channel.el.currentTime = 0;
      musicGain[key] = 0;
      updateDeck(key);
      resolve();
    })));
  }
  for (const player of itemPlayers.values()) fades.push(stopItemWithFade(player));
  return Promise.all(fades).then(() => applyVolumes());
}

async function unloadProfileAudio() {
  await stopAll();
  for (const category of Object.keys(library)) {
    for (const item of library[category]) URL.revokeObjectURL(item.url);
    library[category].length = 0;
  }
  itemPlayers.clear();
  for (const key of Object.keys(channels)) {
    channels[key].el.removeAttribute('src');
    channels[key].el.load();
    channels[key].select.value = '';
    channels[key].peaks = null;
    updateDeck(key);
  }
}

async function loadProfileAudio(profile) {
  const records = await dbGetAll();
  storedRecords.clear();
  for (const record of records) storedRecords.set(record.id, record);
  const fileIds = new Set(profile.fileIds || []);
  for (const record of records) {
    if (record.profileId !== profile.id || !fileIds.has(record.id)) continue;
    let file = record.blob;
    if (record.fileHandle?.getFile) {
      try {
        if (await record.fileHandle.queryPermission({ mode: 'read' }) === 'granted') {
          file = await record.fileHandle.getFile();
          record.blob = file;
          record.name = file.name;
          await dbPut(record);
        }
      } catch {}
    }
    if (!file || !library[record.category]) continue;
    library[record.category].push({
      id: record.id,
      name: record.alias || record.name,
      originalName: record.name,
      alias: record.alias || '',
      url: URL.createObjectURL(file),
      category: record.category,
      repeat: record.category === 'ambience',
      volume: 1,
    });
    if (!profile.fileIds.includes(record.id)) profile.fileIds.push(record.id);
  }
  saveProfiles();
}

async function switchProfile(id) {
  const next = profiles.find((profile) => profile.id === id);
  if (!next || next.id === activeProfile?.id) return;
  saveState();
  cancelAnimationFrame(crossfadeFrame);
  await unloadProfileAudio();
  activeProfile = next;
  await loadProfileAudio(activeProfile);
  renderProfiles();
  refreshUI();
  restoreState(activeProfile.state);
  saveProfiles();
}

async function removeFile(id, category) {
  for (const [key, player] of itemPlayers) {
    if (player.item.id !== id) continue;
    await stopItemWithFade(player);
    itemPlayers.delete(key);
  }
  for (const [key, channel] of Object.entries(channels)) {
    if (channel.select.value !== id) continue;
    await new Promise((resolve) => fadeMusic(key, 0, 450, resolve));
    finishMusicOverlap(key);
    channel.el.pause();
    channel.el.removeAttribute('src');
    channel.el.load();
    channel.select.value = '';
    musicGain[key] = 0;
    channel.peaks = null;
    updateDeck(key);
  }
  const items = library[category];
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) {
    URL.revokeObjectURL(items[index].url);
    items.splice(index, 1);
  }
  activeProfile.fileIds = activeProfile.fileIds.filter((fileId) => fileId !== id);
  storedRecords.delete(id);
  waveformCache.delete(id);
  await dbDelete(id);
  refreshUI();
  saveState();
}

async function audioFingerprint(file) {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${file.name.toLocaleLowerCase()}|${file.size}|${file.lastModified}`;
}

async function moveAudio(item, destination, select) {
  if (!LIBRARY_CATEGORIES.includes(destination) || !library[item.category] || !library[destination]) {
    console.error('Não foi possível mover o áudio: categoria inválida.', { source: item.category, destination });
    if (select) select.value = item.category;
    return;
  }
  if (item.category === destination) return;
  if (destination !== 'unassigned') {
    const record = storedRecords.get(item.id);
    if (!record?.fingerprint && !record?.blob) {
      alert('Não foi possível verificar se este áudio já está no ambiente.');
      if (select) select.value = item.category;
      return;
    }
    const fingerprint = record.fingerprint || await audioFingerprint(record.blob);
    if (record && !record.fingerprint) {
      record.fingerprint = fingerprint;
      await dbPut(record);
    }
    for (const other of library[destination]) {
      if (other.id === item.id) continue;
      if (!activeProfile.fileIds.includes(other.id)) continue;
      const otherRecord = storedRecords.get(other.id);
      if (!otherRecord?.fingerprint && !otherRecord?.blob) {
        alert('Não foi possível verificar se este áudio já está no ambiente.');
        if (select) select.value = item.category;
        return;
      }
      const otherFingerprint = otherRecord.fingerprint || await audioFingerprint(otherRecord.blob);
      if (otherRecord && !otherRecord.fingerprint) {
        otherRecord.fingerprint = otherFingerprint;
        await dbPut(otherRecord);
      }
      if (fingerprint === otherFingerprint) {
        alert('Este áudio já está neste ambiente.');
        if (select) select.value = item.category;
        return;
      }
    }
  }

  for (const player of itemPlayers.values()) {
    if (player.item.id === item.id) {
      await stopItemWithFade(player);
    }
  }
  for (const [key, channel] of Object.entries(channels)) {
    if (channel.select.value !== item.id || item.category !== 'music' || destination === 'music') continue;
    await new Promise((resolve) => fadeMusic(key, 0, 450, resolve));
    finishMusicOverlap(key);
    channel.el.pause();
    channel.el.removeAttribute('src');
    channel.el.load();
    channel.select.value = '';
    musicGain[key] = 0;
    updateDeck(key);
  }
  library[item.category] = library[item.category].filter((entry) => entry.id !== item.id);
  item.category = destination;
  if (destination !== 'unassigned') item.repeat = destination === 'ambience';
  library[destination].push(item);
  const record = storedRecords.get(item.id);
  if (record) {
    record.category = destination;
    await dbPut(record);
  }
  refreshUI();
  saveState();
}

function renameFile(item, row, nameElement) {
  const editor = document.createElement('input');
  editor.className = 'alias-input';
  editor.type = 'text';
  editor.value = item.alias || '';
  editor.placeholder = item.originalName || item.name;
  editor.setAttribute('aria-label', `Alias de ${item.originalName || item.name}`);
  nameElement.replaceWith(editor);

  const actions = row.querySelector('.lib-actions');
  const save = document.createElement('button');
  save.textContent = 'salvar';
  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.textContent = 'cancelar';
  actions.replaceChildren(save, cancel);

  const cancelEdit = () => refreshUI();
  const saveEdit = async () => {
    const alias = editor.value.trim();
    if (!aliasIsAvailable(alias, item)) {
      alert('Este alias já está sendo usado por outro áudio.');
      editor.focus();
      return;
    }
    item.alias = alias;
    item.name = item.alias || item.originalName || item.name;
    const record = storedRecords.get(item.id);
    if (record) {
      record.alias = item.alias;
      await dbPut(record);
    }
    refreshUI();
    saveState();
  };
  save.addEventListener('click', saveEdit);
  cancel.addEventListener('click', cancelEdit);
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveEdit();
    if (event.key === 'Escape') cancelEdit();
  });
  editor.focus();
}

async function hasAudioInProfile(category, fingerprint) {
  if (!LIBRARY_CATEGORIES.includes(category) || !library[category]) {
    throw new Error('Não foi possível verificar duplicidade: categoria de áudio inválida.');
  }
  const profileFileIds = new Set(activeProfile.fileIds);
  for (const item of library[category]) {
    if (!profileFileIds.has(item.id)) continue;
    const record = storedRecords.get(item.id);
    if (!record || record.profileId !== activeProfile.id) continue;
    if (!record?.fingerprint && !record?.blob) {
      throw new Error(`Não foi possível validar se "${item.name}" já existe neste perfil.`);
    }
    const otherFingerprint = record.fingerprint || await audioFingerprint(record.blob);
    if (otherFingerprint === fingerprint) return true;
  }
  return false;
}

async function importFiles(files, handles = [], destination = 'unassigned') {
  if (!files.length || !activeProfile) return;
  if (!LIBRARY_CATEGORIES.includes(destination)) {
    throw new Error('Não foi possível importar os áudios: categoria de destino inválida.');
  }
  for (const [index, file] of files.entries()) {
    const fingerprint = await audioFingerprint(file);
    let alias = '';
    try {
      if (await hasAudioInProfile(destination, fingerprint)) {
        if (!confirm(`Este áudio já foi carregado no perfil atual. Deseja adicioná-lo novamente com outro nome?`)) {
          continue;
        }
        const proposedAlias = prompt('Digite o novo nome do áudio:', file.name.replace(/\.[^.]+$/, ''));
        if (proposedAlias === null) continue;
        alias = proposedAlias.trim();
        if (!aliasIsAvailable(alias)) {
          alert('Este alias já está sendo usado por outro áudio. O arquivo não foi adicionado.');
          continue;
        }
      }
    } catch (error) {
      alert(error.message);
      continue;
    }
    const record = {
      id: uid(), name: file.name, alias, type: file.type, category: destination, fingerprint,
      profileId: activeProfile.id, blob: file,
      ...(handles[index] ? { fileHandle: handles[index] } : {}),
    };
    const persisted = await dbPut(record);
    if (!persisted && record.fileHandle) {
      delete record.fileHandle;
      await dbPut(record);
    }
    storedRecords.set(record.id, record);
    activeProfile.fileIds.push(record.id);
    library[destination].push({
      id: record.id,
      name: alias || record.name,
      originalName: record.name,
      alias,
      url: URL.createObjectURL(file),
      category: destination,
      repeat: destination === 'ambience',
      volume: 1,
    });
  }
  refreshUI();
  saveState();
}

async function chooseAudioFiles(destination = 'unassigned') {
  pendingCategory = destination;
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const handles = await window.showOpenFilePicker({ multiple: true });
      await importFiles(await Promise.all(handles.map((handle) => handle.getFile())), handles, destination);
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  els.fileInput.click();
}

document.querySelectorAll('[data-add]').forEach((button) => {
  button.addEventListener('click', () => chooseAudioFiles());
});
els.fileInput.addEventListener('change', async () => {
  const files = [...els.fileInput.files];
  els.fileInput.value = '';
  await importFiles(files, [], pendingCategory);
});

els.profileSelect.addEventListener('change', () => switchProfile(els.profileSelect.value));
els.createProfile.addEventListener('click', async () => {
  const name = prompt('Nome do perfil:')?.trim();
  if (!name) return;
  saveState();
  const profile = { id: uid(), name, fileIds: [], state: {} };
  profiles.push(profile);
  saveProfiles();
  await switchProfile(profile.id);
});

els.musicASelect.addEventListener('change', () => {
  setSource('musicA', els.musicASelect.value);
  saveState();
});
els.musicBSelect.addEventListener('change', () => {
  setSource('musicB', els.musicBSelect.value);
  saveState();
});

function bindVolume(input, output, key) {
  const update = (value) => {
    vol[key] = value;
    input.value = value;
    output.textContent = pct(value);
    applyVolumes();
    saveState();
  };
  input.addEventListener('input', () => {
    update(parseFloat(input.value));
  });
  makePercentEditable(output, () => vol[key], update);
}
bindVolume(els.masterVol, els.masterVolOut, 'master');
bindVolume(els.ambienceVol, els.ambienceVolOut, 'ambience');
bindVolume(els.musicVol, els.musicVolOut, 'music');
bindVolume(els.sfxVol, els.sfxVolOut, 'sfx');
els.crossfade.addEventListener('input', () => {
  crossfade = parseFloat(els.crossfade.value);
  applyVolumes();
  saveState();
});
els.fadeToA.addEventListener('click', () => fadeTo(0));
els.fadeToB.addEventListener('click', () => fadeTo(1));
els.panicBtn.addEventListener('click', stopAll);

async function init() {
  db = await openDB();
  const records = await dbGetAll();
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
  } catch {}
  if (saved?.profiles?.length) {
    profiles = saved.profiles.filter((profile) => profile.id && profile.name);
    activeProfile = profiles.find((profile) => profile.id === saved.activeId) || profiles[0];
  } else {
    let legacyState = {};
    try {
      legacyState = JSON.parse(localStorage.getItem(LEGACY_STATE_KEY) || '{}');
    } catch {}
    activeProfile = { id: uid(), name: 'Padrão', fileIds: records.map((record) => record.id), state: legacyState };
    profiles = [activeProfile];
  }
  for (const record of records) {
    let owner = profiles.find((profile) => profile.id === record.profileId);
    if (!owner) {
      owner = activeProfile;
      record.profileId = owner.id;
      await dbPut(record);
    }
    owner.fileIds ||= [];
    if (!owner.fileIds.includes(record.id)) owner.fileIds.push(record.id);
  }
  const recordOwners = new Map(records.map((record) => [record.id, record.profileId]));
  for (const profile of profiles) {
    profile.fileIds = profile.fileIds.filter((id) =>
      recordOwners.get(id) === profile.id
    );
  }
  activeProfile.fileIds ||= [];
  renderProfiles();
  await loadProfileAudio(activeProfile);
  restoreState(activeProfile.state);
  saveProfiles();
}

init();