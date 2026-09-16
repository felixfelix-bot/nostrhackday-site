/**
 * pow-ratchet.test.mjs — plain `node --test` suite for js/pow-ratchet.js
 *
 * Run:            node --test test/
 * Include slow:   POW_SLOW=1 node --test test/     (adds the full shipped
 *                 2^15-try vanity grind at the real BASE=16 floor)
 *
 * The suite mines REAL keys, REAL NIP-13 nonces and REAL schnorr signatures —
 * nothing is stubbed. To keep it fast it drives the ratchet at test-scale
 * parameters (1 leet char = 5 bits, base 5, cap 8) which exercise the exact
 * same code path as the shipped ladder (3 leet chars = 15 bits, base 16,
 * cap 22). The shipped parameters are covered by the pure-function assertions
 * and by the POW_SLOW test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BECH32_CHARSET,
  DEFAULT_PARAMS,
  REASONS,
  buildEventTemplate,
  buildTags,
  computeEventId,
  difficultyOf,
  ladderCapacity,
  ladderTable,
  leadingZeroBits,
  mineNonce,
  mineVanityKey,
  randomSeed,
  requiredBits,
  resolve,
  signWithSecretKey,
  summarize,
  vanityBits,
  vanityBitsForChars,
  vanityInfo,
  verifyRsvp,
} from '../js/pow-ratchet.js';
import { getEventHash, verifyEvent } from '../vendor/esm/nostr-tools@2.23.3/es2022/pure.bundle.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Test-scale ladder: identical logic, ~30x cheaper to mine. */
const SMALL = Object.freeze({
  ...DEFAULT_PARAMS,
  base: 5,
  cap: 8,
  step: 1,
  seatsPerStep: 2,
  vanityChars: 1,
});

/** Deterministic PRNG so shuffles are reproducible. */
function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rnd) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Mine a real keypair + real NIP-13 nonce top-up and sign the result.
 * @param nonceBits bits carried by the nonce tag (difficulty = vanityBits + nonceBits)
 *
 * The vanity grind is retried until the key matches the target *exactly* the
 * floor number of characters (~1/32 of keys match one more character by luck,
 * which would silently raise the difficulty by 5 bits and make the rung
 * assertions below flaky). The retry rate is ~31/32 so this stays cheap.
 */
async function makeRsvp({ params = SMALL, name = 'probe', nonceBits = 0, createdAt, tags: tagsOverride } = {}) {
  let mined = null;
  do {
    mined = await mineVanityKey({ seed: randomSeed(), workerIndex: 0, params, batch: 64 });
  } while (mined.vanityChars !== params.vanityChars);
  const tags = tagsOverride ?? buildTags({ params });
  const template = buildEventTemplate({
    pubkey: mined.pubkey,
    content: JSON.stringify({ name, intent: 'build', contact: 'nostr:' + mined.npub }),
    params,
    createdAt: createdAt ?? Math.floor(Date.now() / 1000),
    tags,
  });
  const top = await mineNonce({ template, targetBits: nonceBits, batch: 64 });
  const event = signWithSecretKey({ ...template, tags: top.tags }, mined.secretKey);
  return { event, mined, template, tags: top.tags, top };
}

// ── 1. ladder math (shipped params) ──────────────────────────────────────────

test('ladder: shipped params expose an exact, monotonic, capped rung ladder', () => {
  assert.equal(DEFAULT_PARAMS.base, 16, 'BASE is 16 bits');
  assert.equal(DEFAULT_PARAMS.cap, 22, 'CAP is 22 bits');
  assert.equal(DEFAULT_PARAMS.seatsPerStep, 2, '+1 bit per 2 accepted');
  assert.equal(DEFAULT_PARAMS.vanityChars, 3, '3 leet characters at the floor');
  assert.equal(vanityBitsForChars(DEFAULT_PARAMS.vanityChars), 15, '3 bech32 chars = 15 bits');

  // +1 bit every second accepted seat
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 12, 13].map((k) => requiredBits(k)),
    [16, 16, 17, 17, 18, 18, 22, 22],
  );
  // ladder closes exactly at the cap
  assert.equal(requiredBits(13), 22);
  assert.equal(requiredBits(14), null);
  assert.equal(requiredBits(99), null);
  assert.equal(ladderCapacity(), 14, '14 unvetted seats at base 16 / cap 22 / +1 per 2');

  // monotonic non-decreasing
  const rungs = ladderTable().map((r) => r.bits);
  for (let i = 1; i < rungs.length; i += 1) assert.ok(rungs[i] >= rungs[i - 1]);

  // every rung is reachable in the stated ~2x cost model
  assert.equal(ladderTable()[0].bits, 16);
  assert.equal(ladderTable().at(-1).bits, 22);
});

