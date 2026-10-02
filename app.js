'use strict';

/* ---------- Storage ---------- */

const KEYS = {
  settings: 'wc.settings',
  words: 'wc.words',
  progress: 'wc.progress',
  daily: 'wc.daily',
  stats: 'wc.stats',
  grammar: 'wc.grammar',
};

const DEFAULT_SETTINGS = {
  sheetUrl: 'https://docs.google.com/spreadsheets/d/1DqVIy7EvasRkeH4ZhSWWWaxfDYlOos5sC4XpBQDynC4/edit?usp=sharing',
  direction: 'reverse', // reverse (translation first) | forward (word first)
  newPerDay: 15,
  dailyGoal: 100,
  sound: true,
  speechLang: 'nl-NL',
  deck: '',
  lastSync: 0,
};

const SAMPLE_WORDS = [
  ['la manzana', 'apple', 'Me como una manzana cada día.', 'Food'],
  ['el pan', 'bread', 'Compro pan en la panadería.', 'Food'],
  ['el agua', 'water', '¿Me das un vaso de agua?', 'Food'],
  ['la casa', 'house', 'Mi casa es pequeña pero bonita.', 'Home'],
  ['la ventana', 'window', 'Abre la ventana, por favor.', 'Home'],
  ['la llave', 'key', 'No encuentro mis llaves.', 'Home'],
  ['caminar', 'to walk', 'Me gusta caminar por la playa.', 'Verbs'],
  ['aprender', 'to learn', 'Quiero aprender español.', 'Verbs'],
  ['olvidar', 'to forget', 'No olvides llamarme.', 'Verbs'],
  ['todavía', 'still, yet', 'Todavía no he comido.', 'Basics'],
].map(([word, translation, example, deck]) => withId({ word, translation, example, deck }));

const LANGUAGES = [
  ['', 'Off'],
  ['es-ES', 'Spanish (Spain)'], ['es-MX', 'Spanish (Mexico)'],
  ['fr-FR', 'French'], ['de-DE', 'German'], ['it-IT', 'Italian'],
  ['pt-PT', 'Portuguese (Portugal)'], ['pt-BR', 'Portuguese (Brazil)'],
  ['en-US', 'English (US)'], ['en-GB', 'English (UK)'],
  ['nl-NL', 'Dutch'], ['sv-SE', 'Swedish'], ['nb-NO', 'Norwegian'], ['da-DK', 'Danish'], ['fi-FI', 'Finnish'],
  ['pl-PL', 'Polish'], ['cs-CZ', 'Czech'], ['sk-SK', 'Slovak'], ['hu-HU', 'Hungarian'], ['ro-RO', 'Romanian'],
  ['uk-UA', 'Ukrainian'], ['ru-RU', 'Russian'], ['bg-BG', 'Bulgarian'], ['hr-HR', 'Croatian'], ['el-GR', 'Greek'],
  ['tr-TR', 'Turkish'], ['he-IL', 'Hebrew'], ['ar-SA', 'Arabic'], ['hi-IN', 'Hindi'],
  ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'], ['zh-CN', 'Chinese (Mandarin)'], ['th-TH', 'Thai'], ['vi-VN', 'Vietnamese'], ['id-ID', 'Indonesian'],
];

const DAY = 86400000;
const XP_FOR_GRADE = [1, 5, 10, 12];
const COMBO_EVERY = 5;
const COMBO_BONUS = 5;

const MESSAGES = {
  new: ['New word! Take a good look.', 'Ooh, a fresh one for you!', 'Here’s a new word to learn!'],
  review: ['Do you remember this one?', 'You’ve seen this before…', 'Let’s see if it stuck!', 'Think hard!'],
  reveal: ['How well did you know it?', 'Be honest, I won’t tell!', 'Did you get it?'],
  again: ['No worries, we’ll practise it again soon.', 'Mistakes help you learn!', 'Tricky one! It’ll come back shortly.'],
  hard: ['Getting there!', 'Almost had it!', 'Good effort!'],
  good: ['Nice!', 'Great job!', 'You got it!', 'Well done!'],
  easy: ['Too easy!', 'Brilliant!', 'Wow, you really know this one!'],
};
const pick = list => list[Math.floor(Math.random() * list.length)];

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    toast('Could not save — storage is full or blocked');
  }
}

const state = {
  settings: { ...DEFAULT_SETTINGS, ...load(KEYS.settings, {}) },
  words: load(KEYS.words, null) || SAMPLE_WORDS,
  progress: load(KEYS.progress, {}),
  queue: [],
  current: null,
  reversed: false,
  revealed: false,
  busy: false,
  session: { reviewed: 0, correct: 0, xp: 0, combo: 0, celebrated: false },
  sayHoldUntil: 0,
};

const saveSettings = () => save(KEYS.settings, state.settings);

// One-time move to "translation first" as the default, and drop the old "mixed" mode.
if (!state.settings.dirMigrated) {
  state.settings.direction = 'reverse';
  state.settings.dirMigrated = true;
  saveSettings();
} else if (!['forward', 'reverse'].includes(state.settings.direction)) {
  state.settings.direction = 'reverse';
}
const saveProgress = () => save(KEYS.progress, state.progress);
const wait = ms => new Promise(r => setTimeout(r, ms));

function withId(w) {
  return { ...w, id: `${w.deck}|${w.word}`.toLowerCase().replace(/\s+/g, ' ').trim() };
}

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(4, 0, 0, 0); // a "day" rolls over at 4am, so late-night study counts for the same day
  if (d.getTime() > t) d.setDate(d.getDate() - 1);
  return d.getTime();
}

