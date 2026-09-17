// relay-filter.test.mjs — the REQ must use indexed tags only.
// strfry relays refuse `#nhr` ("unindexed tag filter"), which made the live
// counter read 0 forever. The nhr requirement is enforced by verifyRsvp instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const signup = readFileSync(new URL('../js/signup.js', import.meta.url), 'utf8');
const ratchet = readFileSync(new URL('../js/pow-ratchet.js', import.meta.url), 'utf8');

test('the relay filter uses only indexed, single-letter tag keys', () => {
  const line = signup.split('\n').find((l) => l.includes('const RSVP_FILTER'));
  assert.ok(line, 'RSVP_FILTER is declared');
  assert.ok(!line.includes("'#nhr'"), `REQ must not filter on #nhr: ${line.trim()}`);
  const keys = [...line.matchAll(/'#([A-Za-z0-9]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 0, 'the REQ carries a tag filter');
  for (const k of keys) assert.equal(k.length, 1, `#${k} is not a single-letter (indexed) tag`);
  assert.deepEqual(keys, ['t'], 'the indexed tag used is #t');
});

test('the hashtag comes from the params, not a literal', () => {
  const line = signup.split('\n').find((l) => l.includes('const RSVP_FILTER'));
  assert.match(line, /PARAMS\.hashtag/, 'filter value is PARAMS.hashtag');
  assert.match(ratchet, /hashtag: 'nostrhackday'/, 'params carry the hashtag');
});

test('verifyRsvp still requires the nhr tag (the filter can no longer do it)', () => {
  assert.match(ratchet, /tags\.some\(\(t\) => t\[0\] === params\.tagName && t\[1\] === params\.eventTag\)/,
    'verifyRsvp enforces the hackday tag');
});
