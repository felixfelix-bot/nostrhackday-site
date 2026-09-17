/**
 * viz.js — "watch your npub being ground" visualisation.
 *
 * Style follows the existing asymmetric-vanity-npubs demo: the npub is rendered
 * character by character into three zones,
 *
 *   npub1 | n0s | 7k3q | <tail>
 *          ^     ^      ^
 *          |     |      └ muted: irrelevant tail, easy to fake, never worth checking
 *          |     └ ORANGE anti-phish zone: the chars you actually eyeball when
 *          |       verifying a claim — NOT covered by the proof of work
 *          └ GREEN vanity zone: the mined leet prefix; each matched char is
 *            5 bits of real, verifiable work (this is the part an attacker
 *            cannot fake for free)
 *
 * Above the headline a STRIP shows the two visible halves of the open floor:
 * the first `vanityChars` positions of the target word (mined as an exact
 * leet prefix, solid green once matched) and the "hackday" tail represented by
 * the RAINDROP — the low-entropy window (`DEFAULT_PARAMS.windowSize` characters
 * with at most `DEFAULT_PARAMS.maxUnique` distinct ones), drawn ringed around
 * the minted npub with a `6 unique in 9 · rarity 2.0` style badge.
 *
 * The panel keeps only what can be explained in one breath: the "mining toward
 * …" strip (green = matched so far), the progress bar under it, the live stats
 * and — once the key exists — the mined npub with its green/orange zones, the
 * raindrop ring and the nsec handover.
 *
 * The 2D character fingerprint grid and the rolling log of raw attempts were
 * pulled on 2026-09-17: too much at once to talk over, and it needs a proper
 * demo. `viz.push()` now only advances the strip.
 */
import { DEFAULT_PARAMS, lowEntropyLabel } from './pow-ratchet.js';

/** Zone layout: how many characters after the minted prefix get the orange box. */
export const ANTI_PHISH_CHARS = 4;

/**
 * bech32 charset (the npub body alphabet). A character's index in this string
 * decides its colour — nothing else does, so the map is global and stable.
 */
export const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** Tiny DOM helper — `el('span', 'grind-state', 'some text')`. */
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The npub body (everything after `npub1`) of a candidate. */
function npubBody(npub) {
  if (typeof npub !== 'string') return '';
  return npub.startsWith('npub1') ? npub.slice(5) : npub;
}

/**
 * The target word the floor is spelled from — ALWAYS the shipped value, so the
 * strip cannot drift from what verifyRsvp actually enforces.
 */
export const TARGET_WORD = DEFAULT_PARAMS.vanityTarget;

/**
 * Render the FULL target word as a mined/unmined progress strip.
 *
 * `matched` leading characters are solid green (that many chars are now real,
 * verifiable work), the not-yet-matched remainder is rendered muted && dashed.
 * Content is set from DEFAULT_PARAMS.vanityTarget — never from page markup.
 *
 * @param {HTMLElement} host the `#target-word` span to fill
 * @param {number} matched how many leading characters are already mined
 * @param {string} [word=DEFAULT_PARAMS.vanityTarget]
 * @returns {HTMLElement} the host, for chaining
 */
export function renderTargetStrip(host, matched = 0, word = TARGET_WORD) {
  if (!host) return host;
  const count = Math.max(0, Math.min(matched, word.length));
  host.replaceChildren(
    ...Array.from(word, (c, i) => {
      const cls = i < count ? 'target-char target-char-mined' : 'target-char target-char-pending';
      return el('span', cls, c);
    }),
  );
  host.setAttribute('aria-label', `${count} of ${word.length} characters of "${word}" mined`);
  const countNode = host.parentElement?.querySelector('.target-count');
  if (countNode) countNode.textContent = `${count}/${word.length}`;
  host.dataset.matched = String(count);
  return host;
}

/**
 * Split an npub into its display zones.
 * @param {string} npub
 * @param {{chars?: number, floor?: number, antiPhish?: number}} opts
 *   chars = longest leet-prefix match, floor = chars the visitor must match,
 *   antiPhish = width of the orange zone.
 */