test('ladder: the shipped vanity target is bech32-clean so 3 chars really cost 2^15', () => {
  for (const ch of DEFAULT_PARAMS.vanityTarget) {
    assert.ok(BECH32_CHARSET.includes(ch), `"${ch}" is in the bech32 charset`);
  }
  assert.ok(!BECH32_CHARSET.includes('b') && !BECH32_CHARSET.includes('i') && !BECH32_CHARSET.includes('o'));
  assert.equal(DEFAULT_PARAMS.vanityTarget.slice(0, 3), 'n05');
  // single char per position => uniform 1/32 per position => 32^3 tries
  assert.equal(32 ** 3, 32768);
});

// ── 2. vanity accounting ─────────────────────────────────────────────────────

test('vanity: mined keys report exact leet prefix length and bit value', async () => {
  let one = null;
  do {
    one = await mineVanityKey({ seed: randomSeed(), params: SMALL, batch: 64 });
  } while (one.vanityChars !== 1);
  assert.equal(one.vanityChars, 1, 'matched exactly the 1-char floor');
  assert.equal(one.vanityBits, 5);
  assert.equal(vanityBits(one.pubkey, SMALL), 5);
  assert.equal(vanityInfo(one.pubkey, SMALL).npub, one.npub);
  assert.ok(one.npub.startsWith('npub1' + DEFAULT_PARAMS.vanityTarget[0]));
  assert.ok(one.tries >= 1 && one.keysPerSecond === undefined);

  // a 2-char target is still cheap (32^2) and reports 10 bits
  let two = null;
  do {
    two = await mineVanityKey({ seed: randomSeed(), params: { ...SMALL, vanityChars: 2 }, batch: 64 });
  } while (two.vanityChars !== 2);
  assert.equal(two.vanityChars, 2);
  assert.equal(two.vanityBits, 10);
  assert.ok(two.npub.startsWith('npub1' + DEFAULT_PARAMS.vanityTarget.slice(0, 2)));
});

test('vanity: a key that does not match the target scores 0 bits, bit count is exact', () => {
  // 0x0f -> 0000 1111 -> 4 leading zero bits; 0x80 -> 1000 0000 -> 0
  assert.equal(leadingZeroBits('8' + '0'.repeat(63)), 0);
  assert.equal(leadingZeroBits('0f' + '0'.repeat(62)), 4);
  assert.equal(leadingZeroBits('00' + '8' + '0'.repeat(61)), 8);
  assert.equal(leadingZeroBits('0'.repeat(64)), 256);
});

// ── 3. verification of a real, mined, signed RSVP ───────────────────────────

test('verify: a real mined + signed RSVP verifies, id and signature are recomputed locally', async () => {
  const { event, mined, top } = await makeRsvp({ nonceBits: 3 });
  assert.equal(top.declaredBits, 3);
  assert.ok(top.actualBits >= 3);

  // our own serialization/hash must agree with nostr-tools' implementation
  assert.equal(computeEventId(event), event.id, 'own id recomputation matches the claimed id');
  assert.equal(getEventHash(event), event.id, 'nostr-tools agrees the id is NIP-01 correct');
  assert.equal(verifyEvent(event), true);

  const v = verifyRsvp(event, SMALL);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.pubkey, mined.pubkey);
  assert.equal(v.npub, mined.npub);
  assert.equal(v.vanityChars, 1);
  assert.equal(v.vanityBits, 5);
  assert.equal(v.nonceBits, 3, 'declared nonce bits');
  assert.ok(v.actualNonceBits >= 3, 'actual leading zero bits');
  assert.equal(v.bits, 8, 'difficulty = vanityBits + declared nonce bits');
  assert.equal(difficultyOf(event, SMALL).bits, 8);
  assert.equal(difficultyOf(event, SMALL).actualNonceBits, v.actualNonceBits);
  assert.match(summarize(v), /^npub1/);
});

