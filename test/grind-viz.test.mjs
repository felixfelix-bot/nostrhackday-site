/**
 * grind-viz.test.mjs — what the mining panel is allowed to show.
 *
 * The operator read the identity grid as "the key being mined" and saw a random
 * npub instead of the `n05…` prefix being hunted (2026-09-17). Root cause: the
 * grid was repainted from `samples` — the newest raw attempts — while the
 * target strip advanced on the BEST match, so the two rows described different
 * candidates, and the attempt log was 12 rows/s of misses.
 *
 * The contract asserted here:
 *   1. the miner reports `best` (the closest candidate so far) with progress,
 *      monotonically, and the reported `chars` are the npub's real prefix match;
 *   2. the grid paints that best candidate, never a newer miss;
 *   3. matched columns are marked in the grid;
 *   4. the attempt log keeps only candidates that matched ≥1 character and says
 *      so.
 *
 * Run: node --test test/grind-viz.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_PARAMS, mineVanityKey, vanityInfo } from '../js/pow-ratchet.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const vizJs = read('js/viz.js');
const signupJs = read('js/signup.js');
const powJs = read('js/pow-ratchet.js');

const count = (haystack, needle) => haystack.split(needle).length - 1;

/** The prefix match a human reads off the npub — independent of vanityInfo. */
function matchedChars(npub) {
  const body = npub.startsWith('npub1') ? npub.slice(5) : npub;
  const target = SMALL.vanityTarget;
  let i = 0;
  while (i < target.length && body[i] === target[i]) i += 1;
  return i;
}

/** Test-scale ladder: identical logic, ~30x cheaper to mine. */
const SMALL = Object.freeze({ ...DEFAULT_PARAMS, base: 5, cap: 8, step: 1, seatsPerStep: 2, vanityChars: 1 });

// ── 1. the miner reports the best candidate so far ──────────────────────────

test('progress carries `best`: the closest candidate so far, monotonic and honest', async () => {
  const progress = [];
  const found = await mineVanityKey({
    params: SMALL,
    seed: new Uint8Array(32).fill(7),
    batch: 8,
    onProgress: (p) => progress.push(p),
  });

  assert.ok(progress.length > 0, 'a grind that takes more than a tick must report progress');
  const withBest = progress.filter((p) => p.best);
  assert.equal(withBest.length, progress.length, 'every progress tick must carry the best-so-far candidate');

  let last = -1;
  for (const p of withBest) {
    assert.ok(Number.isInteger(p.best.chars), 'best.chars must be an integer');
    assert.ok(p.best.chars >= last, `best.chars went backwards: ${last} -> ${p.best.chars}`);
    last = p.best.chars;
    // honesty: the reported match must be the npub's real prefix match
    assert.equal(matchedChars(p.best.npub), p.best.chars, 'best.chars must equal the real prefix match');
  }

  assert.ok(found?.npub, 'the grind must still return a key');
  assert.equal(found.vanityChars >= SMALL.vanityChars, true, 'the mined key must clear the vanity floor');
  assert.equal(matchedChars(found.npub), found.vanityChars, 'the returned key must report its real prefix match');
  assert.equal(vanityInfo(found.pubkey, SMALL).chars, found.vanityChars, 'vanityInfo agrees with the string match');
  // the winner must WIN the comparison too: a candidate that ties on prefix
  // length but failed the raindrop must never outrank the key we are handing over
  assert.equal(found.best?.npub, found.npub, 'the reported best candidate must be the mined key');
});

