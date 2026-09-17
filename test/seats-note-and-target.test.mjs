/**
 * Operator asks, 2026-09-17 (same day as the live-counter fixes):
 *
 *   1. Drop the "seats open" figure — it could discourage people from applying.
 *   2. Say "didn't make the cut? you're still welcome at c-base" right where the
 *      grind is (next to "mining toward" and the progress bar).
 *   3. The mining panel's `target` stat must show the LIVE rung, even before any
 *      key has been mined — it used to fall back to the 16-bit floor and print
 *      "target 16 bits" while the ladder was already at 18.
 *   4. The seat row should read `seat N · mined X bits · needed Y`, so a 17-bit
 *      seat cannot read as a stray "17b" glued to its npub.
 *
 * Static assertions over the served files (same style as publish-truth).
 * Run: node --test test/seats-note-and-target.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const signupJs = readFileSync(new URL('../js/signup.js', import.meta.url), 'utf8');

test('the seats-open figure is gone from the page and the renderer', () => {
  assert.equal(indexHtml.includes('counter-seats'), false, 'index.html must not ship #counter-seats');
  assert.equal(indexHtml.includes('seats open'), false, 'the "seats open" label is gone');
  assert.equal(signupJs.includes('counter-seats'), false, 'signup.js must not look up #counter-seats');
  for (const id of ['counter-accepted', 'counter-total', 'counter-next']) {
    assert.ok(indexHtml.includes(`id="${id}"`), `the kept figure ${id} is still present`);
  }
});

test('the "still welcome at c-base" note sits with the grind', () => {
  assert.ok(
    /id="mine-note"[^>]*>[^<]*c-base/.test(indexHtml),
    'the note is rendered next to the progress bar',
  );
  const grind = indexHtml.slice(indexHtml.indexOf('id="grind"'), indexHtml.indexOf('status-line'));
  assert.ok(grind.includes('mine-note'), 'the note lives inside the mining panel, not the counter');
});

test('the target stat tracks the live rung, not the 16-bit floor', () => {
  const renderBody = signupJs.slice(signupJs.indexOf('function renderMining'), signupJs.indexOf('// ── submit'));
  assert.ok(renderBody.includes('target: state.targetBits'), 'renderMining reads state.targetBits');
  assert.equal(
    /target:\s*state\.mined\?\.targetBits/.test(renderBody),
    false,
    'the old floor fallback is gone',
  );
  assert.ok(signupJs.includes('targetBits: PARAMS.base'), 'state carries a targetBits field');
});

test('retarget raises running workers even before a key is mined', () => {
  const body = signupJs.slice(signupJs.indexOf('function retarget'), signupJs.indexOf('// ── flow v2'));
  assert.equal(body.includes('!winner'), false, 'the !winner early-return is gone');
  assert.ok(body.includes('workers'), 'it broadcasts the new target to the worker set');
});

test('the seat row prints seat, mined bits and needed bits', () => {
  assert.ok(
    signupJs.includes('· mined ${entry.bits} bits · needed ${entry.rung}'),
    'row format B is present',
  );
  assert.equal(signupJs.includes('${entry.bits}b'), false, 'the old "17b" form is gone');
});
