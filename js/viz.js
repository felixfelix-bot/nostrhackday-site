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
 */

/** Zone layout: how many characters after the minted prefix get the orange box. */
export const ANTI_PHISH_CHARS = 4;

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Split an npub into its display zones.
 * @param {string} npub
 * @param {{chars?: number, floor?: number, antiPhish?: number}} opts
 *   chars = longest leet-prefix match, floor = chars the visitor must match,
 *   antiPhish = width of the orange zone.
 */
export function npubParts(npub, { chars = 0, floor = 0, antiPhish = ANTI_PHISH_CHARS } = {}) {
  const body = typeof npub === 'string' && npub.startsWith('npub1') ? npub.slice(5) : '';
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
export function createGrindViz(root, { floor = 3, antiPhish = ANTI_PHISH_CHARS, rows = 12 } = {}) {
  root.classList.add('grind-viz');

  const head = el('div', 'grind-head');
  head.appendChild(el('span', 'grind-label', 'grinding npubs'));
  const stateBadge = el('span', 'grind-state', 'starting…');
  head.appendChild(stateBadge);
  root.appendChild(head);
  head.insertAdjacentHTML('afterbegin', '<span class="grind-dot" aria-hidden="true"></span>');

  const headline = el('div', 'grind-headline');
  headline.appendChild(el('span', 'grind-headline-label', 'your key'));
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

  const strip = el('ul', 'grind-strip');
  root.appendChild(strip);

  const legend = el('p', 'grind-legend');
  legend.innerHTML =
    '<span class="legend-swatch legend-vanity"></span> mined leet prefix (proof of work) ' +
    '<span class="legend-swatch legend-antiphish"></span> anti-phish zone (visual check, not mined)';
  root.appendChild(legend);

  let finder = null;

  function push(sample) {
    if (!sample?.npub) return;
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
    setState(`found · ${chars} chars · ${bits} bits`, 'found');
    root.classList.add('grind-found');
  }

  function reset() {
    strip.replaceChildren();
    headlineNpub.textContent = 'npub1…';
    root.classList.remove('grind-found');
  }

  return { push, setStats, setState, setFound, reset, get found() { return finder; }, element: root };
}