const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);

function getDaily() {
  const today = startOfDay(Date.now());
  const d = load(KEYS.daily, null);
  return d && d.date === today ? d : { date: today, newSeen: 0, extra: 0 };
}

/* ---------- Streak & XP ---------- */

function getStats() {
  const s = { streak: 0, best: 0, lastDay: 0, xpTotal: 0, xpDay: 0, xpToday: 0, goalDay: 0, ...load(KEYS.stats, {}) };
  const today = startOfDay(Date.now());
  if (s.xpDay !== today) { s.xpDay = today; s.xpToday = 0; }
  return s;
}

// A streak survives until the end of the day after the last study day.
function liveStreak(s) {
  return s.lastDay && daysBetween(s.lastDay, Date.now()) <= 1 ? s.streak : 0;
}

function addXp(amount) {
  const s = getStats();
  const today = startOfDay(Date.now());
  let extended = false;
  if (s.lastDay !== today) {
    s.streak = s.lastDay && daysBetween(s.lastDay, today) === 1 ? s.streak + 1 : 1;
    s.best = Math.max(s.best, s.streak);
    s.lastDay = today;
    extended = true;
  }
  s.xpTotal += amount;
  s.xpToday += amount;
  let goalReached = false;
  if (s.goalDay !== today && s.xpToday >= state.settings.dailyGoal) {
    s.goalDay = today;
    goalReached = true;
  }
  save(KEYS.stats, s);
  return { stats: s, extended, goalReached };
}

/* ---------- Google Sheet sync ---------- */

// Accepts a normal sheet link (shared "anyone with the link") or a "Publish to web" CSV link.
function toCsvUrl(url) {
  url = url.trim();
  if (/output=csv|format=csv|tqx=out:csv/.test(url)) return url;
  const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/);
  if (m && m[1] !== 'e') {
    const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
    return `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv&headers=1${gid ? `&gid=${gid}` : ''}`;
  }
  return url;
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim()));
}

const HEADER_ALIASES = {
  word: ['word', 'term', 'front', 'foreign', 'phrase'],
  translation: ['translation', 'meaning', 'back', 'definition', 'native'],
  example: ['example', 'sentence', 'context', 'note', 'notes'],
  deck: ['deck', 'tag', 'topic', 'category', 'lesson'],
};

// The sheet may hold several side-by-side blocks of columns (e.g. verbs | empty column | nouns).
// A block ends at an empty header cell, or when a column name repeats.
function headerBlocks(header) {
  const blocks = [];
  let cur = null;
  header.forEach((h, i) => {
    if (!h) { cur = null; return; }
    const key = Object.keys(HEADER_ALIASES).find(k => HEADER_ALIASES[k].includes(h));
    if (!key) return;
    if (!cur || cur[key] >= 0) {
      cur = { word: -1, translation: -1, example: -1, deck: -1 };
      blocks.push(cur);
    }
    cur[key] = i;
  });
  return blocks.filter(b => b.word >= 0 && b.translation >= 0);
}

function rowsToWords(rows) {
  if (rows.length < 2) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  let blocks = headerBlocks(header);
  // Unrecognised header names (e.g. "Spanish", "English") → use column order.
  if (!blocks.length) blocks = [{ word: 0, translation: 1, example: 2, deck: 3 }];

  const seen = new Set();
  const words = [];
  for (const idx of blocks) {
    for (const r of rows.slice(1)) {
      const get = i => (i >= 0 && r[i] ? r[i].trim() : '');
      const w = withId({ word: get(idx.word), translation: get(idx.translation), example: get(idx.example), deck: get(idx.deck) });
      if (!w.word || !w.translation || seen.has(w.id)) continue;
      seen.add(w.id);
      words.push(w);
    }
  }
  return words;
}

