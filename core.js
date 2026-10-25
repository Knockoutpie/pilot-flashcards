/* Pilot Oral Exam Flashcards — core logic (no DOM). Loaded before app.js.
   Kept free of browser APIs except the injected storage so it can be unit-tested. */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'pofc.v2';
  var TEXT_SIZES = [0.85, 1, 1.15, 1.3];
  var RATES = [0.75, 0.85, 1, 1.15, 1.3, 1.5];
  var THINK = [0, 2, 3, 5, 8];
  var MAX_SESSIONS = 30;

  function defaults() {
    return {
      reviewed: {}, marked: {}, accepted: false,
      settings: { textSize: 1, theme: 'dark', studyMode: 'quiz', rate: 1, voice: '', think: 3 },
      sessions: {}   // studyKey -> { order: [ids], index: n, t: timestamp }
    };
  }

  // ---------- persistence (storage is injected; any {getItem,setItem,removeItem}) ----------
  function loadState(storage) {
    var state = defaults();
    var raw = null;
    try { raw = storage ? storage.getItem(STORAGE_KEY) : null; } catch (e) { raw = null; }
    if (!raw) return state;
    try {
      var saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return state;
      if (saved.reviewed && typeof saved.reviewed === 'object') state.reviewed = saved.reviewed;
      if (saved.marked && typeof saved.marked === 'object') state.marked = saved.marked;
      state.accepted = saved.accepted === true;
      var s = saved.settings || {};
      if (TEXT_SIZES.indexOf(s.textSize) !== -1) state.settings.textSize = s.textSize;
      if (s.theme === 'light' || s.theme === 'dark') state.settings.theme = s.theme;
      if (s.studyMode === 'quiz' || s.studyMode === 'study') state.settings.studyMode = s.studyMode;
      if (RATES.indexOf(s.rate) !== -1) state.settings.rate = s.rate;
      if (typeof s.voice === 'string' && s.voice.length < 300) state.settings.voice = s.voice;
      if (THINK.indexOf(s.think) !== -1) state.settings.think = s.think;
      if (saved.sessions && typeof saved.sessions === 'object') {
        Object.keys(saved.sessions).forEach(function (k) {
          var v = saved.sessions[k];
          if (v && Array.isArray(v.order) && typeof v.index === 'number') state.sessions[k] = v;
        });
      }
    } catch (e) { /* corrupt entry: start fresh */ }
    return state;
  }

  function saveState(storage, state) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; } catch (e) { return false; }
  }

  // ---------- study sessions (order + position survive reloads) ----------
  function studyKey(deckId, mode) { return deckId + '|' + mode; }

  // Returns the saved session for key if it still matches the deck's cards, else null
  function getSession(state, key, validIds) {
    var s = state.sessions[key];
    if (!s) return null;
    var ok = s.order.length > 0 && s.order.every(function (id) { return validIds[id]; });
    return ok ? s : null;
  }

  function putSession(state, key, order, index, now) {
    state.sessions[key] = { order: order, index: index, t: now || 0 };
    var keys = Object.keys(state.sessions);
    if (keys.length > MAX_SESSIONS) {
      keys.sort(function (a, b) { return (state.sessions[a].t || 0) - (state.sessions[b].t || 0); });
      keys.slice(0, keys.length - MAX_SESSIONS).forEach(function (k) { delete state.sessions[k]; });
    }
    return state.sessions[key];
  }

  // ---------- data helpers ----------
  function indexData(data) {
    var byId = {}, byDeck = {}, deckById = {};
    data.decks.forEach(function (d) { byDeck[d.id] = []; deckById[d.id] = d; });
    data.cards.forEach(function (c) {
      byId[c.id] = c;
      if (byDeck[c.deck]) byDeck[c.deck].push(c);
    });
    return { byId: byId, byDeck: byDeck, deckById: deckById };
  }

  // Categories in first-appearance order, with counts
  function categoriesFor(cards) {
    var order = [], counts = {};
    cards.forEach(function (c) {
      if (!(c.category in counts)) { counts[c.category] = 0; order.push(c.category); }
      counts[c.category]++;
    });
    return order.map(function (name) { return { name: name, count: counts[name] }; });
  }

  function countIn(cards, map) {
    var n = 0;
    for (var i = 0; i < cards.length; i++) if (map[cards[i].id]) n++;
    return n;
  }

  function percent(part, whole) { return whole > 0 ? Math.round(part / whole * 100) : 0; }

  // Fisher–Yates; rand is injectable for deterministic tests
  function shuffle(list, rand) {
    var a = list.slice(), r = rand || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* A study "mode" selects which cards of a deck to show:
     'all' | 'random' | 'review' | 'cat:<category>' */
  function cardsForMode(deckCards, mode, state, rand) {
    if (mode === 'random') return shuffle(deckCards, rand);
    if (mode === 'review') return deckCards.filter(function (c) { return state.marked[c.id]; });
    if (mode && mode.indexOf('cat:') === 0) {
      var cat = mode.slice(4);
      return deckCards.filter(function (c) { return c.category === cat; });
    }
    return deckCards.slice();
  }

  function search(cards, query, deckId) {
    var q = (query || '').trim().toLowerCase();
    if (!q) return [];
    var terms = q.split(/\s+/);
    return cards.filter(function (c) {
      if (deckId && c.deck !== deckId) return false;
      var hay = (c.question + '\n' + c.answer + '\n' + c.category + '\n' + c.reference + '\n' +
        (c.mnemonic || '') + '\n' + (c.glance ? c.glance.join('\n') : '')).toLowerCase();
      for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) === -1) return false;
      return true;
    });
  }

  function progressSummary(data, idx, state) {
    var decks = data.decks.map(function (d) {
      var cards = idx.byDeck[d.id] || [];
      var reviewed = countIn(cards, state.reviewed);
      return { id: d.id, title: d.title, icon: d.icon, total: cards.length, reviewed: reviewed, pct: percent(reviewed, cards.length) };
    });
    var total = 0, reviewed = 0;
    decks.forEach(function (d) { total += d.total; reviewed += d.reviewed; });
    return { decks: decks, total: total, reviewed: reviewed, pct: percent(reviewed, total), marked: countIn(data.cards, state.marked) };
  }

  // ---------- answer formatting ----------
  var MARKER = /^\s*\((\d+|[a-z]|[ivx]+|[A-Z])\)\s*/;
  var ROMAN = /^\s*\((i|ii|iii|iv|v|vi|vii|viii|ix|x)\)/;

  /* Split an answer into display lines [{text, level}].
     Answers that already have line breaks keep them (indent from leading spaces).
     Single-paragraph regulation text gets one line per "(1)"/"(i)" item. */
  function formatAnswer(text) {
    var t = String(text || '');
    var lines;
    if (t.indexOf('\n') === -1) {
      // break before list markers that follow ":" or ";" (optionally "; and" / "; or")
      t = t.replace(/([:;])\s+(?:(?:and|or)\s+)?(\((?:\d+|[a-z]|[ivx]+)\)\s)/g, '$1\n$2');
      lines = t.split('\n');
      var lastTop = null;
      return lines.map(function (line, i) {
        var m = MARKER.exec(line);
        if (!m || i === 0) return { text: line.trim(), level: 0 };
        var isRoman = ROMAN.test(line);
        var level = 1;
        if (isRoman && lastTop === 'digit') level = 2;
        else lastTop = /^\d+$/.test(m[1]) ? 'digit' : 'letter';
        return { text: line.trim(), level: level };
      });
    }
    lines = t.split('\n');
    return lines.map(function (line) {
      var lead = /^( *)/.exec(line)[1].length;
      return { text: line.trim(), level: lead >= 4 ? 2 : lead >= 2 ? 1 : 0 };
    });
  }

  // Split text into [{t, num:true|false}] so key figures can be emphasized
  var NUM_RE = /\b\d[\d,]*(?:\.\d+)?(?:\s|-)?(?:hours?|hrs?|hr|NM|nautical miles|statute miles|SM|days|calendar months|months|minutes|seconds|takeoffs|landings|feet|ft|knots|kts|percent|%|years?)\b|\b\d+%/gi;
  function numberSegments(text) {
    var out = [], last = 0, m;
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(text)) !== null) {
      if (m.index > last) out.push({ t: text.slice(last, m.index), num: false });
      out.push({ t: m[0], num: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ t: text.slice(last), num: false });
    return out;
  }

  // ---------- speech ----------
  var SPEECH_SUBS = [
    [/TIM♥BaCoN/g, 'Tim loves Bacon'], [/♥/g, ' loves '],
    [/§§\s*/g, 'sections '], [/§\s*/g, 'section '],
    [/\b14 CFR\b/g, '14 C F R'], [/\b49 CFR\b/g, '49 C F R'], [/\bCFR\b/g, 'C F R'],
    [/\bCFII\b/g, 'C F I I'], [/\bCFIs\b/g, 'C F Is'], [/\bCFI\b/g, 'C F I'], [/\bPIC\b/g, 'P I C'],
    [/\bXC\b/g, 'cross-country'], [/\bTT\b/g, 'total time'], [/\bNM\b/g, 'nautical miles'],
    [/\bSM\b/g, 'statute miles'], [/\bhrs?\b/g, 'hours'], [/\bASEL\b/g, 'A S E L'], [/\bAMEL\b/g, 'A M E L'],
    [/\bFOI\b/g, 'F O I'], [/\bADM\b/g, 'A D M'], [/\bSRM\b/g, 'S R M'], [/\bCRM\b/g, 'C R M'],
    [/\bDPE\b/g, 'D P E'], [/\bAIH\b/g, 'Aviation Instructor\'s Handbook'], [/\bACS\b/g, 'A C S'],
    [/\bFAA-H-8083-9B\b/g, 'F A A H 8083 9 B'], [/\bAC 61-65K\b/g, 'A C 61 65 K'], [/\bAC 61-65\b/g, 'A C 61 65'],
    [/\bA\.(\d+)\b/g, 'A $1'], [/\be\.g\.,?/g, 'for example,'], [/\bi\.e\.,?/g, 'that is,'], [/\bvs\.?\s/g, 'versus '],
    [/\bw\//g, 'with '], [/→/g, ' to '], [/≥/g, ' at least '], [/≤/g, ' at most '], [/</g, ' less than '], [/>/g, ' more than '],
    [/[•·]/g, ', '], [/\s[–—-]\s/g, ': '], [/[“”"]/g, ''], [/\.\.\./g, '.'],
    [/[☀-➿]|️|‍|[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '']   // emoji and joiners
  ];
  var ROMAN_NUM = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

  function speechText(text) {
    var t = String(text || '');
    // list markers at line starts: "(1) " -> "1. ", "(ii) " -> "2. ", "(a) " -> "a. "
    t = t.replace(/(^|\n)\s*\((\d+|[a-z]{1,4}|[A-Z])\)\s*/g, function (all, pre, m) {
      var r = ROMAN_NUM[m];
      return pre + (r && m.length > 1 ? r : m) + '. ';
    });
    // citation paragraphs: "61.109(a)(1)" -> "61.109 a 1"
    var prev;
    do { prev = t; t = t.replace(/(\d|\b[a-z0-9]{1,4})\(([a-z0-9]{1,4})\)/gi, '$1 $2'); } while (t !== prev);
    SPEECH_SUBS.forEach(function (s) { t = t.replace(s[0], s[1]); });
    return t.replace(/[ \t]+/g, ' ').replace(/ ,/g, ',').trim();
  }

  // Split into utterance-sized chunks (long single utterances get cut off on some browsers)
  function chunkForSpeech(text, maxLen) {
    var max = maxLen || 220, out = [];
    speechText(text).split(/\n+/).forEach(function (para) {
      para = para.trim();
      if (!para) return;
      var sentences = para.match(/[^.!?;:]+[.!?;:]*\s*/g) || [para];
      var buf = '';
      sentences.forEach(function (s) {
        if ((buf + s).length > max && buf) { out.push(buf.trim()); buf = ''; }
        if (s.length > max) {   // very long sentence: break on commas
          s.split(/,\s*/).forEach(function (part) {
            if ((buf + part).length > max && buf) { out.push(buf.trim()); buf = ''; }
            buf += part + ', ';
          });
        } else buf += s;
      });
      if (buf.trim()) out.push(buf.trim().replace(/,\s*$/, '.'));
    });
    return out.filter(function (c) { return /[a-z0-9]/i.test(c); });
  }

  // Basic integrity checks used by the in-browser self-test
  function validateData(data) {
    var errors = [], seen = {};
    if (!data || !data.decks || !data.cards) return ['data missing decks/cards'];
    var deckIds = {};
    data.decks.forEach(function (d) { deckIds[d.id] = true; });
    data.cards.forEach(function (c, i) {
      if (!c.id) errors.push('card #' + i + ' has no id');
      else if (seen[c.id]) errors.push('duplicate id ' + c.id);
      seen[c.id] = true;
      if (!deckIds[c.deck]) errors.push(c.id + ': unknown deck ' + c.deck);
      ['category', 'reference', 'question', 'answer'].forEach(function (f) {
        if (typeof c[f] !== 'string' || !c[f].trim()) errors.push(c.id + ': empty ' + f);
      });
      if (c.glance && !Array.isArray(c.glance)) errors.push(c.id + ': glance must be a list');
    });
    return errors;
  }

  root.Core = {
    STORAGE_KEY: STORAGE_KEY, TEXT_SIZES: TEXT_SIZES, RATES: RATES, THINK: THINK,
    loadState: loadState, saveState: saveState, indexData: indexData,
    studyKey: studyKey, getSession: getSession, putSession: putSession,
    categoriesFor: categoriesFor, countIn: countIn, percent: percent, shuffle: shuffle,
    cardsForMode: cardsForMode, search: search, progressSummary: progressSummary,
    formatAnswer: formatAnswer, numberSegments: numberSegments,
    speechText: speechText, chunkForSpeech: chunkForSpeech, validateData: validateData
  };
})(typeof window !== 'undefined' ? window : this);