export function npubParts(npub, { chars = 0, floor = 0, antiPhish = ANTI_PHISH_CHARS } = {}) {
  const body = npubBody(npub);
  const matched = Math.max(0, Math.min(chars, body.length));
  const zoneWidth = Math.max(matched, Math.min(floor, body.length));
  return {
    prefix: 'npub1',
    vanity: body.slice(0, matched),
    vanityPending: body.slice(matched, zoneWidth),
    antiPhish: body.slice(zoneWidth, zoneWidth + antiPhish),
    tail: body.slice(zoneWidth + antiPhish),
  };
}

/** Render one npub as zone spans (used for rows and for the headline npub).
 *  Pass opts.window = { start, length, label } (body coordinates) to ring the
 *  low-entropy raindrop window wherever it overlaps the shown characters. */
export function renderNpub(npub, opts = {}, tagName = 'span') {
  const parts = npubParts(npub, opts);
  const body = npubBody(npub);
  const host = el(tagName, 'npub');
  host.appendChild(el('span', 'npub-prefix', parts.prefix));

  const zones = [
    { cls: 'npub-vanity', s: 0, e: parts.vanity.length },
    { cls: 'npub-vanity-pending', s: parts.vanity.length, e: parts.vanity.length + parts.vanityPending.length },
    {
      cls: 'npub-antiphish',
      s: parts.vanity.length + parts.vanityPending.length,
      e: parts.vanity.length + parts.vanityPending.length + parts.antiPhish.length,
    },
    { cls: 'npub-tail', s: body.length - parts.tail.length, e: body.length },
  ];

  let ws = -1;
  let we = -1;
  const win = opts.window;
  if (win && Number.isFinite(win.start) && win.length > 0) {
    ws = Math.max(0, Math.min(win.start, body.length));
    we = Math.min(body.length, ws + Math.max(0, Math.floor(win.length)));
  }

  const breakpoints = new Set([0, body.length]);
  for (const z of zones) {
    breakpoints.add(z.s);
    breakpoints.add(z.e);
  }
  if (ws >= 0) {
    breakpoints.add(ws);
    breakpoints.add(we);
  }
  const points = [...breakpoints].sort((a, b) => a - b);
  const segments = [];
  for (let k = 0; k < points.length - 1; k += 1) {
    const s = points[k];
    const e = points[k + 1];
    if (e <= s) continue;
    const classes = [];
    for (const z of zones) if (s >= z.s && e <= z.e) classes.push(z.cls);
    const inWindow = ws >= 0 && s >= ws && e <= we;
    if (!classes.length) continue;
    segments.push({ text: body.slice(s, e), classes, inWindow });
  }

  // Consecutive window segments are wrapped in ONE `npub-window` element so the
  // raindrop ring stays a single continuous outline even when the window
  // straddles a zone boundary (vanity → orange → tail).
  for (let i = 0; i < segments.length;) {
    const seg = segments[i];
    if (!seg.inWindow) {
      host.appendChild(el('span', seg.classes.join(' '), seg.text));
      i += 1;
      continue;
    }
    const ring = el('span', 'npub-window');
    while (i < segments.length && segments[i].inWindow) {
      const part = segments[i];
      ring.appendChild(el('span', `${part.classes.join(' ')} npub-window-part`, part.text));
      i += 1;
    }
    if (win?.label) {
      ring.title = win.label;
      ring.setAttribute('aria-label', `raindrop window: ${win.label}`);
    }
    host.appendChild(ring);
  }
  return host;
}

/**
 * Build the grinding visualisation.
 *
 * @param {HTMLElement} root
 * @param {{floor?: number, antiPhish?: number, rows?: number, target?: string,
 *          windowSize?: number}} opts
 */