async function syncWords({ silent = false } = {}) {
  const url = state.settings.sheetUrl;
  if (!url) {
    if (!silent) { toast('Add your Google Sheet link first'); showView('settings'); }
    return;
  }
  const btn = $('#syncBtn');
  btn.classList.add('spinning');
  try {
    const res = await fetch(toCsvUrl(url), { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).replace(/^﻿/, '');
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('sheet is not shared as "Anyone with the link"');
    const words = rowsToWords(parseCSV(text));
    if (!words.length) throw new Error('no words found — check the columns');

    const known = new Set(state.words.map(w => w.id));
    const added = words.filter(w => !known.has(w.id)).length;
    state.words = words;
    save(KEYS.words, words);
    state.settings.lastSync = Date.now();
    saveSettings();

    if (!silent || added) toast(added ? `${added} new word${added > 1 ? 's' : ''} added` : `Up to date · ${words.length} words`);
    // Don't yank the card away mid-answer; just refresh lists and counts.
    if (state.current && state.revealed) { renderDecks(); renderWords(); renderSettings(); renderCounts(); }
    else refresh();
  } catch (e) {
    if (!silent) toast(`Sync failed: ${e.message}`);
  } finally {
    btn.classList.remove('spinning');
  }
}

/* ---------- Spaced repetition (simplified SM-2) ---------- */

// grade: 0 again, 1 hard, 2 good, 3 easy. Intervals are in days.
function schedule(prev, grade, now = Date.now()) {
  const p = prev ? { ...prev } : { ease: 2.5, interval: 0, reps: 0, lapses: 0 };
  if (grade === 0) {
    p.reps = 0;
    p.lapses += prev ? 1 : 0;
    p.interval = 0;
    p.ease = Math.max(1.3, p.ease - 0.2);
  } else {
    const good = p.reps === 0 ? 1 : p.reps === 1 ? 3 : Math.round(p.interval * p.ease);
    if (grade === 1) {
      p.interval = p.reps === 0 ? 1 : Math.max(1, Math.round(p.interval * 1.2));
      p.ease = Math.max(1.3, p.ease - 0.15);
    } else if (grade === 2) {
      p.interval = good;
    } else {
      p.interval = p.reps === 0 ? 4 : Math.round(good * 1.3);
      p.ease += 0.15;
    }
    p.interval = Math.min(p.interval, 365);
    p.reps += 1;
  }
  p.due = p.interval === 0 ? now : startOfDay(now) + p.interval * DAY;
  p.updated = now;
  return p;
}

function formatInterval(days) {
  if (days === 0) return 'now';
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1).replace('.0', '')}y`;
}

function strength(p) {
  if (!p) return 0;
  if (p.interval < 3) return 1;
  if (p.interval < 7) return 2;
  if (p.interval < 21) return 3;
  return 4;
}

function deckWords() {
  const deck = state.settings.deck;
  return state.words.filter(w => !deck || w.deck === deck);
}

function newLeftToday() {
  const daily = getDaily();
  return Math.max(0, state.settings.newPerDay + daily.extra - daily.newSeen);
}

function buildQueue() {
  const now = Date.now();
  const pool = deckWords();
  const due = pool
    .filter(w => state.progress[w.id] && state.progress[w.id].due <= now)
    .sort((a, b) => state.progress[a.id].due - state.progress[b.id].due);
  const fresh = pool.filter(w => !state.progress[w.id]).slice(0, newLeftToday());

  // Spread new words through the reviews: one new after every 3 reviews.
  const queue = [];
  while (due.length || fresh.length) {
    queue.push(...due.splice(0, 3));
    if (fresh.length) queue.push(fresh.shift());
  }
  state.queue = queue;
}

function nextCard({ animate = true } = {}) {
  state.current = state.queue.shift() || null;
  state.revealed = false;
  state.reversed = pickReversed();
  renderCard(animate);
}

function pickReversed() {
  return state.settings.direction !== 'forward';
}

function renderModeSwitch() {
  document.querySelectorAll('#modeSwitch [data-dir]').forEach(btn => {
    btn.setAttribute('aria-checked', String(btn.dataset.dir === state.settings.direction));
  });
  $('#direction').value = state.settings.direction;
}

function setDirection(dir) {
  if (dir === state.settings.direction) return;
  state.settings.direction = dir;
  saveSettings();
  renderModeSwitch();
  sfx('flip');
  // Apply to the card on screen right away, unless its answer is already showing.
  if (state.current && !state.revealed && !state.busy) {
    state.reversed = pickReversed();
    renderCard(true);
  }
}

/* ---------- Study flow ---------- */

function reveal() {
  if (!state.current || state.revealed || state.busy) return;
  state.revealed = true;
  $('#card').classList.add('flipped');
  $('#revealBtn').hidden = true;
  $('#grades').hidden = false;
  const prev = state.progress[state.current.id];
  document.querySelectorAll('.g').forEach(btn => {
    btn.querySelector('small').textContent = formatInterval(schedule(prev, Number(btn.dataset.grade)).interval);
  });
  sfx('flip');
  say(pick(MESSAGES.reveal), 'think');
  // Reverse cards: the foreign word just appeared, so pronounce it.
  if (state.reversed) speak();
}

async function grade(g, btn) {
  const w = state.current;
  if (!w || !state.revealed || state.busy) return;
  state.busy = true;

  const prev = state.progress[w.id];
  if (!prev) {
    const daily = getDaily();
    daily.newSeen += 1;
    save(KEYS.daily, daily);
  }
  state.progress[w.id] = schedule(prev, g);
  saveProgress();

  const s = state.session;
  s.reviewed += 1;
  if (g > 0) s.correct += 1;
  s.combo = g >= 2 ? s.combo + 1 : 0;
  const comboHit = s.combo > 0 && s.combo % COMBO_EVERY === 0;
  const xp = XP_FOR_GRADE[g] + (comboHit ? COMBO_BONUS : 0);
  s.xp += xp;
  const { stats, extended, goalReached } = addXp(xp);

  floatXp(btn, xp);
  sfx(comboHit ? 'combo' : ['again', 'hard', 'good', 'easy'][g]);

  let text = pick(MESSAGES[['again', 'hard', 'good', 'easy'][g]]);
  let mood = g === 0 ? 'sad' : g === 1 ? 'idle' : 'happy';
  if (comboHit) { text = `${s.combo} in a row! You’re on fire!`; mood = 'happy'; }
  if (extended) { text = stats.streak > 1 ? `Streak extended! ${stats.streak} days in a row!` : 'Day 1 of your streak. Let’s go!'; mood = 'happy'; }
  if (goalReached) { text = 'Daily goal reached! Amazing!'; mood = 'happy'; confetti(); }
  say(text, mood, { hold: 1500, anim: g === 0 ? 'shake' : 'hop' });
  renderChips({ bumpStreak: extended, bumpXp: true });

  // "Again" → see it once more a few cards later in this session.
  if (g === 0) state.queue.splice(Math.min(3, state.queue.length), 0, w);

  const scene = $('#cardScene');
  scene.classList.add('exit');
  await wait(200);
  scene.classList.remove('exit');
  state.busy = false;
  nextCard();

  if (!state.current && !s.celebrated) {
    s.celebrated = true;
    sfx('complete');
    confetti();
  }
}

/* ---------- Mascot ---------- */

function mountMascots() {
  const tpl = $('#mascotTpl');
  for (const slot of [$('#mascotSlot'), $('#doneMascot'), $('#gMascot'), $('#gDoneMascot')]) {
    slot.append(tpl.content.cloneNode(true));
  }
}

function setMood(slot, mood, anim) {
  const m = slot.querySelector('.mascot');
  m.dataset.mood = mood;
  if (!anim) return;
  m.classList.remove('hop', 'shake');
  void m.getBoundingClientRect(); // restart the animation
  m.classList.add(anim);
}

let sayTimer;
function say(text, mood = 'idle', { hold = 0, anim } = {}) {
  clearTimeout(sayTimer);
  const bubble = $('#bubble');
  bubble.textContent = text;
  bubble.classList.remove('pop');
  void bubble.offsetWidth;
  bubble.classList.add('pop');
  setMood($('#mascotSlot'), mood, anim);
  state.sayHoldUntil = Date.now() + hold;
}

// Waits for a reaction (e.g. "Great job!") to be read before prompting for the next card.
function sayAfterHold(text, mood) {
  clearTimeout(sayTimer);
  const delay = Math.max(0, state.sayHoldUntil - Date.now());
  if (!delay) return say(text, mood);
  sayTimer = setTimeout(() => say(text, mood), delay);
}

/* ---------- Effects ---------- */

let audioCtx;
function sfx(name) {
  if (!state.settings.sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const note = (freq, at, dur, type = 'sine', vol = 0.16) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t + at);
      gain.gain.linearRampToValueAtTime(vol, t + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + at);
      osc.stop(t + at + dur + 0.02);
    };
    switch (name) {
      case 'flip': note(520, 0, 0.08, 'triangle', 0.07); note(780, 0.04, 0.08, 'triangle', 0.05); break;
      case 'again': note(260, 0, 0.16, 'triangle', 0.14); note(196, 0.1, 0.26, 'triangle', 0.14); break;
      case 'hard': note(587, 0, 0.18, 'triangle', 0.12); break;
      case 'good': note(880, 0, 0.12); note(1318.5, 0.09, 0.26); break;
      case 'easy': note(880, 0, 0.1); note(1174.7, 0.07, 0.1); note(1568, 0.14, 0.3); break;
      case 'combo': [784, 988, 1175, 1568].forEach((f, i) => note(f, i * 0.06, 0.18, 'sine', 0.13)); break;
      case 'complete': [523.3, 659.3, 784, 1046.5, 1318.5].forEach((f, i) => note(f, i * 0.1, 0.35, 'triangle', 0.14)); break;
    }
  } catch { /* audio unavailable */ }
}

function floatXp(anchor, xp) {
  const r = anchor ? anchor.getBoundingClientRect() : { left: innerWidth / 2, width: 0, top: innerHeight / 2 };
  const el = document.createElement('div');
  el.className = 'xp-float';
  el.textContent = `+${xp} XP`;
  el.style.left = `${r.left + r.width / 2}px`;
  el.style.top = `${r.top - 10}px`;
  document.body.append(el);
  setTimeout(() => el.remove(), 950);
}

function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.append(canvas);
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const colors = ['#58cc02', '#1cb0f6', '#ff9600', '#ff4b4b', '#ce82ff', '#ffc800'];
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 60,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 13 - 5,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.35,
    w: 6 + Math.random() * 6,
    h: 9 + Math.random() * 8,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.32; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.cos(p.r * 2));
      ctx.restore();
    }
    if (now - start < 2800) requestAnimationFrame(frame);
    else canvas.remove();
  })(start);
}

/* ---------- Rendering ---------- */

const $ = s => document.querySelector(s);

const ICONS = {
  bolt: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M13.5 2 5 13.5h6L10 22l9-12h-6z"/></svg>',
  flame: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2c.6 3.2 2.6 4.9 4.3 6.8C18 10.6 19 12.6 19 15a7 7 0 0 1-14 0c0-2.4 1-4 2.3-5.4.3 1.6 1.1 2.7 2.2 3.2C9 9 10 5.4 12 2z"/></svg>',
  target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M5 3h11a3 3 0 0 1 3 3v15H8a3 3 0 0 1-3-3z"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="m12 2.5 2.9 6 6.6.8-4.9 4.5 1.3 6.5L12 17l-5.9 3.3 1.3-6.5-4.9-4.5 6.6-.8z"/></svg>',
  sprout: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M11 21v-7C6 14 3 11 3 6c5 0 8 2.5 8 7 0-5 3-8 9-8 0 5.5-3 8.5-7 8.5V21z"/></svg>',
};

function tilesHtml(tiles) {
  return tiles.map(t => `
    <div class="tile t-${t.color}">
      <div class="tile-label">${t.label}</div>
      <div class="tile-value">${ICONS[t.icon]}<span>${t.value}</span></div>
    </div>`).join('');
}

function renderChips({ bumpStreak = false, bumpXp = false } = {}) {
  const s = getStats();
  const streakChip = $('#streakChip');
  $('#streakNum').textContent = liveStreak(s);
  streakChip.classList.toggle('lit', s.lastDay === startOfDay(Date.now()));
  const goal = state.settings.dailyGoal;
  $('#xpNum').textContent = s.xpToday;
  $('#xpRing').setAttribute('stroke-dasharray', `${Math.min(100, (s.xpToday / goal) * 100)} 100`);
  $('#xpChip').classList.toggle('goal', s.xpToday >= goal);
  const bump = el => { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); };
  if (bumpStreak) bump(streakChip);
  if (bumpXp) bump($('#xpChip'));
}

function renderCounts() {
  const now = Date.now();
  const pool = deckWords();
  const due = pool.filter(w => state.progress[w.id] && state.progress[w.id].due <= now).length;
  const newToday = Math.min(pool.filter(w => !state.progress[w.id]).length, newLeftToday());
  $('#counts').innerHTML = `<span class="c-due">${due} due</span> · <span class="c-new">${newToday} new</span>`;
}

function renderProgress() {
  const done = state.session.reviewed;
  const left = state.queue.length + (state.current ? 1 : 0);
  const pct = done + left ? (done / (done + left)) * 100 : 0;
  $('#progressFill').style.width = `${pct}%`;
  const combo = $('#combo');
  const c = state.session.combo;
  combo.hidden = c < 3;
  if (c >= 3) {
    combo.textContent = `${c} in a row`;
    combo.style.animation = 'none';
    void combo.offsetWidth;
    combo.style.animation = '';
  }
}

function renderCard(animate = false) {
  renderCounts();
  renderProgress();
  const w = state.current;
  $('#studyArea').hidden = !w;
  $('#done').hidden = !!w;
  if (!w) return renderDone();

  // Reset the flip instantly so the next card's answer never shows mid-rotation.
  const card = $('#card');
  card.classList.add('instant');
  card.classList.toggle('flipped', state.revealed);
  void card.offsetWidth;
  card.classList.remove('instant');

  const front = state.reversed ? w.translation : w.word;
  const back = state.reversed ? w.word : w.translation;
  $('#frontDeck').textContent = w.deck || '';
  $('#backDeck').textContent = w.deck || '';
  $('#cardFront').textContent = front;
  $('#cardAsked').textContent = front;
  $('#cardAnswer').textContent = back;
  $('#cardExample').textContent = w.example || '';
  $('#revealBtn').hidden = state.revealed;
  $('#grades').hidden = !state.revealed;
  // Only offer pronunciation once the foreign word is visible.
  $('#speakFront').hidden = !canSpeak() || state.reversed;
  $('#speakBack').hidden = !canSpeak();

  if (animate) {
    const scene = $('#cardScene');
    scene.classList.remove('enter');
    void scene.offsetWidth;
    scene.classList.add('enter');
  }
  if (!state.revealed) sayAfterHold(pick(state.progress[w.id] ? MESSAGES.review : MESSAGES.new), 'idle');
}

function renderDone() {
  const pool = deckWords();
  const s = getStats();
  const session = state.session;
  const remainingNew = pool.filter(w => !state.progress[w.id]).length;
  const upcoming = pool.map(w => state.progress[w.id]).filter(Boolean).map(p => p.due).sort((a, b) => a - b);

  let text = '';
  if (upcoming.length) {
    const next = upcoming[0];
    const days = daysBetween(Date.now(), next);
    const count = upcoming.filter(d => startOfDay(d) === startOfDay(next)).length;
    text = `Next review ${days <= 1 ? 'tomorrow' : `in ${days} days`} · ${count} word${count > 1 ? 's' : ''}.`;
  } else if (!remainingNew) {
    text = 'Add words to your sheet to get started.';
  }
  if (remainingNew) text += ` ${remainingNew} new word${remainingNew > 1 ? 's' : ''} waiting.`;

  if (session.reviewed) {
    $('#doneTitle').textContent = 'Lesson complete!';
    $('#doneTiles').innerHTML = tilesHtml([
      { label: 'Total XP', value: session.xp, icon: 'bolt', color: 'gold' },
      { label: 'Accuracy', value: `${Math.round((session.correct / session.reviewed) * 100)}%`, icon: 'target', color: 'green' },
      { label: 'Streak', value: liveStreak(s), icon: 'flame', color: 'orange' },
    ]);
    setMood($('#doneMascot'), 'party');
  } else {
    $('#doneTitle').textContent = 'All caught up!';
    $('#doneTiles').innerHTML = tilesHtml([
      { label: 'Today', value: s.xpToday, icon: 'bolt', color: 'gold' },
      { label: 'Streak', value: liveStreak(s), icon: 'flame', color: 'orange' },
      { label: 'Best', value: s.best, icon: 'star', color: 'purple' },
    ]);
    setMood($('#doneMascot'), 'happy');
  }
  $('#doneText').textContent = text.trim();
  $('#moreBtn').hidden = !remainingNew;
}

function renderDecks() {
  const decks = [...new Set(state.words.map(w => w.deck).filter(Boolean))].sort();
  if (state.settings.deck && !decks.includes(state.settings.deck)) {
    state.settings.deck = '';
    saveSettings();
  }
  const sel = $('#deckSelect');
  sel.hidden = !decks.length;
  sel.innerHTML = '';
  sel.append(new Option(`All words (${state.words.length})`, ''));
  for (const d of decks) {
    sel.append(new Option(`${d} (${state.words.filter(w => w.deck === d).length})`, d));
  }
  sel.value = state.settings.deck;
}

function wordStatus(w, now) {
  const p = state.progress[w.id];
  if (!p) return ['New', 'new'];
  if (p.due <= now) return ['Due', 'due'];
  return [formatInterval(Math.max(1, daysBetween(now, p.due))), ''];
}

function renderWords() {
  const q = $('#search').value.trim().toLowerCase();
  const now = Date.now();
  const all = deckWords();
  const list = all.filter(w => !q || `${w.word} ${w.translation}`.toLowerCase().includes(q));

  const started = all.filter(w => state.progress[w.id]).length;
  const mastered = all.filter(w => state.progress[w.id]?.interval >= 21).length;
  $('#wordTiles').innerHTML = tilesHtml([
    { label: 'Words', value: all.length, icon: 'book', color: 'blue' },
    { label: 'Learning', value: started - mastered, icon: 'sprout', color: 'orange' },
    { label: 'Mastered', value: mastered, icon: 'star', color: 'green' },
  ]);

  const ul = $('#wordList');
  ul.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const w of list) {
    const [label, cls] = wordStatus(w, now);
    const li = document.createElement('li');
    li.innerHTML = '<div class="strength"><i></i><i></i><i></i><i></i></div><div class="wl-text"><div class="wl-word"></div><div class="wl-trans"></div></div><span class="badge"></span>';
    li.querySelector('.strength').dataset.level = strength(state.progress[w.id]);
    li.querySelector('.wl-word').textContent = w.word;
    li.querySelector('.wl-trans').textContent = w.translation;
    const badge = li.querySelector('.badge');
    badge.textContent = label;
    if (cls) badge.classList.add(cls);
    frag.append(li);
  }
  ul.append(frag);
}

function renderSettings() {
  const s = state.settings;
  $('#sheetUrl').value = s.sheetUrl;
  $('#direction').value = s.direction;
  $('#newPerDay').value = s.newPerDay;
  $('#dailyGoal').value = String(s.dailyGoal);
  $('#sound').checked = s.sound;
  $('#speechLang').value = s.speechLang;
  $('#lastSync').textContent = s.lastSync
    ? `Last synced ${new Date(s.lastSync).toLocaleString()} · ${state.words.length} words`
    : s.sheetUrl ? '' : 'Using built-in sample words until you add a sheet.';
}

function refresh() {
  if (!$('#gHome').hidden) renderGrammarHome();
  renderDecks();
  buildQueue();
  nextCard();
  renderWords();
  renderSettings();
  renderModeSwitch();
  renderChips();
}

/* ---------- Speech ---------- */

const canSpeak = () => 'speechSynthesis' in window && !!state.settings.speechLang;

function speak() {
  if (state.current) speakText(state.current.word);
}

function speakText(text) {
  if (!text || !canSpeak()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = state.settings.speechLang;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

/* ---------- Grammar: de / het ---------- */

const GRAMMAR_ROUND = 10;
const GRAMMAR_XP = 5;
const ARTICLE_RE = /^(de|het)\s+(.+)$/i;
const NOUN_DECK_RE = /^(nouns?|zelfstandige naamwoorden|znw|substantieven)$/i;

const grammar = { items: [], i: 0, answered: 0, correct: 0, xp: 0, combo: 0, retried: new Set(), locked: false };

// Nouns from the noun deck that start with their article ("het seizoen").
// Falls back to any word with an article if there is no noun deck.
function nounPool() {
  const withArticle = state.words
    .map(w => {
      const m = w.word.match(ARTICLE_RE);
      return m && { ...w, article: m[1].toLowerCase(), bare: m[2] };
    })
    .filter(Boolean);
  const fromDeck = withArticle.filter(w => NOUN_DECK_RE.test(w.deck));
  return fromDeck.length ? fromDeck : withArticle;
}

const getGrammarStats = () => load(KEYS.grammar, { words: {}, last: null });

function renderGrammarHome() {
  const pool = nounPool();
  const de = pool.filter(w => w.article === 'de').length;
  const last = getGrammarStats().last;
  $('#deHetSub').textContent = pool.length
    ? `${pool.length} nouns · ${de} de, ${pool.length - de} het${last ? ` · last ${last.correct}/${last.total}` : ''}`
    : 'No nouns yet';
  $('#gHint').textContent = pool.length
    ? 'Pick the right article. Nouns you get wrong come back more often.'
    : 'Add nouns with their article (e.g. “de broer”, “het kind”) to a deck called “noun” in your sheet.';
  $('#startDeHet').disabled = !pool.length;
}

function showGrammarScreen(name) {
  $('#gHome').hidden = name !== 'home';
  $('#gPlay').hidden = name !== 'play';
  $('#gDone').hidden = name !== 'done';
  if (name === 'home') renderGrammarHome();
}

function startDeHet() {
  const pool = nounPool();
  if (!pool.length) return;
  const stats = getGrammarStats().words;
  // Prefer nouns you get wrong and ones you haven't tried, with some randomness.
  const priority = w => {
    const s = stats[w.id] || { right: 0, wrong: 0 };
    return s.wrong * 2 - s.right + (s.right + s.wrong ? 0 : 1.5) + Math.random() * 2.5;
  };
  const items = pool.map(w => [priority(w), w]).sort((a, b) => b[0] - a[0]).slice(0, GRAMMAR_ROUND).map(x => x[1]);
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  Object.assign(grammar, { items, i: 0, answered: 0, correct: 0, xp: 0, combo: 0, retried: new Set(), locked: false });
  showGrammarScreen('play');
  renderGrammarQuestion();
}

function gSay(text, mood = 'idle', anim) {
  const bubble = $('#gBubble');
  bubble.textContent = text;
  bubble.classList.remove('pop');
  void bubble.offsetWidth;
  bubble.classList.add('pop');
  setMood($('#gMascot'), mood, anim);
}

function renderGrammarQuestion() {
  const w = grammar.items[grammar.i];
  grammar.locked = false;
  $('#gProgress').style.width = `${(grammar.i / grammar.items.length) * 100}%`;
  const art = $('#gArt');
  art.textContent = '___';
  art.className = 'g-art';
  $('#gNoun').textContent = w.bare;
  $('#gTrans').textContent = w.translation;
  document.querySelectorAll('.g-choice').forEach(b => { b.disabled = false; b.classList.remove('correct', 'wrong'); });
  $('#gFeedback').hidden = true;
  gSay(grammar.i === 0 ? 'De or het? Let’s go!' : pick(['De or het?', 'Which article?', 'What do you think?']));
}

function answerArticle(choice, btn) {
  if (grammar.locked) return;
  grammar.locked = true;
  const w = grammar.items[grammar.i];
  const ok = choice === w.article;

  const gs = getGrammarStats();
  const s = gs.words[w.id] || { right: 0, wrong: 0 };
  s[ok ? 'right' : 'wrong'] += 1;
  gs.words[w.id] = s;
  save(KEYS.grammar, gs);

  grammar.answered += 1;
  document.querySelectorAll('.g-choice').forEach(b => {
    b.disabled = true;
    if (b.dataset.art === w.article) b.classList.add('correct');
    else if (b === btn) b.classList.add('wrong');
  });
  const art = $('#gArt');
  art.textContent = w.article;
  art.classList.add(ok ? 'ok' : 'bad');

  const fb = $('#gFeedback');
  fb.className = `g-feedback ${ok ? 'ok' : 'bad'}`;
  fb.hidden = false;
  $('#gFbText').textContent = `${w.article} ${w.bare} = ${w.translation}`;

  if (ok) {
    grammar.correct += 1;
    grammar.combo += 1;
    grammar.xp += GRAMMAR_XP;
    const { extended, goalReached, stats } = addXp(GRAMMAR_XP);
    floatXp(btn, GRAMMAR_XP);
    sfx(grammar.combo % COMBO_EVERY === 0 ? 'combo' : 'good');
    $('#gFbTitle').textContent = pick(['Correct!', 'Nice!', 'Great job!', 'You got it!']);
    let text = pick(MESSAGES.good);
    if (grammar.combo >= 3) text = `${grammar.combo} in a row!`;
    if (extended) text = stats.streak > 1 ? `Streak extended! ${stats.streak} days!` : 'Day 1 of your streak!';
    if (goalReached) { text = 'Daily goal reached!'; confetti(); }
    gSay(text, 'happy', 'hop');
    renderChips({ bumpStreak: extended, bumpXp: true });
  } else {
    grammar.combo = 0;
    sfx('again');
    $('#gFbTitle').textContent = 'Not quite';
    gSay(`It’s “${w.article}”. We’ll try it again at the end.`, 'sad', 'shake');
    // Ask each missed noun once more at the end of the round.
    if (!grammar.retried.has(w.id)) {
      grammar.retried.add(w.id);
      grammar.items.push(w);
    }
  }
  speakText(`${w.article} ${w.bare}`);
  $('#gContinue').focus({ preventScroll: true });
}

function nextGrammarQuestion() {
  if (!grammar.locked) return;
  grammar.i += 1;
  if (grammar.i < grammar.items.length) return renderGrammarQuestion();
  finishGrammar();
}

function finishGrammar() {
  const firstTry = grammar.items.length - grammar.retried.size;
  const correctFirst = firstTry - grammar.retried.size;
  const gs = getGrammarStats();
  gs.last = { correct: correctFirst, total: firstTry, at: Date.now() };
  save(KEYS.grammar, gs);

  const accuracy = Math.round((grammar.correct / grammar.answered) * 100);
  const great = correctFirst / firstTry >= 0.8;
  $('#gDoneTitle').textContent = great ? 'Article master!' : 'Round complete!';
  $('#gDoneText').textContent = `${correctFirst} of ${firstTry} right on the first try.`
    + (great ? '' : ' Practise again to lock them in.');
  $('#gDoneTiles').innerHTML = tilesHtml([
    { label: 'Total XP', value: grammar.xp, icon: 'bolt', color: 'gold' },
    { label: 'Accuracy', value: `${accuracy}%`, icon: 'target', color: 'green' },
    { label: 'Streak', value: liveStreak(getStats()), icon: 'flame', color: 'orange' },
  ]);
  setMood($('#gDoneMascot'), great ? 'party' : 'happy');
  showGrammarScreen('done');
  sfx('complete');
  if (great) confetti();
}

/* ---------- Progress export / import ---------- */

function exportProgress() {
  const data = JSON.stringify({
    app: 'word-cards',
    exported: new Date().toISOString(),
    progress: state.progress,
    stats: getStats(),
    grammar: getGrammarStats(),
  });
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `word-progress-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importProgress(file) {
  try {
    const data = JSON.parse(await file.text());
    const incoming = data.progress || {};
    let merged = 0;
    // Merge per word, keeping whichever copy was reviewed most recently.
    for (const [id, p] of Object.entries(incoming)) {
      const mine = state.progress[id];
      if (!mine || (p.updated || 0) > (mine.updated || 0)) {
        state.progress[id] = p;
        merged++;
      }
    }
    saveProgress();
    // Keep the better streak and the larger XP total.
    if (data.stats) {
      const s = getStats();
      const theirs = data.stats;
      if (liveStreak(theirs) > liveStreak(s)) { s.streak = theirs.streak; s.lastDay = theirs.lastDay; }
      s.best = Math.max(s.best, theirs.best || 0);
      s.xpTotal = Math.max(s.xpTotal, theirs.xpTotal || 0);
      save(KEYS.stats, s);
    }
    if (data.grammar && !localStorage.getItem(KEYS.grammar)) save(KEYS.grammar, data.grammar);
    toast(`Imported ${merged} word${merged === 1 ? '' : 's'}`);
    refresh();
  } catch {
    toast('That file is not a valid progress export');
  }
}