test('a finished grind is final: later worker messages cannot repaint the grid', () => {
  const start = vizJs.indexOf('function push(');
  const block = vizJs.slice(start, vizJs.indexOf('function setStats', start));
  assert.ok(
    /if \(finder\) return;/.test(block),
    'push() must refuse to repaint once the key is found',
  );
  const found = vizJs.indexOf('function setFound(');
  const foundBlock = vizJs.slice(found, vizJs.indexOf('function setSecret', found));
  assert.ok(
    /gridBest = \{ npub/.test(foundBlock),
    'setFound() must claim the best slot for the mined key',
  );
  // a frame scheduled just before the find must not land on top of the mined key
  assert.ok(
    /cancelAnimationFrame\(gridFrame\)/.test(foundBlock) && /pending = null/.test(foundBlock),
    'setFound() must drop the frame that was still scheduled',
  );
  const paintIdx = vizJs.indexOf('function paint(sample)');
  const paintBlock = vizJs.slice(paintIdx, vizJs.indexOf('function paintGrid', paintIdx));
  assert.ok(
    /if \(finder && sample\.npub !== finder\.npub\) return;/.test(paintBlock),
    'paint() must refuse to draw anything but the mined key once a key exists',
  );
});

// ── 2. the grid shows the best candidate, not the newest attempt ─────────────

test('the miner sends the best candidate, and the page hands it to the grid', () => {
  assert.ok(count(powJs, 'best: ') >= 1 || count(powJs, 'best =') >= 1, 'js/pow-ratchet.js must track a best candidate');
  assert.ok(
    /onProgress\(\{[\s\S]{0,400}?best:/.test(powJs),
    'the progress payload must include `best`',
  );
  assert.ok(count(signupJs, 'msg.best') >= 1, 'js/signup.js must read msg.best');
  assert.ok(/viz\?\.push\([^)]*best/.test(signupJs), 'the best candidate must be handed to the viz');
  assert.ok(count(vizJs, 'gridBest') >= 1, 'js/viz.js must keep the best candidate it has painted');
});

test('the grid is monotonic: a newer, weaker attempt cannot steal the frame', () => {
  const start = vizJs.indexOf('function push(');
  assert.notEqual(start, -1, 'no push() in js/viz.js');
  const block = vizJs.slice(start, vizJs.indexOf('function setStats', start));
  assert.ok(
    />= *gridBest\.chars|>= *\(best\.chars/.test(block),
    'push() must refuse to paint a candidate that is not at least as good as the painted one',
  );
  assert.ok(
    /scheduleGridPaint\(hero\)|scheduleGridPaint\(best\)/.test(block),
    'push() must paint the best candidate, not the raw sample',
  );
  assert.equal(
    /scheduleGridPaint\(sample\)/.test(block),
    false,
    'push() must not paint the raw sample any more',
  );
});

test('matched columns are marked in the grid', () => {
  assert.ok(count(vizJs, 'cell-matched') >= 1, 'the grid needs a matched-column class');
  assert.ok(
    /function paintGrid\(chars, *matched/.test(vizJs),
    'paintGrid must take the number of matched leading columns',
  );
  assert.ok(
    /function paint\(sample\)[\s\S]{0,700}?paintGrid\(body\.slice\(0, gridChars\), *Math\.min\(sample\.chars/,
    'paint() must pass the matched count through to the grid',
  );
  const css = read('js/signup.css');
  assert.ok(count(css, '.cell-matched') >= 1, 'js/signup.css must style the matched cells');
});

// ── 3. the attempt log only keeps candidates that matched ───────────────────

test('the attempt log is labelled and only logs matches', () => {
  assert.ok(count(vizJs, 'grind-attempts-label') >= 1, 'the attempt log needs a label');
  assert.ok(
    /recent attempts/i.test(vizJs),
    'the label must say what the list is',
  );
  const start = vizJs.indexOf('function push(');
  const block = vizJs.slice(start, vizJs.indexOf('function setStats', start));
  assert.ok(
    /if \(\(sample\.chars \?\? 0\) >= 1\)/.test(block),
    'push() must skip candidates that matched nothing',
  );
  assert.ok(
    /npub-score/.test(block),
    'logged attempts must keep their score',
  );
});

test('the grid caption no longer claims the newest attempt', () => {
  assert.equal(count(vizJs, 'current candidate — same character, same colour'), 0);
  assert.ok(/closest|best/i.test(vizJs.slice(vizJs.indexOf('grind-grid-caption'), vizJs.indexOf('grind-grid-caption') + 200)));
});