test('verify: forged declared bits on an otherwise valid, correctly signed event are rejected', async () => {
  const { mined, template } = await makeRsvp({ nonceBits: 0 });
  // Overclaim attack: declare 9 bits of NIP-13 work but never do it. The event
  // is genuinely signed and its tags genuinely produce its id — the only lie is
  // the number in the nonce tag, which is exactly what must not be trusted.
  const claimed = 9;
  const tags = [...buildTags({ params: SMALL }), ['nonce', 'forged', String(claimed)]];
  const event = signWithSecretKey({ ...template, tags }, mined.secretKey);
  assert.ok(leadingZeroBits(event.id) < claimed, 'the id does NOT carry the claimed work');
  assert.equal(verifyEvent(event), true, 'signature itself is valid');

  const v = verifyRsvp(event, SMALL);
  assert.equal(v.ok, false);
  assert.equal(v.reason, REASONS.DECLARED_BITS_EXCEEDS_ACTUAL);
  assert.ok(v.actualBits < claimed);
  assert.equal(resolve([event], SMALL).accepted.length, 0, 'overclaim never seats a candidate');
});

test('verify: tampered id, bad signature, wrong kind, missing tags and low vanity are all rejected', async () => {
  const { event, mined, template, tags, top } = await makeRsvp({ nonceBits: 2 });

  const tampered = { ...event, content: JSON.stringify({ name: 'evil' }) };
  assert.equal(verifyRsvp(tampered, SMALL).reason, REASONS.ID_MISMATCH);

  const forgedId = { ...event, id: 'f'.repeat(64) };
  assert.equal(verifyRsvp(forgedId, SMALL).reason, REASONS.ID_MISMATCH);

  const badSig = { ...event, sig: (event.sig[0] === 'a' ? 'b' : 'a') + event.sig.slice(1) };
  assert.equal(verifyRsvp(badSig, SMALL).reason, REASONS.BAD_SIGNATURE);

  const wrongKind = { ...event, kind: 1338 };
  assert.equal(verifyRsvp(wrongKind, SMALL).reason, REASONS.WRONG_KIND, 'structural check fires first');
  assert.notEqual(computeEventId({ ...event, kind: 1338 }), event.id, 'kind is bound by the id');
  assert.notEqual(computeEventId({ ...event, created_at: event.created_at + 1 }), event.id, 'created_at is bound by the id');
  assert.notEqual(computeEventId({ ...event, tags: [...event.tags, ['x', 'y']] }), event.id, 'tags are bound by the id');

  const wrongKindSigned = signWithSecretKey({ ...template, kind: 1338, tags: top.tags }, mined.secretKey);
  assert.equal(verifyRsvp(wrongKindSigned, SMALL).reason, REASONS.WRONG_KIND);

  // template.tags is the base tag list (no nonce tag): mineNonce appends it
  const noNonce = signWithSecretKey({ ...template, tags: template.tags }, mined.secretKey);
  assert.equal(verifyRsvp(noNonce, SMALL).reason, REASONS.MISSING_NONCE_TAG);

  const noTag = await makeRsvp({ nonceBits: 1, tags: [['t', DEFAULT_PARAMS.hashtag], ['client', 'x']] });
  assert.equal(verifyRsvp(noTag.event, SMALL).reason, REASONS.MISSING_EVENT_TAG);

  const strictVanity = { ...SMALL, vanityChars: 4 };
  assert.equal(verifyRsvp(event, strictVanity).reason, REASONS.VANITY_FLOOR);

  const wrongCoordinate = { ...SMALL, eventTag: 'some-other-event' };
  assert.equal(verifyRsvp(event, wrongCoordinate).reason, REASONS.MISSING_EVENT_TAG);

  const nulls = verifyRsvp({ ...event, pubkey: 'nope' });
  assert.equal(nulls.reason, REASONS.BAD_PUBKEY_FORMAT);
  assert.equal(verifyRsvp(null).reason, REASONS.NOT_AN_OBJECT);
  assert.equal(verifyRsvp(undefined).reason, REASONS.NOT_AN_OBJECT);
});

// ── 4. SET-rule resolution ───────────────────────────────────────────────────