/* ---------- UI wiring ---------- */

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const TITLES = { study: 'Learn', words: 'Words', grammar: 'Grammar', settings: 'Settings' };

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  $('#title').textContent = TITLES[name];
  if (name === 'words') renderWords();
  if (name === 'study') renderCounts();
  if (name === 'grammar' && $('#gPlay').hidden) showGrammarScreen('home');
  $('main').scrollTop = 0;
}

function init() {
  mountMascots();
  const langSel = $('#speechLang');
  for (const [code, name] of LANGUAGES) langSel.append(new Option(name, code));

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));

  $('#card').addEventListener('click', e => {
    if (e.target.closest('.speak')) return;
    reveal();
  });
  $('#revealBtn').addEventListener('click', reveal);
  $('#speakFront').addEventListener('click', speak);
  $('#speakBack').addEventListener('click', speak);
  $('#grades').addEventListener('click', e => {
    const btn = e.target.closest('[data-grade]');
    if (btn) grade(Number(btn.dataset.grade), btn);
  });

  // Keyboard: space/enter reveals, 1–4 grades (handy on iPad with a keyboard).
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select')) return;
    // Grammar: d / h pick the article, Enter continues.
    if ($('#view-grammar').classList.contains('active') && !$('#gPlay').hidden) {
      const k = e.key.toLowerCase();
      if (!grammar.locked && (k === 'd' || k === 'h')) {
        const art = k === 'd' ? 'de' : 'het';
        answerArticle(art, document.querySelector(`.g-choice[data-art="${art}"]`));
      } else if (grammar.locked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); nextGrammarQuestion(); }
      return;
    }
    if (!$('#view-study').classList.contains('active')) return;
    if ((e.key === ' ' || e.key === 'Enter') && !state.revealed) { e.preventDefault(); reveal(); }
    else if (state.revealed && ['1', '2', '3', '4'].includes(e.key)) {
      grade(Number(e.key) - 1, document.querySelector(`[data-grade="${Number(e.key) - 1}"]`));
    }
  });

  $('#streakChip').addEventListener('click', () => {
    const s = getStats();
    const n = liveStreak(s);
    const today = s.lastDay === startOfDay(Date.now());
    toast(n ? `${n}-day streak!${today ? '' : ' Study today to keep it going.'}` : 'Study today to start a streak!');
  });
  $('#xpChip').addEventListener('click', () => {
    const s = getStats();
    toast(`${s.xpToday} / ${state.settings.dailyGoal} XP today · ${s.xpTotal} XP total`);
  });

  $('#moreBtn').addEventListener('click', () => {
    const daily = getDaily();
    daily.extra += 10;
    save(KEYS.daily, daily);
    state.session.celebrated = false;
    buildQueue();
    nextCard();
  });

  $('#deckSelect').addEventListener('change', e => {
    state.settings.deck = e.target.value;
    saveSettings();
    buildQueue();
    nextCard();
    renderWords();
  });

  $('#search').addEventListener('input', renderWords);

  $('#startDeHet').addEventListener('click', startDeHet);
  $('#gChoices').addEventListener('click', e => {
    const btn = e.target.closest('[data-art]');
    if (btn) answerArticle(btn.dataset.art, btn);
  });
  $('#gContinue').addEventListener('click', nextGrammarQuestion);
  $('#gClose').addEventListener('click', () => showGrammarScreen('home'));
  $('#gAgain').addEventListener('click', startDeHet);
  $('#gBack').addEventListener('click', () => showGrammarScreen('home'));
  $('#syncBtn').addEventListener('click', () => syncWords());

  $('#saveSheet').addEventListener('click', () => {
    state.settings.sheetUrl = $('#sheetUrl').value.trim();
    saveSettings();
    syncWords();
  });
  $('#direction').addEventListener('change', e => setDirection(e.target.value));
  $('#modeSwitch').addEventListener('click', e => {
    const btn = e.target.closest('[data-dir]');
    if (btn) setDirection(btn.dataset.dir);
  });
  $('#newPerDay').addEventListener('change', e => {
    state.settings.newPerDay = Math.max(0, Math.min(200, parseInt(e.target.value, 10) || 0));
    e.target.value = state.settings.newPerDay;
    saveSettings();
    buildQueue();
    nextCard();
  });
  $('#dailyGoal').addEventListener('change', e => {
    state.settings.dailyGoal = Number(e.target.value);
    saveSettings();
    renderChips();
  });
  $('#sound').addEventListener('change', e => {
    state.settings.sound = e.target.checked;
    saveSettings();
    sfx('good');
  });
  $('#speechLang').addEventListener('change', e => {
    state.settings.speechLang = e.target.value;
    saveSettings();
    renderCard();
  });

  $('#exportBtn').addEventListener('click', exportProgress);
  $('#importFile').addEventListener('change', e => {
    if (e.target.files[0]) importProgress(e.target.files[0]);
    e.target.value = '';
  });
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Erase all learning progress, streak and XP on this device?')) return;
    state.progress = {};
    saveProgress();
    localStorage.removeItem(KEYS.daily);
    localStorage.removeItem(KEYS.stats);
    localStorage.removeItem(KEYS.grammar);
    state.session = { reviewed: 0, correct: 0, xp: 0, combo: 0, celebrated: false };
    refresh();
    toast('Progress reset');
  });

  // Pull new words whenever the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    renderChips();
    if (Date.now() - state.settings.lastSync > 5 * 60 * 1000) syncWords({ silent: true });
    else renderCounts();
  });

  refresh();
  if (state.settings.sheetUrl) syncWords({ silent: true });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
