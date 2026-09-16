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
 */
export function renderFingerprintGrid(chars, width = GRID_CHARS) {
  const list = Array.from(chars ?? []);
  const dim = Math.max(1, Math.ceil(Math.sqrt(width)));
  let html = `<div class="fingerprint-grid" style="grid-template-columns: repeat(${dim}, 1fr);">`;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    const color = colorForChar(c);
    const glow = glowForChar(c, 0.33);
    const glowTight = glowForChar(c, 0.6);
    const delay = (i * 0.04).toFixed(2);
    html +=
      `<div class="cell" style="background:${color};color:${textColorForChar(c)};` +
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

/** Render one npub as zone spans (used for rows and for the headline npub). */
export function renderNpub(npub, opts = {}, tagName = 'span') {
  const parts = npubParts(npub, opts);
  const host = el(tagName, 'npub');
  host.appendChild(el('span', 'npub-prefix', parts.prefix));
  if (parts.vanity) host.appendChild(el('span', 'npub-vanity', parts.vanity));
  if (parts.vanityPending) host.appendChild(el('span', 'npub-vanity-pending', parts.vanityPending));
  if (parts.antiPhish) host.appendChild(el('span', 'npub-antiphish', parts.antiPhish));
  if (parts.tail) host.appendChild(el('span', 'npub-tail', parts.tail));
  return host;
}

/**
 * Build the grinding visualisation.
 *
 * @param {HTMLElement} root
 * @param {{floor?: number, antiPhish?: number, rows?: number, target?: string}} opts
 */
export function createGrindViz(root, { floor = 3, antiPhish = ANTI_PHISH_CHARS, rows = 12, gridChars = GRID_CHARS } = {}) {
  root.classList.add('grind-viz');

  const head = el('div', 'grind-head');
  head.appendChild(el('span', 'grind-title', 'MINING YOUR NPUB'));
  const stateBadge = el('span', 'grind-state', 'starting…');
  head.appendChild(stateBadge);
  root.appendChild(head);
  head.insertAdjacentHTML('afterbegin', '<span class="grind-dot" aria-hidden="true"></span>');

  const headline = el('div', 'grind-headline');
  headline.appendChild(el('span', 'grind-headline-label', 'your minted key — green = mined proof of work, orange = anti-phish zone'));
  const headlineNpub = el('div', 'grind-headline-npub npub', 'npub1…');
  headline.appendChild(headlineNpub);
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
    '<span class="legend-swatch legend-vanity"></span> green = mined leet prefix (real proof of work, verified by eye) ' +
    '<span class="legend-swatch legend-antiphish"></span> orange = anti-phish zone (look at it; it is not mined) ' +
    '<span class="legend-swatch legend-grid" aria-hidden="true"></span> grid colour = character identity (same char, same colour everywhere)';
  root.appendChild(legend);

  let finder = null;
  let gridFrame = 0;
  let pending = null;

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

  /** Show the winning key (replaces the strip with the minted npub). */
  function setFound({ npub, chars, bits }) {
    finder = { npub, chars, bits };
    headlineNpub.replaceChildren(...renderNpub(npub, { chars, floor, antiPhish }).childNodes);
    // freeze the fingerprint on the minted candidate so the green columns stay readable
    if (npub) {
      const body = npubBody(npub);
      gridHost.innerHTML = renderFingerprintGrid(body.slice(0, gridChars), gridChars);
      gridCandidate.replaceChildren(
        ...renderNpub(`npub1${body.slice(0, Math.max(gridChars, 16))}…`, { chars, floor, antiPhish }).childNodes,
      );
      gridHost.classList.add('fingerprint-grid-host-found');
    }
    setState(`found · ${chars} chars · ${bits} bits`, 'found');
    root.classList.add('grind-found');
  }

  function reset() {
    strip.replaceChildren();
    headlineNpub.textContent = 'npub1…';
    gridHost.classList.remove('fingerprint-grid-host-found');
    gridHost.innerHTML = renderFingerprintGrid('', gridChars);
    gridCandidate.replaceChildren();
    root.classList.remove('grind-found');
  }

  return { push, setStats, setState, setFound, reset, get found() { return finder; }, element: root, grid: gridHost };
}