test('resolve: accepts the longest qualifying prefix, sorted by difficulty desc', async () => {
  // difficulty spread at the test ladder (base 5, cap 8, +1 bit per 2 seats)
  const spec = [
    { nonceBits: 3, createdAt: 1000, bits: 8 },
    { nonceBits: 3, createdAt: 1001, bits: 8 },
    { nonceBits: 2, createdAt: 1002, bits: 7 },
    { nonceBits: 1, createdAt: 1003, bits: 6 },
    { nonceBits: 0, createdAt: 1004, bits: 5 },
    { nonceBits: 0, createdAt: 1005, bits: 5 },
  ];
  const built = [];
  for (const s of spec) built.push(await makeRsvp({ nonceBits: s.nonceBits, createdAt: s.createdAt }));
  const events = built.map((b) => b.event);

  const inputs = events.map((e) => verifyRsvp(e, SMALL).bits);
  assert.deepEqual(inputs, [8, 8, 7, 6, 5, 5], 'mined difficulties match the intent');

  const r = resolve(events, SMALL);
  assert.deepEqual(r.accepted.map((a) => a.bits), [8, 8, 7, 6], 'longest prefix that keeps bits[k] >= rung(k)');
  assert.deepEqual(r.accepted.map((a) => a.seat), [0, 1, 2, 3]);
  assert.deepEqual(r.accepted.map((a) => a.rung), [5, 5, 6, 6]);
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    [REASONS.INSUFFICIENT_DIFFICULTY, REASONS.INSUFFICIENT_DIFFICULTY],
    '5-bit events cannot pay the 7-bit rung for the 5th seat',
  );
  assert.equal(r.nextRequiredBits, 7, 'next seat needs the rung for k=4');
  assert.equal(r.seatsOpen, 4, 'capacity 8 minus 4 seated');
  assert.deepEqual(
    r.rejected.map((x) => x.id).sort(),
    built.slice(4).map((b) => b.event.id).sort(),
    'the two 5-bit events lost the seats',
  );
});

test('resolve: the SET rule is order-independent (shuffles and duplicates included)', async () => {
  const spec = [
    { nonceBits: 3, createdAt: 5000 },
    { nonceBits: 2, createdAt: 5001 },
    { nonceBits: 1, createdAt: 5002 },
    { nonceBits: 0, createdAt: 5003 },
    { nonceBits: 2, createdAt: 5004 },
  ];
  const built = [];
  for (const s of spec) built.push(await makeRsvp({ nonceBits: s.nonceBits, createdAt: s.createdAt }));
  const events = built.map((b) => b.event);

  const reference = resolve(events, SMALL);
  const refShape = {
    accepted: reference.accepted.map((a) => [a.id, a.bits, a.seat, a.rung]),
    rejected: reference.rejected.map((x) => [x.id, x.reason]).sort(),
    nextRequiredBits: reference.nextRequiredBits,
  };
  assert.ok(reference.accepted.length >= 2, 'sanity: something is accepted');

  const rnd = mulberry32(0xc0ffee);
  for (let trial = 0; trial < 12; trial += 1) {
    const shuffled = shuffle(events, rnd);
    const got = resolve(shuffled, SMALL);
    assert.deepEqual(
      {
        accepted: got.accepted.map((a) => [a.id, a.bits, a.seat, a.rung]),
        rejected: got.rejected.map((x) => [x.id, x.reason]).sort(),
        nextRequiredBits: got.nextRequiredBits,
      },
      refShape,
      `trial ${trial}: identical result for a shuffled input`,
    );
  }

  // duplicates of the same pubkey must not steal seats, in any order
  const dup = built[0].event;
  const withDupes = [...events, dup, dup];
  const a = resolve(withDupes, SMALL);
  const b = resolve(shuffle(withDupes, mulberry32(7)), SMALL);
  assert.deepEqual(a.accepted.map((x) => x.id), b.accepted.map((x) => x.id));
  assert.equal(a.accepted.filter((x) => x.id === dup.id).length, 1, 'one seat per pubkey');
  assert.ok(
    a.rejected.filter((x) => x.reason === REASONS.DUPLICATE_PUBKEY).length >= 1,
    'extra RSVPs from the same pubkey are reported as duplicates',
  );
});

