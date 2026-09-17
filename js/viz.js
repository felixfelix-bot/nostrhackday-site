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
 * The strip of candidate rows is fed real candidates from the mining worker, so
 * what the visitor sees scroll past is literally the search space being walked.
 *
 * The `fingerprint-grid` underneath it is the demo's character fingerprint,
 * live: every candidate the worker tries is re-rendered as a 2D grid of its
 * characters, each cell coloured from a fixed per-character colour map (ported
 * from the demo). Same character = same colour everywhere, always, so the
 * viewer learns to read the pattern and can literally watch the search walk the
 * space — the mined prefix cells settle into one stable colour column by column.
 */
import { DEFAULT_PARAMS, lowEntropyLabel } from './pow-ratchet.js';

/** Zone layout: how many characters after the minted prefix get the orange box. */
export const ANTI_PHISH_CHARS = 4;

/**
 * bech32 charset (the npub body alphabet). A character's index in this string
 * decides its colour — nothing else does, so the map is global and stable.
 */
export const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** How many leading characters of the current candidate the live grid shows. */
export const GRID_CHARS = 12;

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// ── colour map (ported from asymmetric-vanity-npubs/demo) ────────────────────
// Fixed, unique colour per character using golden-ratio hue distribution.
// Same character = same colour EVERYWHERE (all grids, radials, sections).

const colorCache = new Map();

/** @returns {{h:number,s:number,l:number}|null} hsl parts for a bech32 char */
function hslForChar(c) {
  const idx = CHARSET.indexOf(c);
  if (idx < 0) return null;
  // Golden ratio angle: maximizes hue separation between any two chars
  const h = (idx * 137.508) % 360;
  // Stagger saturation + lightness so adjacent indices don't look similar
  return { h, s: 60 + (idx % 3) * 12, l: 48 + (idx % 2) * 14 };
}

/** Solid colour for a character (unknown characters get the neutral fallback). */
export function colorForChar(c) {
  if (colorCache.has(c)) return colorCache.get(c);
  const hsl = hslForChar(c);
  const color = hsl ? `hsl(${hsl.h.toFixed(0)},${hsl.s}%,${hsl.l}%)` : '#30363d';
  colorCache.set(c, color);
  return color;
}

/** Readable text colour on top of colorForChar(c). */
export function textColorForChar(c) {
  const hsl = hslForChar(c);
  if (!hsl) return 'rgba(255,255,255,0.9)';
  return hsl.l > 55 ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.95)';
}

/**
 * Same colour, with alpha — used for the cell glow. (The demo concatenated a
 * hex alpha onto the hsl() string, which the CSS parser drops; keeping the
 * alpha inside the colour function makes the glow actually render.)
 */
function glowForChar(c, alpha) {
  const hsl = hslForChar(c);
  if (!hsl) return `rgba(48,54,61,${alpha})`;
  return `hsla(${hsl.h.toFixed(0)},${hsl.s}%,${hsl.l}%,${alpha})`;
}

/**
 * Render `chars` as a `dim x dim` inline grid of coloured cells, each carrying
 * its character. Empty cells are padded out with the neutral border colour.
 * Pure HTML-string renderer, same shape as the demo's `renderFingerprintGrid`.
 *
 * @param {string|string[]} chars characters to show (e.g. the npub body)
 * @param {number} width how many characters the grid is sized for
 * @param {{window?: {start: number, length: number}}} [opts]
 *   a window (in `chars` coordinates) whose cells are ringed so the raindrop is
 *   legible in the grid as well as in the npub text
 */
