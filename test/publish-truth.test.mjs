/**
 * publish-truth.test.mjs — the counter may only count events that reached a relay
 * (operator, 2026-09-17: "Why does the accepted count go back to 0 after I
 * reload the nsite? … or perhaps it failed to publish the event correctly?").
 *
 * It HAD failed to publish — 0 kind-1337 events with the `#nhr` tag existed on
 * any of 8 relays — but the page added its own event to the local store BEFORE
 * publishing, so the counter showed "accepted 1" from an event no relay ever
 * had. A reload rebuilt the store from relays and the seat vanished.
 *
 * The contract: publish first, add locally only when at least one relay took it
 * (a dry run with no relays configured is the one exception — the whole point
 * there is to exercise the flow offline).
 *
 * Run: node --test test/publish-truth.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const signupJs = readFileSync(new URL('../js/signup.js', import.meta.url), 'utf8');
const count = (haystack, needle) => haystack.split(needle).length - 1;

/** The body of one async function, up to the next top-level `function`/`async function`. */
function bodyOf(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start === -1) return '';
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n(async )?function /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('the proof event is published before it is counted', () => {
  const body = bodyOf(signupJs, 'onProof');
  assert.ok(body.length > 200, 'onProof not found');
  const publishAt = body.indexOf('pool.publish(');
  assert.notEqual(publishAt, -1, 'onProof must publish');
  const firstLocalAdd = body.indexOf('store.add(');
  assert.notEqual(firstLocalAdd, -1, 'onProof must still add the event once accepted');
  assert.ok(
    publishAt < firstLocalAdd,
    'the local add must happen AFTER the publish — adding first is exactly the bug',
  );
  assert.ok(
    /if \(proof\.published\.some\(\(p\) => p\.ok\)\) store\.add\(event\)/.test(body),
    'the local add must be guarded by at least one relay accepting',
  );
  assert.ok(
    /dry-run[^]*?ok: true/.test(body),
    'a dry run (no relays) must still record the event locally — that path is deliberate',
  );
});

test('the details event is published before it is counted', () => {
  const body = bodyOf(signupJs, 'onSigned');
  assert.ok(body.length > 200, 'onSigned not found');
  const publishAt = body.indexOf('pool.publish(');
  const addAt = body.indexOf('store.add(');
  assert.notEqual(publishAt, -1, 'onSigned must publish');
  assert.notEqual(addAt, -1, 'onSigned must still add the event once accepted');
  assert.ok(publishAt < addAt, 'the details event must not be counted before it is published either');
});

test('a failed publish says so, and hands the key over anyway', () => {
  const body = bodyOf(signupJs, 'onProof');
  assert.ok(/did not reach any relay|no relay/i.test(body), 'the failure must be stated in the status line');
  const signed = bodyOf(signupJs, 'onSigned');
  assert.ok(/did not reach any relay|no relay/i.test(signed), 'the details failure must be stated too');
  assert.ok(count(signupJs, 'revealFlow()') >= 3, 'the reveal (and with it the nsec) must still happen');
});

test('the counter counts the store, so the store is the only thing that may lie', () => {
  const render = signupJs.slice(signupJs.indexOf('function renderCounter('), signupJs.indexOf('function buildZoneSpans('));
  assert.ok(/\$\('counter-total'\)\.textContent = String\(total\)/.test(render), 'events seen = the number of events in the store');
  assert.ok(/acceptedEl\.textContent = String\(result\.accepted\.length\)/.test(render), 'accepted = resolve() over the store');
});