test('resolve: escalation is +1 bit per 2 accepted, and the ladder closes at the cap', async () => {
  // ---- shipped ladder: rung(k) = 16 + floor(k/2), floor 14 seats ------------
  assert.equal(requiredBits(0), 16);
  assert.equal(requiredBits(1), 16, 'still 16 after 1 accepted');
  assert.equal(requiredBits(2), 17, '+1 bit after 2 accepted');
  assert.equal(requiredBits(3), 17);
  assert.equal(requiredBits(4), 18, '+1 bit after 4 accepted');
  assert.equal(requiredBits(14), null, 'no 15th seat');

  // ---- same escalation, observed end-to-end at test scale ------------------
  // The SET rule sorts by difficulty DESC and then accepts the longest prefix
  // with bits[k] >= rung(k). Rungs ascend while bits descend, so the binding
  // constraint is always the WEAKEST accepted member: to seat n RSVPs every one
  // of them must clear rung(n-1). That is what keeps the result a set (not an
  // arrival chain) and what makes it idempotent under re-computation.

  // three 6-bit RSVPs: seats 0,1 need 5 bits, seat 2 needs 6 -> all three seat
  const c1 = await makeRsvp({ nonceBits: 1, createdAt: 2000 });
  const c2 = await makeRsvp({ nonceBits: 1, createdAt: 2001 });
  const c3 = await makeRsvp({ nonceBits: 1, createdAt: 2002 });
  const after3 = resolve([c1.event, c2.event, c3.event], SMALL);
  assert.equal(after3.accepted.length, 3);
  assert.deepEqual(after3.accepted.map((x) => x.rung), [5, 5, 6]);
  assert.equal(after3.nextRequiredBits, 6, 'still 6 until a 4th is accepted');

  // adding one 7-bit RSVP opens a 4th seat and escalates the rung to 7
  const d = await makeRsvp({ nonceBits: 2, createdAt: 2003 });
  const after4 = resolve([c1.event, c2.event, c3.event, d.event], SMALL);
  assert.equal(after4.accepted.length, 4);
  assert.equal(after4.nextRequiredBits, 7, '+1 bit once 4 are accepted');
  assert.deepEqual(after4.accepted.map((x) => x.bits), [7, 6, 6, 6], 'sorted by difficulty, not arrival');
  assert.deepEqual(after4.accepted.map((x) => x.rung), [5, 5, 6, 6]);

  // the new rung is real: a 6-bit RSVP can no longer take the 5th seat
  const weak = await makeRsvp({ nonceBits: 1, createdAt: 2004 });
  const after5 = resolve([c1.event, c2.event, c3.event, d.event, weak.event], SMALL);
  assert.equal(after5.accepted.length, 4, 'a 6-bit RSVP cannot pay the 7-bit rung');
  assert.equal(after5.rejected.at(-1).reason, REASONS.INSUFFICIENT_DIFFICULTY);

  // ---- cap closure ---------------------------------------------------------
  // filling all 8 seats needs every accepted RSVP to clear rung(7) = 8 bits
  const closed = [];
  for (let i = 0; i < 8; i += 1) closed.push(await makeRsvp({ nonceBits: 3, createdAt: 3000 + i }));
  const full = resolve(closed.map((x) => x.event), SMALL);
  assert.equal(full.accepted.length, 8, 'cap 8 is reachable');
  assert.equal(full.nextRequiredBits, null, 'ladder closed at the cap');
  assert.equal(full.ladderFull, true);
  assert.equal(full.seatsOpen, 0);
  assert.equal(full.capacity, 8);

  const extra = await makeRsvp({ nonceBits: 3, createdAt: 3100 });
  const afterFull = resolve([...closed.map((x) => x.event), extra.event], SMALL);
  assert.equal(afterFull.accepted.length, 8, 'no seat appears past the cap');
  assert.equal(afterFull.rejected.at(-1).reason, REASONS.LADDER_FULL);
});