export function renderFingerprintGrid(chars, width = GRID_CHARS, opts = {}) {
  const list = Array.from(chars ?? []);
  const dim = Math.max(1, Math.ceil(Math.sqrt(Math.max(width, list.length))));
  const ws = opts.window ? Math.max(0, opts.window.start) : -1;
  const we = opts.window ? ws + Math.max(0, Math.floor(opts.window.length)) : -1;
  let html = `<div class="fingerprint-grid" style="grid-template-columns: repeat(${dim}, 1fr);">`;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    const color = colorForChar(c);
    const glow = glowForChar(c, 0.33);
    const glowTight = glowForChar(c, 0.6);
    const delay = (i * 0.04).toFixed(2);
    const inWindow = ws >= 0 && i >= ws && i < we;
    html +=
      `<div class="cell${inWindow ? ' cell-in-window' : ''}"` +
      `${inWindow ? ` data-window-pos="${i - ws + 1}"` : ''}` +
      ` style="background:${color};color:${textColorForChar(c)};` +
      `box-shadow:0 0 8px ${glow},0 0 3px ${glowTight};animation-delay:${delay}s;">${esc(c)}</div>`;
  }
  // pad to fill grid
  const total = dim * dim;
  for (let i = list.length; i < total; i += 1) {
    const delay = (i * 0.04).toFixed(2);
    html += `<div class="cell cell-empty" style="animation-delay:${delay}s;"></div>`;
  }
  return `${html}</div>`;
}

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
 *          gridChars?: number, windowSize?: number}} opts
 */