export function createGrindViz(
  root,
  {
    floor = DEFAULT_PARAMS.vanityChars,
    antiPhish = ANTI_PHISH_CHARS,
    rows = 12,
    target = DEFAULT_PARAMS.vanityTarget,
    windowSize = DEFAULT_PARAMS.windowSize,
  } = {},
) {
  root.classList.add('grind-viz');

  const head = el('div', 'grind-head');
  // ONE title line, and it is the panel heading in the served HTML — the head
  // carries only the dot and the state badge (operator, 2026-09-17: the panel
  // printed "MINE YOUR RSVP" twice within three lines).
  const stateBadge = el('span', 'grind-state', 'idle');
  head.appendChild(stateBadge);
  root.appendChild(head);
  head.insertAdjacentHTML('afterbegin', '<span class="grind-dot" aria-hidden="true"></span>');

  // ── the target word, being mined character by character ───────────────────
  // The shell ships in index.html (so it is in the served HTML); the characters
  // themselves always come from DEFAULT_PARAMS.vanityTarget, never the markup.
  const targetStrip = root.querySelector('#target-strip') ?? el('div', 'target-strip');
  let targetWord = targetStrip.querySelector('#target-word');
  if (!targetWord) {
    targetWord = el('span', 'target-word npub');
    targetWord.id = 'target-word';
    targetStrip.appendChild(targetWord);
  }
  targetStrip.classList.add('target-strip');
  // the target strip is the first row of the panel, whatever the markup shipped:
  // everything the page put after it in #grind (the progress bar and its label)
  // stays directly underneath.
  root.prepend(targetStrip);
  let matchedChars = 0;
  /** solid green up to the furthest prefix the search has actually matched. */
  function bumpMatched(chars) {
    const next = Math.max(0, Math.min(Number(chars) || 0, target.length));
    if (next <= matchedChars) return;
    matchedChars = next;
    renderTargetStrip(targetWord, matchedChars, target);
  }
  renderTargetStrip(targetWord, 0, target);

  const headline = el('div', 'grind-headline');
  headline.appendChild(el('span', 'grind-headline-label', 'your minted key — green = mined · orange = anti-phish'));
  const headlineNpub = el('div', 'grind-headline-npub npub', 'npub1…');
  headline.appendChild(headlineNpub);
  // the nsec of that very npub: filled the moment the search for the key ends,
  // so the key is readable and copyable right next to the npub it belongs to
  const keyLine = el('div', 'grind-key');
  keyLine.hidden = true;
  keyLine.appendChild(el('span', 'grind-key-label', 'your nsec — import it into any nostr client'));
  const headlineNsec = el('div', 'grind-headline-nsec npub');
  keyLine.appendChild(headlineNsec);
  headline.appendChild(keyLine);
  const raindropBadge = el('span', 'raindrop-badge');
  raindropBadge.hidden = true;
  headline.appendChild(raindropBadge);
  root.appendChild(headline);

  const stats = el('dl', 'grind-stats');
  const statNodes = {};
  for (const [key, label] of [
    ['tries', 'tries'],
    ['rate', 'keygens/s'],
    ['phase', 'phase'],
    ['target', 'target'],
    ['elapsed', 'elapsed'],
  ]) {
    const wrap = el('div', 'grind-stat');
    wrap.appendChild(el('dt', null, label));
    const dd = el('dd', null, '—');
    statNodes[key] = dd;
    wrap.appendChild(dd);
    stats.appendChild(wrap);
  }
  root.appendChild(stats);

  // the colour legend: the green/orange/ring language is what the npub text
  // below uses, and it is all a demo has to explain
  const legend = el('p', 'grind-legend');
  legend.innerHTML =
    '<span class="legend-swatch legend-vanity" title="mined leet prefix — real proof of work"></span> green = mined · ' +
    '<span class="legend-swatch legend-antiphish" title="anti-phish zone — not mined"></span> orange = anti-phish · ' +
    `<span class="legend-swatch legend-window" title="raindrop: ${windowSize}-char window with ≤${DEFAULT_PARAMS.maxUnique} distinct characters" aria-hidden="true"></span> ring = raindrop`;
  root.appendChild(legend);

  let finder = null;

  /** Window descriptor for the raindrop ring in the npub text. */
  function windowFromScan(scan) {
    if (!scan?.found || !Number.isFinite(scan.start) || !scan.windowSize) return null;
    return {
      start: scan.start,
      length: scan.windowSize,
      unique: scan.unique,
      rarity: scan.rarity,
      label: lowEntropyLabel(scan),
    };
  }

  /**
   * One progress tick of the search. The panel keeps only what a demo can
   * explain in one breath: "mining toward …" counts how far the BEST candidate
   * has come, so the strip fills in as real work lands.
   *
   * The per-candidate fingerprint grid (and the rolling log of attempts that
   * went with it) was pulled on 2026-09-17 — it was doing too much at once to
   * talk over, and it needs a proper demo to explain.
   */
  function push(sample, best = null) {
    const hero = best?.npub ? best : sample;
    if (!hero?.npub) return;
    bumpMatched(hero.chars ?? 0);
  }

  function setStats(next = {}) {
    if (next.tries !== undefined) statNodes.tries.textContent = next.tries.toLocaleString('en-US');
    if (next.keysPerSecond !== undefined && next.keysPerSecond !== null) {
      statNodes.rate.textContent = Math.round(next.keysPerSecond).toLocaleString('en-US');
    }
    if (next.phase) statNodes.phase.textContent = next.phase;
    if (next.target !== undefined) statNodes.target.textContent = next.target === null ? 'ladder full' : `${next.target} bits`;
    if (next.elapsedMs !== undefined) statNodes.elapsed.textContent = `${(next.elapsedMs / 1000).toFixed(1)} s`;
  }

  function setState(text, cls = '') {
    stateBadge.textContent = text;
    stateBadge.className = `grind-state ${cls}`.trim();
    root.dataset.state = cls || 'idle';
  }

  /**
   * Show the winning key: full npub with the mined prefix, the anti-phish zone
   * and — when the miner hands over its raindrop scan — a ring around the
   * low-entropy window plus the `6 unique in 9 · rarity 2.0` badge.
   */
  function setFound({ npub, chars, bits, scan }) {
    finder = { npub, chars, bits, scan };
    const win = windowFromScan(scan);
    bumpMatched(chars ?? 0);
    headlineNpub.replaceChildren(...renderNpub(npub, { chars, floor, antiPhish, window: win }).childNodes);
    if (win) {
      raindropBadge.hidden = false;
      raindropBadge.textContent = `raindrop · ${win.label}`;
      raindropBadge.title = `low-entropy window at body offset ${win.start}: ${win.label}`;
      root.dataset.raindrop = String(win.unique);
    } else {
      raindropBadge.hidden = true;
      raindropBadge.textContent = '';
      delete root.dataset.raindrop;
    }
    setState(`found · ${chars} chars · ${bits} bits`, 'found');
    root.classList.add('grind-found');
  }

  /**
   * Hand over the nsec of the minted npub. The moment the grind stops the key
   * exists nowhere else — the visitor gets it under their own npub, without
   * having to find a button, because losing it loses the seat.
   */
  function setSecret(nsec) {
    if (!nsec) return;
    headlineNsec.textContent = String(nsec);
    keyLine.hidden = false;
    root.dataset.secret = 'shown';
  }

  function reset() {
    matchedChars = 0;
    renderTargetStrip(targetWord, 0, target);
    headlineNpub.textContent = 'npub1…';
    headlineNsec.textContent = '';
    keyLine.hidden = true;
    delete root.dataset.secret;
    raindropBadge.hidden = true;
    raindropBadge.textContent = '';
    delete root.dataset.raindrop;
    root.classList.remove('grind-found');
  }

  return {
    push,
    setStats,
    setState,
    setFound,
    setSecret,
    reset,
    get found() { return finder; },
    element: root,
    targetStrip,
    get targetMatched() { return matchedChars; },
  };
}
