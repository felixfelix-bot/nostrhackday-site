/**
 * grind-panel.test.mjs — the mining panel, after the operator pulled the vanity
 * grid (2026-09-17): "lets remove the vanity grid stuff for the time being.
 * Thats too complicated and it needs to be explained properly in a demo."
 *
 * What must be true now:
 *   1. the fingerprint grid AND the rolling attempt log are gone — out of the
 *      served markup, out of js/viz.js and out of js/signup.css;
 *   2. the miner still reports `best`, so the "mining toward …" strip keeps
 *      advancing on real work;
 *   3. what is left is the part a demo can explain in one breath: the target
 *      strip, the progress bar under it, the live stats, the mined npub with its
 *      green/orange zones and the raindrop badge, and the nsec handover.
 *
 * Run: node --test test/grind-panel.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_PARAMS, mineVanityKey, vanityInfo } from '../js/pow-ratchet.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const indexHtml = read('index.html');
const vizJs = read('js/viz.js');
const signupJs = read('js/signup.js');
const powJs = read('js/pow-ratchet.js');
const css = read('js/signup.css');
const checkScript = read('scripts/check-onepage.sh');

const count = (haystack, needle) => haystack.split(needle).length - 1;

/** Test-scale ladder: identical logic, ~30x cheaper to mine. */
const SMALL = Object.freeze({ ...DEFAULT_PARAMS, base: 5, cap: 8, step: 1, seatsPerStep: 2, vanityChars: 1 });

/** The prefix match a human reads off the npub — independent of vanityInfo. */
function matchedChars(npub) {
  const body = npub.startsWith('npub1') ? npub.slice(5) : npub;
  const target = SMALL.vanityTarget;
  let i = 0;
  while (i < target.length && body[i] === target[i]) i += 1;
  return i;
}

// ── 1. the grid and the attempt log are gone ────────────────────────────────

test('the fingerprint grid is gone from the markup, the viz and the stylesheet', () => {
  assert.equal(count(indexHtml, 'fingerprint-grid'), 0, 'index.html still ships the grid host');
  assert.equal(count(indexHtml, 'grid-chars'), 0, 'index.html still ships the grid width');
  for (const dead of ['renderFingerprintGrid', 'paintGrid', 'gridHost', 'gridCandidate', 'gridChars', 'scheduleGridPaint', 'fingerprint-grid', 'cell-matched']) {
    assert.equal(count(vizJs, dead), 0, `js/viz.js still contains ${dead}`);
  }
  for (const dead of ['.fingerprint-grid', '.grind-grid', '.cell']) {
    assert.equal(count(css, dead), 0, `js/signup.css still styles ${dead}`);
  }
});

test('the rolling attempt log is gone too', () => {
  for (const dead of ['grind-strip', 'npub-row', 'grind-attempts', 'npub-score']) {
    assert.equal(count(vizJs, dead), 0, `js/viz.js still contains ${dead}`);
    assert.equal(count(css, dead), 0, `js/signup.css still styles ${dead}`);
  }
});

test('the legend no longer explains a grid', () => {
  assert.equal(count(vizJs, 'colour = character'), 0, 'the colour-identity clause is grid-only');
  assert.equal(count(css, '.legend-grid'), 0, 'the grid-colour swatch has no meaning now');
  assert.ok(count(vizJs, 'green = mined') >= 1, 'the green/zone clauses still apply to the npub text');
  assert.ok(count(vizJs, 'orange = anti-phish') >= 1);
});

test('check-onepage.sh no longer asserts the deleted grid', () => {
  assert.equal(count(checkScript, 'fingerprint-grid'), 0);
  assert.ok(count(checkScript, 'target-strip') >= 1, 'it must assert something the page still has');
});

// ── 2. the strip still advances on real work ────────────────────────────────

test('the miner keeps reporting `best`, monotonic and honest', async () => {
  const progress = [];
  const found = await mineVanityKey({
    params: SMALL,
    seed: new Uint8Array(32).fill(7),
    batch: 8,
    onProgress: (p) => progress.push(p),
  });

  assert.ok(progress.length > 0, 'a grind longer than a tick must report progress');
  assert.equal(progress.filter((p) => p.best).length, progress.length, 'every tick carries the best candidate');
  let last = -1;
  for (const p of progress) {
    assert.ok(p.best.chars >= last, `best.chars went backwards: ${last} -> ${p.best.chars}`);
    last = p.best.chars;
    assert.equal(matchedChars(p.best.npub), p.best.chars, 'best.chars must equal the real prefix match');
  }
  assert.equal(found.best?.npub, found.npub, 'the reported best must be the mined key');
  assert.equal(vanityInfo(found.pubkey, SMALL).chars, found.vanityChars);
});

test('viz.push only moves the target strip — it draws no grid', () => {
  const start = vizJs.indexOf('function push(');
  assert.notEqual(start, -1, 'js/viz.js needs push() for the strip');
  const block = vizJs.slice(start, vizJs.indexOf('function setStats', start));
  assert.ok(/bumpMatched\(/.test(block), 'push() must advance the target strip');
  assert.equal(count(block, 'appendChild'), 0, 'push() must not build DOM rows any more');
  assert.equal(count(block, 'innerHTML'), 0, 'push() must not paint a grid any more');
  assert.ok(count(signupJs, 'msg.best') >= 1, 'js/signup.js must still hand the best candidate over');
});

// ── 3. what is left ─────────────────────────────────────────────────────────

test('the panel keeps the parts a demo can explain', () => {
  assert.ok(count(indexHtml, 'target-strip') >= 1, 'the "mining toward …" strip stays');
  assert.ok(count(indexHtml, 'mine-bar') >= 1, 'the progress bar stays');
  assert.ok(count(indexHtml, 'mine-label') >= 1, 'the live counter label stays');
  assert.ok(count(vizJs, 'grind-stats') >= 1, 'the live stats stay');
  assert.ok(count(vizJs, "el('span', 'grind-title'") >= 1, 'the title stays');
  assert.ok(count(vizJs, 'grind-headline-npub') >= 1, 'the mined npub stays');
  assert.ok(count(vizJs, 'raindrop-badge') >= 1, 'the raindrop badge stays');
  assert.ok(count(vizJs, 'function setSecret') >= 1, 'the nsec handover stays');
  assert.ok(count(vizJs, 'function setTitle') >= 1, 'the invite/running title stays');
});