test('resolve: a stronger RSVP takes the cheap seat and displaces the weakest tie (documented SET behaviour)', async () => {
  const a = await makeRsvp({ nonceBits: 0, createdAt: 2000 }); // 5 bits, older
  const b = await makeRsvp({ nonceBits: 0, createdAt: 2001 }); // 5 bits, newer
  const strong = await makeRsvp({ nonceBits: 1, createdAt: 2002 }); // 6 bits

  const two = resolve([a.event, b.event], SMALL);
  assert.equal(two.accepted.length, 2, 'both 5-bit RSVPs seat at rung 5');
  assert.equal(two.nextRequiredBits, 6);

  const three = resolve([a.event, b.event, strong.event], SMALL);
  assert.equal(three.accepted.length, 2, 'seat count cannot grow without paying the new rung');
  assert.deepEqual(
    three.accepted.map((x) => x.id),
    [strong.event.id, a.event.id],
    'the 6-bit RSVP takes seat 0 and the newer 5-bit tie loses its seat',
  );
  assert.equal(three.rejected.at(-1).reason, REASONS.INSUFFICIENT_DIFFICULTY);
  // ...and the same holds whatever order the events arrive in
  const shuffled = resolve([strong.event, b.event, a.event], SMALL);
  assert.deepEqual(shuffled.accepted.map((x) => x.id), three.accepted.map((x) => x.id));
});

test('resolve: vetted pubkeys sit at the floor and do not consume ladder seats', async () => {
  const vetted = await makeRsvp({ nonceBits: 0, createdAt: 4000 });
  const params = { ...SMALL, vettedPubkeys: [vetted.mined.pubkey] };
  const a = await makeRsvp({ nonceBits: 0, createdAt: 4001 });
  const b = await makeRsvp({ nonceBits: 0, createdAt: 4002 });

  const r = resolve([vetted.event, a.event, b.event], params);
  assert.equal(r.accepted.length, 3);
  const v = r.accepted.find((x) => x.pubkey === vetted.mined.pubkey);
  assert.equal(v.vetted, true);
  assert.equal(v.seat, null, 'vetted attendees have no ladder seat');
  assert.equal(r.acceptedUnvetted.length, 2, 'the two unvetted RSVPs took 2 seats');
  assert.equal(r.nextRequiredBits, 6, 'ratchet is driven by unvetted seats only');

  // vetted must still clear the visible floor
  const floorParams = { ...params, vanityChars: 4 };
  assert.equal(verifyRsvp(vetted.event, floorParams).reason, REASONS.VANITY_FLOOR);
});

// ── 5. shipped floor (slow, opt-in) ──────────────────────────────────────────

test('shipped floor: 3 leet chars + nonce top-up verifies at BASE=16', { skip: !process.env.POW_SLOW }, async () => {
  const t0 = Date.now();
  const mined = await mineVanityKey({ seed: randomSeed(), workerIndex: 0, params: DEFAULT_PARAMS, batch: 256 });
  const vanityMs = Date.now() - t0;
  assert.ok(mined.npub.startsWith('npub1' + DEFAULT_PARAMS.vanityTarget.slice(0, 3)), mined.npub);
  assert.ok(mined.vanityChars >= DEFAULT_PARAMS.vanityChars, 'at least the 3-char floor');
  assert.ok(mined.vanityBits >= 15);

  // the floor already covers 15 of the 16 BASE bits, so the nonce top-up is tiny
  // (a lucky 4th character only ever makes the top-up smaller)
  const targetBits = Math.max(0, DEFAULT_PARAMS.base - mined.vanityBits); // 16 - 15 = 1
  assert.ok(targetBits <= 1);

  const tags = buildTags({ params: DEFAULT_PARAMS, status: 'accepted' });
  const template = buildEventTemplate({ pubkey: mined.pubkey, content: JSON.stringify({ name: 'slow-probe' }), params: DEFAULT_PARAMS, tags });
  const top = await mineNonce({ template, targetBits, batch: 256 });
  const event = signWithSecretKey({ ...template, tags: top.tags }, mined.secretKey);

  const v = verifyRsvp(event);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.vanityBits, mined.vanityBits);
  assert.equal(v.bits, mined.vanityBits + targetBits, 'vanity bits + exact nonce rung');
  assert.ok(v.bits >= requiredBits(0));

  const r = resolve([event]);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].rung, 16);
  assert.equal(r.nextRequiredBits, 16);

  console.log(
    `  shipped floor: npub=${mined.npub} vanityChars=${mined.vanityChars} tries=${mined.tries} ` +
    `(${(mined.tries / (vanityMs / 1000)).toFixed(0)} keygens/s, ${vanityMs}ms) nonce=${top.nonce} ` +
    `declared=${top.declaredBits} actual=${top.actualBits} bits=${v.bits} id=${event.id}`,
  );
});
