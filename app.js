/* Pilot Oral Exam Flashcards — UI. Hash routes:
   #/                     home (ratings)
   #/deck/<deck>          topics for a rating
   #/study/<deck>/<mode>/<index>   flashcards (mode: all|random|review|cat:<name>)
   #/search?q=&deck=      search
   #/progress  #/resources  #/settings  #/about  #/selftest
   Moving between cards updates the card in place (history.replaceState), so the page never
   reloads mid-session; the card order and position are saved so a reload resumes exactly. */
(function () {
  'use strict';

  var Core = window.Core;
  var REPO = 'https://github.com/Knockoutpie/pilot-flashcards';

  var data = null, idx = null;
  var storage = null;
  try { storage = window.localStorage; } catch (e) { storage = null; }
  var state = Core.loadState(storage);
  var app = document.getElementById('app');
  var teardown = null;      // cleanup for the current screen (stops speech, timers)
  var keyHandler = null;

  // ---------- small DOM helper ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    el.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  function go(hash) { location.hash = hash; }
  function save() { Core.saveState(storage, state); }
  function now() { return Date.now ? Date.now() : 0; }

  function applySettings() {
    document.documentElement.setAttribute('data-theme', state.settings.theme);
    document.documentElement.style.setProperty('--scale', state.settings.textSize);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.settings.theme === 'dark' ? '#1a1a2e' : '#f5f5f5');
  }

  function header(title, subtitle, backHash) {
    var sub = subtitle ? h('p', { class: 'muted', text: subtitle }) : null;
    var el = h('header', { class: 'bar' },
      backHash ? h('button', { class: 'back', 'aria-label': 'Back', onclick: function () { go(backHash); } }, '‹') : null,
      h('div', { class: 'bar-titles' }, h('h1', { text: title }), sub));
    el.setSubtitle = function (t) { if (sub) sub.textContent = t; };
    return el;
  }

  function progressBar(pct) {
    return h('div', { class: 'pbar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('div', { class: 'pfill', style: 'width:' + pct + '%' }));
  }

  // Text with key figures (40 hours, 50 NM, 90 days) emphasized
  function richText(text) {
    return Core.numberSegments(text).map(function (s) {
      return s.num ? h('strong', { class: 'num', text: s.t }) : document.createTextNode(s.t);
    });
  }

  function render(nodes) {
    if (teardown) { var t = teardown; teardown = null; t(); }
    keyHandler = null;
    app.textContent = '';
    append(app, nodes);
    window.scrollTo(0, 0);
  }

  function modeLabel(mode) {
    return mode === 'all' ? 'All Topics' : mode === 'random' ? 'Random' : mode === 'review' ? 'Marked for Review' : mode.slice(4);
  }

  // ---------- speech (Web Speech API) ----------
  var Speech = (function () {
    var synth = window.speechSynthesis;
    var supported = !!(synth && typeof window.SpeechSynthesisUtterance !== 'undefined');
    var token = 0;

    function voices() {
      if (!supported) return [];
      return synth.getVoices().filter(function (v) { return /^en(-|_|$)/i.test(v.lang); });
    }
    function pickVoice() {
      var list = voices();
      var chosen = list.filter(function (v) { return v.voiceURI === state.settings.voice; })[0];
      if (chosen) return chosen;
      // prefer higher-quality voices when the user hasn't chosen one
      return list.filter(function (v) { return /enhanced|premium|natural|neural|siri/i.test(v.name); })[0] ||
        list.filter(function (v) { return v['default']; })[0] || list[0] || null;
    }
    function stop() {
      token++;
      if (supported) { try { synth.cancel(); } catch (e) { /* ignore */ } }
    }
    // Speak chunks in order; onDone runs only if not interrupted
    function say(chunks, onDone) {
      stop();
      if (!supported || !chunks.length) { if (onDone) onDone(); return; }
      var my = token, i = 0, voice = pickVoice();
      function next() {
        if (my !== token) return;
        if (i >= chunks.length) { if (onDone) onDone(); return; }
        var u = new window.SpeechSynthesisUtterance(chunks[i++]);
        if (voice) u.voice = voice;
        u.lang = voice ? voice.lang : 'en-US';
        u.rate = state.settings.rate;
        u.onend = next;
        u.onerror = function () { if (my === token) next(); };
        synth.speak(u);
      }
      next();
    }
    if (supported && synth.addEventListener) synth.addEventListener('voiceschanged', function () { /* list refreshes on next read */ });
    return { supported: supported, say: say, stop: stop, voices: voices };
  })();

  // Pre-filled GitHub issue form (.github/ISSUE_TEMPLATE/card-report.yml) for a card
  function reportUrl(card) {
    var deck = idx.deckById[card.deck];
    var q = 'template=card-report.yml' +
      '&title=' + encodeURIComponent('[' + card.id + '] ' + card.question.slice(0, 70)) +
      '&card=' + encodeURIComponent(card.id + ' — ' + deck.title + ' · ' + card.category) +
      '&question=' + encodeURIComponent(card.question) +
      '&reference=' + encodeURIComponent(card.reference);
    return REPO + '/issues/new?' + q;
  }
  function feedbackUrl() { return REPO + '/issues/new?template=feedback.yml'; }

  function answerSpeechChunks(card) {
    var chunks = [];
    if (card.mnemonic) chunks = chunks.concat(Core.chunkForSpeech('Acronym: ' + card.mnemonic + '.'));
    if (card.glance) chunks = chunks.concat(Core.chunkForSpeech('At a glance. ' + card.glance.join('.\n')));
    else chunks = chunks.concat(Core.chunkForSpeech(card.answer));
    return chunks;
  }

  // ---------- screens ----------
  function viewDisclaimer(firstRun) {
    var sections = [
      ['EDUCATIONAL PURPOSES ONLY', 'This application is provided as a study aid only and should not be used as the sole source of information for pilot training or certification.'],
      ['NO WARRANTY OR GUARANTEE', 'The content is provided "as is" without warranty of any kind. While efforts have been made to ensure accuracy, the information may contain errors, omissions, or become outdated.'],
      ['NOT RESPONSIBLE FOR DECISIONS', 'The developer assumes no responsibility or liability for any decisions, actions, or outcomes resulting from the use of this application. Users are solely responsible for verifying all information with official FAA sources and current regulations.'],
      ['OFFICIAL SOURCES REQUIRED', 'Always consult current FAA publications, Federal Aviation Regulations (FARs), Aeronautical Information Manual (AIM), and your certified flight instructor for official and up-to-date information.'],
      ['PUBLIC DOMAIN CONTENT', 'All content in this app cites official FAA publications, Federal Aviation Regulations (FARs), and the Aeronautical Information Manual (AIM) - all U.S. government works in the public domain. The developer makes no proprietary claim to FAA regulations or procedures. You are free to use, share, and learn from this factual aviation information.'],
      ['USE AT YOUR OWN RISK', 'By using this application, you acknowledge that you understand and accept these terms and agree to use this app at your own risk.']
    ];
    render([
      header('⚠️ Important Disclaimer', null, firstRun ? null : '#/'),
      h('main', { class: 'content' },
        h('div', { class: 'panel disclaimer' }, sections.map(function (s) {
          return [h('h3', { text: s[0] }), h('p', { text: s[1] })];
        })),
        firstRun ? h('button', { class: 'btn primary block', onclick: function () { state.accepted = true; save(); go('#/'); route(); } }, 'I Understand and Accept') : null,
        h('p', { class: 'muted center small', text: 'Content sourced from official FAA publications (public domain)' }))
    ]);
  }

  function deckTile(title, subtitle, reviewed, total, onclick) {
    return h('button', { class: 'card rating', onclick: onclick },
      h('div', { class: 'rating-left' },
        h('div', { class: 'rating-title', text: title }),
        h('div', { class: 'muted small', text: subtitle })),
      h('div', { class: 'rating-right' },
        h('div', { class: 'count', text: reviewed + '/' + total }),
        h('div', { class: 'muted tiny', text: 'reviewed' })));
  }

  var CFI_IDS = ['cfi-foi', 'cfi-acronyms', 'cfi-regs'];

  function viewHome() {
    var summary = Core.progressSummary(data, idx, state);
    var byId = {};
    summary.decks.forEach(function (d) { byId[d.id] = d; });
    var cfi = { reviewed: 0, total: 0 };
    CFI_IDS.forEach(function (id) { cfi.reviewed += byId[id].reviewed; cfi.total += byId[id].total; });
    var tiles = [];
    data.decks.forEach(function (d) {
      if (CFI_IDS.indexOf(d.id) !== -1) {
        if (d.id === CFI_IDS[0]) tiles.push(deckTile('🎓 CFI Certificate', 'FOI · Acronyms · Regulations', cfi.reviewed, cfi.total, function () { go('#/cfi'); }));
        return;
      }
      var s = byId[d.id];
      tiles.push(deckTile(d.icon + ' ' + d.title, d.subtitle, s.reviewed, s.total, function () { go('#/deck/' + d.id); }));
    });
    render([
      h('header', { class: 'hero' },
        h('h1', { text: '✈️ Pilot Oral Exam Flashcards' }),
        h('p', { class: 'muted', text: 'Private · Instrument · Commercial · CFI · Multi · Sea · Tailwheel' })),
      h('main', { class: 'content' },
        h('nav', { class: 'quick' },
          h('button', { class: 'chip', onclick: function () { go('#/search'); } }, '🔍 Search'),
          h('button', { class: 'chip', onclick: function () { go('#/progress'); } }, '📊 Progress'),
          h('button', { class: 'chip', onclick: function () { go('#/resources'); } }, '📚 FAA Resources'),
          h('button', { class: 'chip', onclick: function () { go('#/settings'); } }, '⚙️ Settings')),
        tiles,
        h('footer', { class: 'foot' },
          h('a', { href: feedbackUrl(), target: '_blank', rel: 'noopener' }, '💬 Send feedback or report an error'),
          h('a', { href: '#/about' }, '⚠️ Disclaimer')))
    ]);
  }

  function viewCfi() {
    var summary = Core.progressSummary(data, idx, state);
    var byId = {};
    summary.decks.forEach(function (d) { byId[d.id] = d; });
    render([
      header('🎓 CFI Certificate', 'Choose a section', '#/'),
      h('main', { class: 'content' },
        CFI_IDS.map(function (id) {
          var d = idx.deckById[id], s = byId[id];
          return deckTile(d.icon + ' ' + d.title, d.subtitle, s.reviewed, s.total, function () { go('#/deck/' + id); });
        }))
    ]);
  }

  function deckValidIds(deckId) {
    var ok = {};
    idx.byDeck[deckId].forEach(function (c) { ok[c.id] = true; });
    return ok;
  }

  // Most recent unfinished session in this deck, for the "Continue" button
  function latestSession(deckId) {
    var best = null, valid = deckValidIds(deckId);
    Object.keys(state.sessions).forEach(function (key) {
      if (key.indexOf(deckId + '|') !== 0) return;
      var s = Core.getSession(state, key, valid);
      if (!s || s.index === 0) return;   // not started yet
      if (!best || (s.t || 0) > (best.s.t || 0)) best = { key: key, s: s, mode: key.slice(deckId.length + 1) };
    });
    return best;
  }

  function viewDeck(deckId) {
    var deck = idx.deckById[deckId];
    if (!deck) return go('#/');
    var cards = idx.byDeck[deckId];
    var marked = Core.countIn(cards, state.marked);
    var reviewed = Core.countIn(cards, state.reviewed);
    var cont = latestSession(deckId);
    render([
      header(deck.icon + ' ' + deck.title, reviewed + ' of ' + cards.length + ' reviewed', '#/'),
      h('main', { class: 'content' },
        cont ? h('button', { class: 'card continue', onclick: function () {
          go('#/study/' + deckId + '/' + encodeURIComponent(cont.mode) + '/' + cont.s.index);
        } },
          h('div', { class: 'cat-title', text: '▶ Continue where you left off' }),
          h('div', { class: 'muted small', text: modeLabel(cont.mode) + ' · card ' + (cont.s.index + 1) + ' of ' + cont.s.order.length })) : null,
        h('div', { class: 'row2' },
          h('button', { class: 'btn primary', onclick: function () { startStudy(deckId, 'all'); } }, '📖 All Topics'),
          h('button', { class: 'btn warn', onclick: function () { startStudy(deckId, 'random'); } }, '🔀 New Random')),
        h('button', { class: 'card', disabled: marked === 0, onclick: function () { startStudy(deckId, 'review'); } },
          h('div', { class: 'cat-title', text: '⭐ Marked for Review' }),
          h('div', { class: 'muted small', text: marked + ' cards marked' })),
        h('button', { class: 'card', onclick: function () { go('#/search?deck=' + deckId); } },
          h('div', { class: 'cat-title', text: '🔍 Search this rating' })),
        h('h2', { class: 'section', text: 'Topics' }),
        Core.categoriesFor(cards).map(function (cat) {
          var catCards = cards.filter(function (c) { return c.category === cat.name; });
          var done = Core.countIn(catCards, state.reviewed);
          return h('button', { class: 'card', onclick: function () { startStudy(deckId, 'cat:' + cat.name); } },
            h('div', { class: 'cat-title', text: cat.name }),
            h('div', { class: 'muted small', text: done + ' / ' + cat.count + ' reviewed' }),
            progressBar(Core.percent(done, cat.count)));
        }))
    ]);
  }

  // Buttons on the deck page always start fresh (a new shuffle for Random)
  function startStudy(deckId, mode) {
    var order = Core.cardsForMode(idx.byDeck[deckId], mode, state).map(function (c) { return c.id; });
    Core.putSession(state, Core.studyKey(deckId, mode), order, 0, now());
    save();
    go('#/study/' + deckId + '/' + encodeURIComponent(mode) + '/0');
  }

  function viewStudy(deckId, mode, startIndex) {
    var deck = idx.deckById[deckId];
    if (!deck) return go('#/');
    var key = Core.studyKey(deckId, mode);
    var session = Core.getSession(state, key, deckValidIds(deckId));
    if (!session) {   // deep link with no saved session: build one
      session = Core.putSession(state, key, Core.cardsForMode(idx.byDeck[deckId], mode, state).map(function (c) { return c.id; }), 0, now());
      save();
    }
    var order = session.order;
    var base = '#/study/' + deckId + '/' + encodeURIComponent(mode) + '/';
    if (!order.length) {
      return render([header(deck.title, null, '#/deck/' + deckId),
        h('main', { class: 'content' }, h('p', { class: 'muted center', text: 'No cards here yet.' }))]);
    }

    var index = 0, card = null, revealed = false, listening = false, reading = false, timer = null;
    var hdr = header(deck.icon + ' ' + deck.title, modeLabel(mode), '#/deck/' + deckId);
    var bar = h('div', { class: 'pfill' });
    var cardSlot = h('div', { class: 'card-slot' });
    var prevBtn = h('button', { class: 'btn', onclick: function () { stopListening(); move(-1); } }, '◀ Previous');
    var nextBtn = h('button', { class: 'btn', onclick: function () { stopListening(); move(1); } }, 'Next ▶');
    var markBtn = h('button', { class: 'btn icon', onclick: toggleMark });
    // Read = this card only; Listen = hands-free through every card
    var readBtn = Speech.supported ? h('button', { class: 'btn icon', 'aria-label': 'Read this card aloud', onclick: function () {
      if (reading) { stopReading(); return; }
      stopListening(); readCard();
    } }, '🔊 Read card') : null;
    var listenBtn = Speech.supported ? h('button', { class: 'btn block listen', onclick: function () { if (listening) stopListening(); else startListening(); } },
      '🎧 Listen to all cards (hands-free)') : null;
    var listenStatus = h('span', { class: 'listen-status' });
    var listenBar = Speech.supported ? h('div', { class: 'listen-bar', hidden: true, role: 'status' },
      listenStatus, h('button', { class: 'btn small-btn', onclick: function () { stopListening(); } }, '⏹ Stop')) : null;
    var reportLink = h('a', { class: 'report', target: '_blank', rel: 'noopener' }, '🚩 Report a problem with this card');
    var quizBtn = h('button', { class: 'seg', onclick: function () { setMode('quiz'); } }, '❓ Quiz');
    var studyBtn = h('button', { class: 'seg', onclick: function () { setMode('study'); } }, '👀 Study');
    var revealBtn, answerBox;

    function setMode(m) {
      state.settings.studyMode = m; save();
      paintModeToggle();
      if (m === 'study') showAnswer(); else if (!listening) showCard(index);
    }
    function paintModeToggle() {
      var q = state.settings.studyMode === 'quiz';
      quizBtn.className = 'seg' + (q ? ' on' : ''); quizBtn.setAttribute('aria-pressed', q ? 'true' : 'false');
      studyBtn.className = 'seg' + (q ? '' : ' on'); studyBtn.setAttribute('aria-pressed', q ? 'false' : 'true');
    }
    function paintMark() {
      var on = !!state.marked[card.id];
      markBtn.textContent = on ? '⭐ Marked' : '☆ Mark';
      markBtn.className = 'btn icon' + (on ? ' on' : '');
      markBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    function toggleMark() {
      if (state.marked[card.id]) delete state.marked[card.id]; else state.marked[card.id] = 1;
      save(); paintMark();
    }
    function showAnswer() {
      if (revealed) return;
      revealed = true;
      answerBox.hidden = false;
      revealBtn.hidden = true;
      if (!state.reviewed[card.id]) { state.reviewed[card.id] = 1; save(); }
    }

    function buildAnswer(c) {
      var lines = Core.formatAnswer(c.answer).map(function (l) {
        return l.text ? h('div', { class: 'line l' + l.level }, richText(l.text)) : h('div', { class: 'gap' });
      });
      return h('div', { class: 'answer', hidden: true },
        c.mnemonic ? h('div', { class: 'mnemonic', text: '🧠 ' + c.mnemonic }) : null,
        c.glance ? h('div', { class: 'glance' },
          h('div', { class: 'glance-title', text: '📌 At a glance' }),
          h('ul', null, c.glance.map(function (g) { return h('li', null, richText(g)); }))) : null,
        c.glance ? h('div', { class: 'full-label muted tiny', text: 'Full text' }) : null,
        h('div', { class: 'answer-text' }, lines));
    }

    function showCard(i) {
      index = Math.max(0, Math.min(order.length - 1, i));
      card = idx.byId[order[index]];
      revealed = false;
      revealBtn = h('button', { class: 'btn primary block', onclick: showAnswer }, 'Tap to Reveal Answer');
      answerBox = buildAnswer(card);
      var el = h('article', { class: 'flash', onclick: function (ev) { if (!revealed && ev.target.tagName !== 'BUTTON') showAnswer(); } },
        h('div', { class: 'flash-meta' },
          h('span', { class: 'tag', text: card.category }),
          h('span', { class: 'muted tiny', text: (index + 1) + ' / ' + order.length })),
        h('h2', { class: 'question', text: card.question }),
        h('p', { class: 'ref', text: '📖 ' + card.reference }),
        revealBtn,
        answerBox);
      cardSlot.textContent = '';
      cardSlot.appendChild(el);
      if (state.settings.studyMode === 'study') showAnswer();
      bar.style.width = Core.percent(index + 1, order.length) + '%';
      prevBtn.disabled = index === 0;
      nextBtn.disabled = index === order.length - 1;
      paintMark();
      reportLink.setAttribute('href', reportUrl(card));
      if (listening) listenStatus.textContent = '🎧 Listening · card ' + (index + 1) + ' of ' + order.length;
      // remember position; update the address without navigating (no reload, no flash)
      session.index = index; session.t = now(); save();
      try { history.replaceState(null, '', base + index); } catch (e) { /* ignore */ }
      window.scrollTo(0, 0);
    }

    function move(delta) {
      var next = index + delta;
      if (next < 0 || next >= order.length) return;
      stopReading();
      Speech.stop();
      showCard(next);
    }

    function paintRead(on) {
      reading = on;
      if (!readBtn) return;
      readBtn.textContent = on ? '⏹ Stop' : '🔊 Read card';
      readBtn.className = 'btn icon' + (on ? ' on' : '');
    }
    function stopReading() {
      if (!reading) return;
      paintRead(false);
      Speech.stop();
    }
    // Reads only the current card: question, then the answer
    function readCard() {
      paintRead(true);
      Speech.say(Core.chunkForSpeech('Question. ' + card.question), function () {
        showAnswer();
        Speech.say(answerSpeechChunks(card), function () { paintRead(false); });
      });
    }

    function startListening() {
      stopReading();
      listening = true;
      listenBtn.hidden = true;
      listenBar.hidden = false;
      listenStatus.textContent = '🎧 Listening · card ' + (index + 1) + ' of ' + order.length;
      playCard();
    }
    function stopListening() {
      if (!listening) return;
      listening = false;
      clearTimeout(timer);
      Speech.stop();
      if (listenBtn) { listenBtn.hidden = false; listenBar.hidden = true; }
    }
    // Hands-free: question → think pause → answer → next card
    function playCard() {
      if (!listening) return;
      Speech.say(Core.chunkForSpeech('Question. ' + card.question), function () {
        if (!listening) return;
        var wait = revealed ? 400 : state.settings.think * 1000;
        timer = setTimeout(function () {
          if (!listening) return;
          showAnswer();
          Speech.say(answerSpeechChunks(card), function () {
            if (!listening) return;
            timer = setTimeout(function () {
              if (!listening) return;
              if (index >= order.length - 1) { stopListening(); return; }
              showCard(index + 1);
              playCard();
            }, 1500);
          });
        }, wait);
      });
    }

    // swipe left/right to navigate
    var sx = null, sy = null;
    cardSlot.addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    cardSlot.addEventListener('touchend', function (e) {
      if (sx === null) return;
      var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      sx = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { stopListening(); move(dx < 0 ? 1 : -1); }
    });

    render([
      hdr,
      h('main', { class: 'content study' },
        h('div', { class: 'study-top' },
          h('div', { class: 'segs modes', role: 'group', 'aria-label': 'Study mode' }, quizBtn, studyBtn)),
        listenBar,
        h('div', { class: 'pbar thin' }, bar),
        cardSlot,
        h('div', { class: 'tools' }, markBtn, readBtn),
        h('div', { class: 'row2 nav' }, prevBtn, nextBtn),
        listenBtn,
        h('p', { class: 'muted tiny center hint', text: Speech.supported
          ? 'Swipe or ← → · Space reveals · M marks · R reads this card · L listens to all'
          : 'Swipe or ← → · Space reveals · M marks' }),
        h('p', { class: 'center small' }, reportLink))
    ]);
    paintModeToggle();
    showCard(startIndex === undefined ? session.index : startIndex);

    teardown = function () { listening = false; reading = false; clearTimeout(timer); Speech.stop(); };
    keyHandler = function (e) {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight') { stopListening(); move(1); }
      else if (e.key === 'ArrowLeft') { stopListening(); move(-1); }
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); showAnswer(); }
      else if (e.key === 'm' || e.key === 'M') toggleMark();
      else if ((e.key === 'r' || e.key === 'R') && Speech.supported) { if (reading) stopReading(); else { stopListening(); readCard(); } }
      else if ((e.key === 'l' || e.key === 'L') && Speech.supported) { if (listening) stopListening(); else startListening(); }
    };
  }

  function viewSearch(query, deckId) {
    var deck = deckId ? idx.deckById[deckId] : null;
    var input = h('input', { type: 'search', class: 'search', placeholder: 'Search questions, answers, mnemonics...', value: query || '', 'aria-label': 'Search' });
    var results = h('div', { class: 'results' });
    function run() {
      var q = input.value;
      var found = Core.search(data.cards, q, deckId);
      results.textContent = '';
      if (!q.trim()) { append(results, h('p', { class: 'muted center', text: 'Enter a search term to find cards' })); return; }
      if (!found.length) { append(results, h('p', { class: 'muted center', text: 'No cards found for "' + q + '"' })); return; }
      append(results, h('p', { class: 'muted small', text: found.length + ' result' + (found.length === 1 ? '' : 's') }));
      found.slice(0, 200).forEach(function (c) {
        var d = idx.deckById[c.deck];
        append(results, h('button', { class: 'card', onclick: function () { openCard(c); } },
          h('div', { class: 'muted tiny', text: d.icon + ' ' + d.title + ' · ' + c.category }),
          h('div', { class: 'cat-title', text: c.question })));
      });
      try { history.replaceState(null, '', '#/search?q=' + encodeURIComponent(q) + (deckId ? '&deck=' + deckId : '')); } catch (e) { /* ignore */ }
    }
    var timer = null;
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 150); });
    render([
      header('🔍 Search', deck ? deck.title : 'All ratings', deck ? '#/deck/' + deck.id : '#/'),
      h('main', { class: 'content' }, input, results)
    ]);
    run();
    input.focus();
  }

  function openCard(c) {
    var order = idx.byDeck[c.deck].map(function (x) { return x.id; });
    var i = order.indexOf(c.id);
    Core.putSession(state, Core.studyKey(c.deck, 'all'), order, i, now());
    save();
    go('#/study/' + c.deck + '/all/' + i);
  }

  function viewProgress() {
    var s = Core.progressSummary(data, idx, state);
    render([
      header('📊 Your Progress', null, '#/'),
      h('main', { class: 'content' },
        h('div', { class: 'stats' },
          h('div', { class: 'panel stat' }, h('div', { class: 'big', text: s.pct + '%' }), h('div', { class: 'muted small', text: s.reviewed + ' of ' + s.total + ' reviewed' })),
          h('div', { class: 'panel stat' }, h('div', { class: 'big warn-text', text: String(s.marked) }), h('div', { class: 'muted small', text: 'marked for review' }))),
        h('h2', { class: 'section', text: 'By Rating' }),
        s.decks.map(function (d) {
          return h('button', { class: 'card', onclick: function () { go('#/deck/' + d.id); } },
            h('div', { class: 'cat-title', text: d.icon + ' ' + d.title }),
            h('div', { class: 'muted small', text: d.reviewed + ' / ' + d.total + ' reviewed (' + d.pct + '%)' }),
            progressBar(d.pct));
        }),
        h('button', { class: 'btn danger block', onclick: function () {
          if (confirm('Reset all progress? This clears which cards you have reviewed.')) { state.reviewed = {}; state.sessions = {}; save(); viewProgress(); }
        } }, 'Reset All Progress'),
        h('button', { class: 'btn danger block', onclick: function () {
          if (confirm('Clear all cards marked for review?')) { state.marked = {}; save(); viewProgress(); }
        } }, 'Clear Marked for Review'))
    ]);
  }

  function viewResources() {
    render([
      header('📚 FAA Resources', 'Tap to open official FAA publications', '#/'),
      h('main', { class: 'content' },
        h('div', { class: 'grid' }, data.resources.map(function (r) {
          return h('a', { class: 'res', href: r.url, target: '_blank', rel: 'noopener' },
            r.image ? h('img', { src: r.image, alt: '', loading: 'lazy' })
              : h('div', { class: 'res-icon', style: 'background:' + r.color, text: r.icon }),
            h('div', { class: 'res-title', text: r.title }),
            h('div', { class: 'muted tiny', text: r.subtitle }));
        })),
        h('p', { class: 'muted center small', text: 'All resources link to official FAA websites' }))
    ]);
  }

  function viewSettings() {
    function option(label, active, onclick) {
      return h('button', { class: 'seg' + (active ? ' on' : ''), 'aria-pressed': active ? 'true' : 'false', onclick: onclick }, label);
    }
    function set(field, value, apply) {
      return function () { state.settings[field] = value; save(); if (apply) applySettings(); viewSettings(); };
    }
    var sizes = [['Small', 0.85], ['Medium', 1], ['Large', 1.15], ['X-Large', 1.3]];
    var voicePanel = null;
    if (Speech.supported) {
      var voices = Speech.voices();
      var select = h('select', { class: 'search', 'aria-label': 'Voice', onchange: function () { state.settings.voice = select.value; save(); } },
        h('option', { value: '', text: 'Automatic (best available)' }),
        voices.map(function (v) {
          return h('option', { value: v.voiceURI, selected: v.voiceURI === state.settings.voice, text: v.name + ' (' + v.lang + ')' });
        }));
      voicePanel = h('div', { class: 'panel' }, h('h3', { text: '🔊 Read-aloud' }),
        h('div', { class: 'muted small', text: 'Voice' }), select,
        voices.length ? null : h('p', { class: 'muted tiny', text: 'Voices appear after the first read on some phones — come back here after tapping Read once.' }),
        h('div', { class: 'muted small', text: 'Speed' }),
        h('div', { class: 'segs' }, Core.RATES.map(function (r) { return option(r + '×', state.settings.rate === r, set('rate', r)); })),
        h('div', { class: 'muted small spaced', text: 'Listen mode: thinking time before the answer' }),
        h('div', { class: 'segs' }, Core.THINK.map(function (t) { return option(t + 's', state.settings.think === t, set('think', t)); })),
        h('button', { class: 'btn block spaced', onclick: function () {
          Speech.say(Core.chunkForSpeech('This is how flashcards will sound. A commercial pilot needs 250 hours total time, 100 hours PIC, and 50 hours XC under 14 CFR §61.129.'));
        } }, '▶ Test voice'),
        h('p', { class: 'muted tiny', text: 'iPhone tip: better voices are in Settings → Accessibility → Spoken Content → Voices → English. Download an "Enhanced" or "Premium" voice, then pick it here.' }));
    }
    render([
      header('⚙️ Settings', null, '#/'),
      h('main', { class: 'content' },
        h('div', { class: 'panel' }, h('h3', { text: 'Cards open in' }),
          h('div', { class: 'segs' },
            option('❓ Quiz (tap to reveal)', state.settings.studyMode === 'quiz', set('studyMode', 'quiz')),
            option('👀 Study (answers shown)', state.settings.studyMode === 'study', set('studyMode', 'study')))),
        h('div', { class: 'panel' }, h('h3', { text: 'Text Size' }),
          h('div', { class: 'segs' }, sizes.map(function (s) { return option(s[0], state.settings.textSize === s[1], set('textSize', s[1], true)); }))),
        h('div', { class: 'panel' }, h('h3', { text: 'Theme' }),
          h('div', { class: 'segs' },
            option('🌙 Dark', state.settings.theme === 'dark', set('theme', 'dark', true)),
            option('☀️ Light', state.settings.theme === 'light', set('theme', 'light', true)))),
        voicePanel,
        h('p', { class: 'muted small center' }, h('a', { href: '#/selftest' }, 'Run self-test')))
    ]);
  }

  function viewSelfTest() {
    var results = [];
    function check(name, fn) {
      try { var r = fn(); results.push([name, r === true, r === true ? '' : String(r)]); }
      catch (e) { results.push([name, false, e && e.message ? e.message : String(e)]); }
    }
    check('Card data is valid', function () { var e = Core.validateData(data); return e.length ? e.slice(0, 5).join('; ') : true; });
    check('Every rating has cards', function () {
      var empty = data.decks.filter(function (d) { return !idx.byDeck[d.id].length; }).map(function (d) { return d.id; });
      return empty.length ? 'empty: ' + empty.join(', ') : true;
    });
    check('CFI FOI, acronyms, and regulations decks present', function () {
      var missing = ['cfi-foi', 'cfi-acronyms', 'cfi-regs'].filter(function (d) { return !(idx.byDeck[d] && idx.byDeck[d].length); });
      return missing.length ? 'missing: ' + missing.join(', ') : true;
    });
    check('Search finds REEPIR', function () { return Core.search(data.cards, 'reepir').length > 0 ? true : 'no hits'; });
    check('Hour requirements split into lines', function () {
      var c = idx.byId['commercial-2'];
      return !c || Core.formatAnswer(c.answer).length >= 3 ? true : 'not split';
    });
    check('Storage writes and reads', function () {
      if (!storage) return 'localStorage unavailable (progress will not be saved)';
      var probe = '__pofc_probe';
      storage.setItem(probe, '1'); var ok = storage.getItem(probe) === '1'; storage.removeItem(probe);
      return ok ? true : 'read-back failed';
    });
    check('Read-aloud available', function () {
      if (!Speech.supported) return 'This browser has no speech synthesis';
      return Speech.voices().length ? true : 'No English voices loaded yet (tap Read once, then re-run)';
    });
    check('Every screen renders', function () {
      var saved = location.hash, savedSessions = JSON.stringify(state.sessions);
      viewHome(); viewDeck('cfi-foi'); viewDeck('cfi-regs'); viewProgress(); viewResources(); viewSettings();
      viewStudy('cfi-regs', 'all', 0);
      render([]);
      state.sessions = JSON.parse(savedSessions); save();
      history.replaceState(null, '', saved);
      return true;
    });
    var passed = results.filter(function (r) { return r[1]; }).length;
    render([
      header('🧪 Self-test', passed + ' / ' + results.length + ' passed', '#/settings'),
      h('main', { class: 'content' },
        results.map(function (r) {
          return h('div', { class: 'panel test ' + (r[1] ? 'pass' : 'fail') },
            h('strong', { text: (r[1] ? '✅ ' : '❌ ') + r[0] }), r[2] ? h('div', { class: 'muted small', text: r[2] }) : null);
        }),
        h('p', { class: 'muted small center', text: data.cards.length + ' cards · ' + data.decks.length + ' ratings' }))
    ]);
  }

  // ---------- router ----------
  document.addEventListener('keydown', function (e) { if (keyHandler) keyHandler(e); });

  function route() {
    var hash = location.hash.replace(/^#/, '') || '/';
    var qpos = hash.indexOf('?');
    var path = qpos === -1 ? hash : hash.slice(0, qpos);
    var params = {};
    if (qpos !== -1) {
      hash.slice(qpos + 1).split('&').forEach(function (kv) {
        var p = kv.split('=');
        if (p[0]) params[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' '));
      });
    }
    var parts = path.split('/').filter(Boolean);
    if (!state.accepted && parts[0] !== 'about') return viewDisclaimer(true);
    switch (parts[0]) {
      case undefined: return viewHome();
      case 'deck': return viewDeck(parts[1]);
      case 'cfi': return viewCfi();
      case 'study': {
        var i = parseInt(parts[3], 10);
        return viewStudy(parts[1], decodeURIComponent(parts[2] || 'all'), isNaN(i) ? undefined : i);
      }
      case 'search': return viewSearch(params.q, params.deck);
      case 'progress': return viewProgress();
      case 'resources': return viewResources();
      case 'settings': return viewSettings();
      case 'about': return viewDisclaimer(!state.accepted);
      case 'selftest': return viewSelfTest();
      default: go('#/');
    }
  }

  function showError(msg) {
    render(h('main', { class: 'content' }, h('div', { class: 'panel test fail' },
      h('strong', { text: 'Could not load flashcards' }), h('p', { class: 'muted small', text: msg }))));
  }

  applySettings();
  fetch('data/cards.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status + ' loading data/cards.json'); return r.json(); })
    .then(function (json) {
      data = json;
      idx = Core.indexData(data);
      window.addEventListener('hashchange', route);
      route();
    })
    .catch(function (e) { showError(e && e.message ? e.message : String(e)); });
})();