export function createGrindViz(
  root,
  {
    floor = DEFAULT_PARAMS.vanityChars,
    antiPhish = ANTI_PHISH_CHARS,
    rows = 12,
    gridChars = GRID_CHARS,
    target = DEFAULT_PARAMS.vanityTarget,
    windowSize = DEFAULT_PARAMS.windowSize,
  } = {},
) {
  root.classList.add('grind-viz');

  const head = el('div', 'grind-head');
  // the title is a state, not a label: it invites ("Mine your RSVP") until the
  // visitor presses RSVP and narrates ("Mining your RSVP") from then on.
  const titleEl = el('span', 'grind-title', 'Mine your RSVP');
  head.appendChild(titleEl);
  const stateBadge = el('span', 'grind-state', 'starting…');
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

  // ── live character fingerprint of the current candidate ───────────────────
  // The page may ship the holder in its markup (so the grid is part of the
  // served HTML, not only something JS invents) — adopt it when it is there.
  const grid = el('div', 'grind-grid');
  const gridLabel = el('div', 'grind-grid-label');
  gridLabel.appendChild(el('span', 'grind-grid-caption', 'current candidate — same character, same colour'));
  const gridCandidate = el('span', 'grind-grid-candidate npub');
  gridLabel.appendChild(gridCandidate);
  const gridHost = root.querySelector('.fingerprint-grid-host') ?? el('div', 'fingerprint-grid-host');
  if (gridHost.dataset?.gridChars) gridChars = Number(gridHost.dataset.gridChars) || gridChars;
  gridHost.classList.add('fingerprint-grid-host');
  gridHost.dataset.width = String(gridChars);
  grid.appendChild(gridLabel);
  grid.appendChild(gridHost);
  root.appendChild(grid);
  gridHost.innerHTML = renderFingerprintGrid('', gridChars);

  const strip = el('ul', 'grind-strip');
  root.appendChild(strip);

  const legend = el('p', 'grind-legend');
  legend.innerHTML =
    '<span class="legend-swatch legend-vanity" title="mined leet prefix — real proof of work"></span> green = mined · ' +
    '<span class="legend-swatch legend-antiphish" title="anti-phish zone — not mined"></span> orange = anti-phish · ' +
    `<span class="legend-swatch legend-window" title="raindrop: ${windowSize}-char window with ≤${DEFAULT_PARAMS.maxUnique} distinct characters" aria-hidden="true"></span> ring = raindrop · ` +
    '<span class="legend-swatch legend-grid" title="character identity: one colour per character"></span> colour = character';
  root.appendChild(legend);

  let finder = null;
  let gridFrame = 0;
  let pending = null;

  /** Window descriptor for the npub text/grid, from the miner's scan result. */
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
   * Paint the fingerprint grid for one candidate (rAF-throttled: one paint per
   * frame). Cells are re-used in place when the grid size is unchanged, so a
   * fast search does not restart the entry animation on every frame.
   */
  function paint(sample) {
    if (!sample?.npub) return;
    const body = npubBody(sample.npub);
    paintGrid(body.slice(0, gridChars));
    gridCandidate.replaceChildren(
      ...renderNpub(`npub1${body.slice(0, Math.max(gridChars, 16))}…`, { chars: sample.chars ?? 0, floor, antiPhish }).childNodes,
    );
  }

  function paintGrid(chars) {
    const list = Array.from(chars);
    const dim = Math.max(1, Math.ceil(Math.sqrt(gridChars)));
    const gridEl = gridHost.querySelector('.fingerprint-grid');
    const cells = gridEl ? Array.from(gridEl.children) : [];
    if (cells.length !== dim * dim) {
      gridHost.innerHTML = renderFingerprintGrid(list, gridChars);
      return;
    }
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      const c = list[i];
      if (c === undefined) {
        if (cell.classList.contains('cell-empty')) continue;
        cell.className = 'cell cell-empty';
        cell.textContent = '';
        cell.removeAttribute('style');
        continue;
      }
      if (cell.textContent === c) continue;
      cell.className = 'cell';
      cell.textContent = c;
      cell.style.background = colorForChar(c);
      cell.style.color = textColorForChar(c);
      cell.style.boxShadow = `0 0 8px ${glowForChar(c, 0.33)},0 0 3px ${glowForChar(c, 0.6)}`;
    }
  }

  function scheduleGridPaint(sample) {
    pending = sample;
    if (gridFrame) return;
    gridFrame = requestAnimationFrame(() => {
      gridFrame = 0;
      paint(pending);
    });
  }

  function push(sample) {
    if (!sample?.npub) return;
    // the live fingerprint of the candidate being tried right now
    scheduleGridPaint(sample);
    // the strip fills in as candidate prefixes actually match, so the visitor
    // watches the target word get spelled out by real work
    bumpMatched(sample.chars ?? 0);
    const row = el('li', 'npub-row');
    row.appendChild(renderNpub(sample.npub, { chars: sample.chars, floor, antiPhish }));
    const score = el('span', 'npub-score', sample.chars ? `${sample.chars}/${floor}` : '');
    row.appendChild(score);
    if (sample.chars > 0) row.classList.add('npub-row-hit');
    strip.prepend(row);
    while (strip.childElementCount > rows) strip.removeChild(strip.lastElementChild);
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

  /** Swap the panel title between the invitation and the running state. */
  function setTitle(text) {
    titleEl.textContent = text;
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
    // freeze the fingerprint on the minted candidate so the green columns stay
    // readable, and widen it if the raindrop sits past the shown characters
    if (npub) {
      const body = npubBody(npub);
      const shown = win ? Math.max(gridChars, win.start + win.length) : gridChars;
      gridHost.dataset.width = String(shown);
      gridHost.innerHTML = renderFingerprintGrid(body.slice(0, shown), shown, { window: win });
      gridCandidate.replaceChildren(
        ...renderNpub(`npub1${body.slice(0, Math.max(shown, 16))}…`, { chars, floor, antiPhish, window: win }).childNodes,
      );
      gridHost.classList.add('fingerprint-grid-host-found');
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
    strip.replaceChildren();
    matchedChars = 0;
    setTitle('Mine your RSVP');
    renderTargetStrip(targetWord, 0, target);
    headlineNpub.textContent = 'npub1…';
    headlineNsec.textContent = '';
    keyLine.hidden = true;
    delete root.dataset.secret;
    raindropBadge.hidden = true;
    raindropBadge.textContent = '';
    delete root.dataset.raindrop;
    gridHost.classList.remove('fingerprint-grid-host-found');
    gridHost.dataset.width = String(gridChars);
    gridHost.innerHTML = renderFingerprintGrid('', gridChars);
    gridCandidate.replaceChildren();
    root.classList.remove('grind-found');
  }

  return {
    push,
    setStats,
    setState,
    setTitle,
    setFound,
    setSecret,
    reset,
    get found() { return finder; },
    element: root,
    grid: gridHost,
    targetStrip,
    get targetMatched() { return matchedChars; },
  };
}
