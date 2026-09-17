/**
 * no-nip07.test.mjs — the RSVP page has no browser-extension (NIP-07) path.
 *
 * Operator, 2026-09-17: "looks good, please remove the nip07 stuff."
 *
 * What must hold now:
 *   1. no NIP-07 markup: no checkbox, no toggle label, no detection note;
 *   2. no NIP-07 code: no `window.nostr`, no detect step, no `mineForPubkey`
 *      message type in the worker;
 *   3. the flow that remains is the ephemeral browser key, end to end — the
 *      details event is still signed by the mined key, and the nsec is exported
 *      unconditionally (there is no second signer to guard against);
 *   4. the docs stop advertising it; the design note records the reversal.
 *
 * Run: node --test test/no-nip07.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const indexHtml = read('index.html');
const signupJs = read('js/signup.js');
const workerJs = read('js/pow-worker.js');
const css = read('js/signup.css');
const readme = read('README.md');
const design = read('design-signup-nostr-form.md');

const count = (haystack, needle) => haystack.split(needle).length - 1;

test('the NIP-07 markup is gone', () => {
  for (const dead of ['nip07', 'NIP-07', 'Use my NIP-07 key', 'window.nostr']) {
    assert.equal(count(indexHtml, dead), 0, `index.html still has ${dead}`);
  }
  assert.ok(count(indexHtml, 'id="cta-mine"') >= 1, 'the RSVP button stays');
  assert.ok(count(indexHtml, 'id="nsec-out"') >= 1, 'the key handover stays');
  assert.ok(count(indexHtml, 'for="f-name">Nym<') === 1, 'the nym field stays');
});

test('the NIP-07 code path is gone from the page', () => {
  for (const dead of ['nip07', 'NIP-07', 'useNip07', 'detectNip07', 'mineForExtensionKey', 'window.nostr']) {
    assert.equal(count(signupJs, dead), 0, `js/signup.js still has ${dead}`);
  }
  assert.equal(count(css, 'nip07'), 0, 'js/signup.css still styles a NIP-07 control');
});

test('the worker has no external-signer grind', () => {
  for (const dead of ['nip07', 'NIP-07', 'mineForPubkey', 'mineForSecretKey']) {
    assert.equal(count(workerJs, dead), 0, `js/pow-worker.js still has ${dead}`);
  }
});

test('what is left is one signer: the mined browser key', () => {
  assert.ok(count(signupJs, "type: 'sign'") >= 1, 'the details event is still signed by the mined key');
  assert.equal(count(signupJs, 'if (!state.useNip07)'), 0, 'the nsec export must not be behind a signer guard');
  assert.ok(
    /if \(first\) \{[\s\S]{0,600}?worker\.postMessage\(\{ type: 'export' \}\);/.test(signupJs),
    'the mined key must still be exported on the mined path',
  );
  assert.ok(count(signupJs, 'createGrindViz') >= 1 || count(signupJs, 'initViz') >= 1, 'the panel still initialises');
});

test('the docs no longer advertise NIP-07, and the design note records the reversal', () => {
  assert.equal(count(readme, 'NIP-07'), 0, 'README still mentions NIP-07');
  assert.ok(/2026-09-17/.test(design), 'the design note must record when the path was pulled');
  assert.ok(/superseded|removed|pulled/i.test(design.split('\n').slice(0, 12).join(' ')), 'the reversal must be visible at the top of the design note');
});
