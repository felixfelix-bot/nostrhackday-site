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
import { readFileSync } from 'node:fs';

import {
  BECH32_CHARSET,
  DEFAULT_PARAMS,
  PROOF_STATUS,
  REASONS,
  buildEventTemplate,
  buildProofContent,
  buildProofEvent,
  buildProofTags,
  buildTags,
  canStartMining,
  computeEventId,
  deriveCandidate,
  difficultyOf,
  expectedUnique,
  ladderCapacity,
  ladderTable,
  leadingZeroBits,
  lowEntropyLabel,
  mineNonce,
  mineProofEvent,
  mineVanityKey,
  nonceTag,
  randomSeed,
  requiredBits,
  resolve,
  scanLowEntropyWindows,
  shouldAutoPublishProof,
  signWithSecretKey,
  summarize,
  vanityBits,
  vanityBitsForChars,
  vanityInfo,
  verifyRsvp,
} from '../js/pow-ratchet.js';
import { getEventHash, getPublicKey, verifyEvent } from '../vendor/esm/nostr-tools@2.23.3/es2022/pure.bundle.mjs';

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

// ── 2b. raindrop: the low-entropy window floor ───────────────────────────────

/** Independent (test-local) window scanner — deliberately NOT the module's code. */
function independentBestWindow(body, windowSize = 9) {
  let best = null;
  for (let i = 0; i + windowSize <= body.length; i += 1) {
    const chars = body.slice(i, i + windowSize);
    const unique = new Set(chars).size;
    if (best === null || unique < best.unique) best = { start: i, chars, unique };
  }
  return best;
}

/** Sign an RSVP for a FIXED pubkey (used to construct sub-floor / flat-npub cases). */
async function makeRsvpForPubkey(pubkey, secretKey, { params = SMALL, nonceBits = 0, createdAt = 1234, name = 'flat' } = {}) {
  const template = buildEventTemplate({
    pubkey,
    content: JSON.stringify({ name, intent: 'build' }),
    params,
    createdAt,
    tags: buildTags({ params }),
  });
  const top = await mineNonce({ template, targetBits: nonceBits, batch: 64 });
  const event = signWithSecretKey({ ...template, tags: top.tags }, secretKey);
  return { event, top, template };
}

/**
 * Deterministically find a secret key whose npub (a) clears the visible leet
 * floor and (b) contains NO low-entropy window. Fixed seed + fixed iteration
 * order => fully reproducible, no luck involved (~1/500 candidates qualify).
 */
function findFlatNpubKey(params, seedByte = 0x11) {
  const seed = new Uint8Array(32).fill(seedByte);
  for (let counter = 0; counter < 200000; counter += 1) {
    const secretKey = deriveCandidate(seed, 0, counter);
    const pubkey = getPublicKey(secretKey);
    const info = vanityInfo(pubkey, params);
    if (info.chars < params.vanityChars) continue;
    const scan = scanLowEntropyWindows(info.npub, params);
    if (!scan.found) return { secretKey, pubkey, info, scan, counter, seed };
  }
  throw new Error('no flat npub found deterministically');
}

test('raindrop: scanLowEntropyWindows finds the exact window (start/chars/unique) and tie-breaks on the earliest start', () => {
  // 10 distinct chars, then an 11-char run of one character, then more noise.
  const body = '7k3q9x8g2m' + 'ppppppppppp' + 'u5r0s3jn54khce6mua7l';
  const npub = 'npub1' + body;

  const scan = scanLowEntropyWindows(npub);
  assert.equal(scan.found, true);
  assert.equal(scan.start, 10, 'start is relative to the bech32 data part (after npub1)');
  assert.equal(scan.chars, 'ppppppppp');
  assert.equal(scan.unique, 1);
  assert.equal(scan.body, body, 'everything after npub1 is scanned');
  assert.equal(scan.windows.length, body.length - 9 + 1, 'one OVERLAPPING window per start');
  assert.equal(scan.windowSize, 9);
  assert.equal(scan.maxUnique, 6);

  // the expected unique count is the occupancy expectation for that window size
  assert.ok(Math.abs(scan.expected - 32 * (1 - (31 / 32) ** 9)) < 1e-12);
  assert.ok(scan.expected > 7.9 && scan.expected < 8, `E[unique] for W=9 is 7.953, got ${scan.expected}`);
  assert.equal(scan.expected, expectedUnique(9));
  assert.equal(scan.expected, expectedUnique(DEFAULT_PARAMS.windowSize));
  // rarity = expected − actual, and it is reported on both the scan and the window
  assert.ok(Math.abs(scan.rarity - (scan.expected - 1)) < 1e-12);
  assert.equal(scan.rarity.toFixed(1), '7.0');
  assert.deepEqual(scan.windows[10], { start: 10, chars: 'ppppppppp', unique: 1, rarity: scan.rarity });
  assert.equal(lowEntropyLabel(scan), `1 unique in 9 · rarity ${scan.rarity.toFixed(1)}`);

  // tie-break: starts 11 and 12 are ALSO all-'p' (unique 1)…
  assert.equal(scan.windows[11].unique, 1);
  assert.equal(scan.windows[12].unique, 1);
  assert.equal(scan.windows[9].unique, 2, 'the window just before the run is not the winner');
  assert.equal(scan.windows[13].unique, 2, 'a window straddling the end of the run is not the winner');
  assert.equal(scan.windows[21].unique, 8, 'a window entirely in the noisy tail is near-pure noise (the "5" repeats)');
  assert.equal(scan.windows.length, body.length - 9 + 1);
  assert.equal(scan.windows.length, 33);

  // the shipped floor keeps exactly 9/6 and 3 vanity chars (nothing was raised)
  assert.equal(DEFAULT_PARAMS.windowSize, 9);
  assert.equal(DEFAULT_PARAMS.maxUnique, 6);
  assert.equal(DEFAULT_PARAMS.vanityChars, 3);
});

test('raindrop: no window under the threshold reports found:false', () => {
  // the bech32 alphabet has 32 DISTINCT characters, so every 9-char window is 9-unique
  assert.equal(new Set(BECH32_CHARSET).size, 32, 'alphabet sanity: all characters distinct');
  const npub = 'npub1' + BECH32_CHARSET;

  const scan = scanLowEntropyWindows(npub);
  assert.equal(scan.found, false);
  assert.equal(scan.unique, 9, 'the best available window still has 9 unique characters');
  assert.equal(scan.windows.length, BECH32_CHARSET.length - 9 + 1);
  assert.ok(scan.windows.every((w) => w.unique > DEFAULT_PARAMS.maxUnique), 'every window exceeds maxUnique');
  assert.ok(scan.rarity < 0, 'rarity is negative here: more unique than a random window');
  assert.equal(independentBestWindow(BECH32_CHARSET).unique, scan.unique, 'agrees with an independent scan');

  // the threshold is the only gate: lower it to 9 and the same body qualifies
  assert.equal(scanLowEntropyWindows(npub, { maxUnique: 9 }).found, true);
  // ...and window size is a knob, not a hardcode
  assert.equal(scanLowEntropyWindows(npub, { windowSize: 4, maxUnique: 3 }).found, false);

  // a body shorter than one window has no windows at all
  const tiny = scanLowEntropyWindows('npub1qpzry9x8');
  assert.equal(tiny.found, false);
  assert.equal(tiny.windows.length, 0);
  assert.equal(tiny.start, -1);
  assert.equal(tiny.unique, null);
  assert.equal(tiny.rarity, 0);
  assert.equal(lowEntropyLabel(tiny), 'no window');
});

test('raindrop: verifyRsvp rejects a correctly signed event whose npub has no low-entropy window', async () => {
  const flat = findFlatNpubKey(SMALL);
  assert.ok(flat.info.chars >= SMALL.vanityChars, 'the constructed key clears the visible leet floor');
  assert.equal(flat.scan.body, flat.info.npub.slice(5), 'the scan body is the bech32 data part');
  assert.equal(flat.scan.found, false, 'and has no window within the threshold');

  const { event } = await makeRsvpForPubkey(flat.pubkey, flat.secretKey, { nonceBits: 0 });
  assert.equal(verifyEvent(event), true, 'the signature is genuinely valid');
  assert.equal(computeEventId(event), event.id, 'id is NIP-01 correct');

  const v = verifyRsvp(event, SMALL);
  assert.equal(v.ok, false);
  assert.equal(v.reason, REASONS.LOW_ENTROPY_MISSING);
  assert.equal(v.npub, flat.info.npub);
  assert.equal(v.windowSize, 9);
  assert.equal(v.maxUnique, 6);
  assert.equal(v.bestUnique, flat.scan.unique);
  assert.ok(v.bestUnique > 6, 'the best window still has too many unique characters');
  // the reason TEXT names the criterion, not just a code
  assert.match(v.text, /no 9-character window with <= 6 unique characters/);
  assert.match(v.text, new RegExp(`lowest unique found: ${flat.scan.unique}`));
  assert.match(v.criterion, /9-character window with <= 6 unique characters/);
  assert.equal(v.lowEntropy.found, false);

  // EVERYTHING ELSE about this event is fine: loosen only the window rule and it verifies
  const loose = verifyRsvp(event, { ...SMALL, maxUnique: 9 });
  assert.equal(loose.ok, true, loose.reason);
  assert.equal(loose.vanityChars, SMALL.vanityChars, 'prefix floor passed');
  assert.equal(loose.vanityBits, SMALL.vanityChars * 5);
  assert.equal(loose.lowEntropyUnique, flat.scan.unique);

  // the SET rule must not seat it either
  const r = resolve([event], SMALL);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected[0].reason, REASONS.LOW_ENTROPY_MISSING);

  // and the miner refuses to hand such a key out in the first place: fixed seeds
  // make this reproducible, and the accepted key ALWAYS clears both floors
  for (let w = 0; w < 3; w += 1) {
    const mined = await mineVanityKey({ seed: flat.seed, workerIndex: w, params: SMALL, batch: 64 });
    assert.equal(mined.scan.found, true, 'the miner always returns a key that clears the window floor');
    assert.ok(mined.scan.unique <= SMALL.maxUnique);
    assert.equal(mined.scan.body, mined.npub.slice(5));
    assert.ok(mined.vanityChars >= SMALL.vanityChars, 'and the visible prefix floor');
  }
});

test('raindrop: a real mined event is accepted and its window agrees with an independent re-scan', async () => {
  const { event, mined } = await makeRsvp({ nonceBits: 2 });

  // the miner hands the scan back, so callers never have to re-scan
  assert.ok(mined.scan, 'mineVanityKey returns the scan for the minted npub');
  assert.equal(mined.scan.found, true);
  assert.equal(mined.scan.body, mined.npub.slice(5));
  assert.equal(mined.scan.chars, mined.npub.slice(5).slice(mined.scan.start, mined.scan.start + 9));
  assert.ok(mined.scan.unique <= SMALL.maxUnique);

  const v = verifyRsvp(event, SMALL);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.lowEntropyUnique, mined.scan.unique);
  assert.equal(v.lowEntropyStart, mined.scan.start);
  assert.equal(v.lowEntropyRarity, mined.scan.rarity);
  assert.deepEqual(
    { found: v.lowEntropy.found, start: v.lowEntropy.start, unique: v.lowEntropy.unique, chars: v.lowEntropy.chars },
    { found: true, start: mined.scan.start, unique: mined.scan.unique, chars: mined.scan.chars },
    'verifyRsvp re-derives the same window the miner reported',
  );

  // INDEPENDENT re-scan: hand-rolled in this file, no module code involved
  const best = independentBestWindow(mined.npub.slice(5), DEFAULT_PARAMS.windowSize);
  assert.ok(best, 'the npub body is longer than one window');
  assert.equal(best.unique, mined.scan.unique, 'independent scan agrees on unique');
  assert.equal(best.start, mined.scan.start, 'independent scan agrees on start');
  assert.equal(best.chars, mined.scan.chars, 'independent scan agrees on the characters');
  assert.equal(best.unique, v.lowEntropyUnique);
  assert.equal(best.start, v.lowEntropyStart);
  assert.match(summarize(v), /raindrop=\d+\/9u/);
});


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

// ── 6. flow v2: the unattended MINIMAL PROOF event ───────────────────────────
//
// The page publishes this event by itself the moment the mined key reaches the
// current rung — no form, no consent, because it carries no personal data. It
// still consumes a ladder seat, so the details follow-up (same key, same rung)
// must NOT take a second one.

/** Mine a real key at the test-scale floor + the joint proof nonce for it. */
async function makeProof({ targetBits = 0, createdAt, params = SMALL } = {}) {
  let mined = null;
  do {
    mined = await mineVanityKey({ seed: randomSeed(), workerIndex: 0, params, batch: 64 });
  } while (mined.vanityChars !== params.vanityChars);
  const info = vanityInfo(mined.pubkey, params);
  const proof = await mineProofEvent({
    pubkey: mined.pubkey,
    secretKey: mined.secretKey,
    params,
    targetBits,
    npubPrefix: `npub1${info.matched}`,
    status: PROOF_STATUS,
    createdAt: createdAt ?? Math.floor(Date.now() / 1000),
    batch: 64,
  });
  assert.ok(proof, 'the proof grind returned a result');
  return { ...proof, mined, info };
}

test('flow v2: the proof event is kind 1337 with EXACTLY the programmatic tag set and zero personal fields', async () => {
  const { event, nonce, mined } = await makeProof({ targetBits: 1, createdAt: 900 });

  assert.equal(event.kind, 1337, 'kind comes from params.kind');
  assert.equal(event.pubkey, mined.pubkey, 'signed by the mined key');

  // The FULL tag array, spelled out: a stray personal tag would fail this.
  assert.deepEqual(event.tags, [
    ['t', SMALL.hashtag],
    [SMALL.tagName, SMALL.eventTag],
    ['status', PROOF_STATUS],
    ['client', 'nostrhackday-signup'],
    ['nonce', String(nonce), '1'],
  ]);
  assert.deepEqual(event.tags.map((t) => t[0]), ['t', 'nhr', 'status', 'client', 'nonce']);

  // ...and the content is exactly the machine proof text (bits / nonce / npub prefix).
  const data = JSON.parse(event.content);
  assert.deepEqual(Object.keys(data), ['v', 'proof', 'event', 'bits', 'nonce', 'npub']);
  assert.deepEqual(data, {
    v: 2,
    proof: 1,
    event: SMALL.eventTag,
    bits: 1,
    nonce: String(nonce),
    npub: `npub1${mined.npub.slice(5, 5 + SMALL.vanityChars)}`,
  });
  assert.ok(mined.npub.startsWith(data.npub), 'the content prefix is the mined visible prefix');

  for (const personal of ['name', 'alias', 'intent', 'skill', 'idea', 'diet', 'contact', 'email', 'ip', 'ua', 'userAgent']) {
    assert.ok(!(personal in data), `the proof content must not carry \`${personal}\``);
  }
  assert.ok(!event.content.includes(mined.npub), 'the full npub never enters the proof content');
  assert.ok(!JSON.stringify(event.tags).includes(mined.npub), 'no npub in the tags either');

  // the pure builders reproduce the shipped event byte for byte (no hidden field)
  const rebuilt = buildProofEvent({
    pubkey: event.pubkey,
    nonce,
    bits: 1,
    npubPrefix: data.npub,
    params: SMALL,
    status: PROOF_STATUS,
    createdAt: event.created_at,
  });
  assert.deepEqual(rebuilt, {
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: 1337,
    tags: event.tags,
    content: event.content,
  });
  assert.equal(event.content, buildProofContent({ bits: 1, nonce, npubPrefix: data.npub, params: SMALL }));
  assert.deepEqual(buildProofTags({ params: SMALL, nonce, bits: 1, status: PROOF_STATUS }), event.tags);
});

test('flow v2: the proof verifies against the rung by recomputation (a declared nonce is never trusted)', async () => {
  const bits = 1;
  const { event, mined } = await makeProof({ targetBits: bits, createdAt: 1234 });
  const data = JSON.parse(event.content);
  const tag = nonceTag(event);

  // content and tag state the SAME nonce, and it is the top-up we ground for
  assert.equal(data.nonce, String(tag.value));
  assert.equal(data.bits, tag.declaredBits);
  assert.equal(tag.declaredBits, bits, 'the declared top-up is the rung minus the vanity bits');

  // the id is recomputed from the event's own fields, never read off a claim
  const recomputed = computeEventId({
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
  });
  assert.equal(recomputed, event.id, 'id recomputes from the NIP-01 serialisation');
  const actual = leadingZeroBits(recomputed);
  assert.ok(actual >= bits, `the id really carries ${bits} nonce bits (got ${actual})`);

  // the rung is cleared by real work: recomputed vanity bits + recomputed nonce bits
  const vanity = vanityBits(event.pubkey, SMALL);
  assert.equal(vanity, mined.vanityBits, 'vanity bits recompute from the pubkey');
  assert.ok(vanity + actual >= requiredBits(0, SMALL), 'vanity + actual nonce bits clear the rung');
  const verdict = verifyRsvp(event, SMALL);
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.bits, vanity + bits);
  assert.ok(verdict.bits >= requiredBits(0, SMALL));

  // no hidden nonce: content + tags alone reproduce the same id
  const rebuilt = {
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: buildProofTags({ params: SMALL, nonce: data.nonce, bits: data.bits }),
    content: buildProofContent({ bits: data.bits, nonce: data.nonce, npubPrefix: data.npub, params: SMALL }),
  };
  assert.equal(computeEventId(rebuilt), event.id);

  // an event that DECLARES more work than its id carries is rejected
  const forgedTags = event.tags.map((t) => (t[0] === 'nonce' ? ['nonce', t[1], '24'] : t));
  const forged = signWithSecretKey({
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: forgedTags,
    content: event.content,
  }, mined.secretKey);
  assert.ok(leadingZeroBits(forged.id) < 24, 'sanity: the forged declaration really is above the achieved work');
  assert.equal(verifyRsvp(forged, SMALL).reason, REASONS.DECLARED_BITS_EXCEEDS_ACTUAL);
});

test('flow v2: the details follow-up from the same pubkey does not consume a second ladder seat', async () => {
  const { event: proof, mined, declaredBits } = await makeProof({ targetBits: 1, createdAt: 1000 });

  const alone = resolve([proof], SMALL);
  assert.equal(alone.seatsUsed, 1, 'the proof alone takes the seat');
  assert.equal(alone.nextRequiredBits, 5);

  // the details event: SAME mined key, SAME rung top-up — only the content differs
  const detailsTemplate = buildEventTemplate({
    pubkey: mined.pubkey,
    content: JSON.stringify({
      v: 1,
      name: 'Ada Lovelace',
      alias: 'ada',
      intent: 'build',
      skill: 'js',
      idea: 'a relay that counts proofs',
      diet: 'vegan',
      contact: 'nostr:npub1…',
      event: SMALL.eventTag,
    }),
    params: SMALL,
    status: 'accepted',
    createdAt: 1001,
    tags: buildTags({ params: SMALL, status: 'accepted' }),
  });
  const top = await mineNonce({ template: detailsTemplate, targetBits: declaredBits, batch: 64 });
  const details = signWithSecretKey({ ...detailsTemplate, tags: top.tags }, mined.secretKey);

  const dv = verifyRsvp(details, SMALL);
  assert.equal(dv.ok, true, dv.reason);
  assert.equal(details.pubkey, proof.pubkey, 'same mined key');
  assert.equal(dv.bits, verifyRsvp(proof, SMALL).bits, 'both sit on the same rung');
  assert.notEqual(details.id, proof.id, 'a distinct event');

  for (const [label, order] of [['proof first', [proof, details]], ['details first', [details, proof]]]) {
    const r = resolve(order, SMALL);
    assert.equal(r.seatsUsed, 1, `${label}: one seat per pubkey, not two`);
    assert.equal(r.acceptedUnvetted.length, 1);
    assert.equal(r.acceptedCount, 1);
    assert.equal(r.accepted.length, 1);
    assert.equal(r.nextRequiredBits, 5, `${label}: the follow-up does not move the rung`);
    assert.ok(
      r.rejected.some((x) => x.reason === REASONS.DUPLICATE_PUBKEY),
      `${label}: the second event is reported as a duplicate pubkey`,
    );
  }
  assert.equal(resolve([proof, details], SMALL).acceptedCount, alone.acceptedCount, 'seat count unchanged');
});

test('flow v2: the auto-publish guard fires once, only at or above the CURRENT rung, never downhill', () => {
  assert.equal(shouldAutoPublishProof({ published: false, difficulty: 16, rung: 16 }), true);
  assert.equal(shouldAutoPublishProof({ published: false, difficulty: 20, rung: 16 }), true, 'above the rung is fine');
  assert.equal(shouldAutoPublishProof({ published: false, difficulty: 15, rung: 16 }), false, 'never publish below the rung');
  assert.equal(shouldAutoPublishProof({ published: true, difficulty: 20, rung: 16 }), false, 'once per page load');
  assert.equal(shouldAutoPublishProof({ published: false, difficulty: 16, rung: null }), false, 'ladder full');
  assert.equal(shouldAutoPublishProof({ published: false, difficulty: 16, rung: 16, settled: false }), false, 'relay picture still moving');
  assert.equal(shouldAutoPublishProof({ published: false, difficulty: 16, rung: 16, settled: true }), true);
});

// ── 7. the INTENT GATE: the grind starts on an RSVP press, never on page load ─
//
// ADDENDUM 2: a proof event consumes a ladder seat and ratchets the difficulty
// ~2x, so a drive-by page load must not mine. Nothing grinds until the visitor
// presses the RSVP button; the pure predicate below is what the wiring calls,
// and it is also what makes the start idempotent (one press => one worker set).

test('gate: canStartMining() starts the grind only on a fresh, explicit intent', () => {
  // ── no press, no grind ───────────────────────────────────────────────────
  assert.equal(canStartMining(), false, 'the defaults are idle');
  assert.equal(canStartMining({}), false, 'page load must not start the grind');
  assert.equal(canStartMining({ started: false, intent: false }), false);
  assert.equal(canStartMining({ started: false, intent: undefined }), false);
  assert.equal(canStartMining({ started: false, intent: null }), false);
  assert.equal(canStartMining({ started: false, intent: 0 }), false, 'a falsy intent is not a press');
  assert.equal(canStartMining({ started: false, intent: '' }), false);

  // ── a real press starts it ───────────────────────────────────────────────
  assert.equal(canStartMining({ intent: true }), true, 'a fresh intent starts the grind');
  assert.equal(canStartMining({ started: false, intent: true }), true);

  // ── and only once: a second press cannot spawn a second worker set ────────
  assert.equal(canStartMining({ started: true, intent: true }), false, 'already started');
  assert.equal(canStartMining({ started: true, intent: false }), false);

  // ── pure and side-effect free: same argument, same answer, no state ───────
  const fresh = Object.freeze({ started: false, intent: true });
  assert.equal(canStartMining(fresh), true);
  assert.equal(canStartMining(fresh), true, 'twice in a row with the same input');
  assert.deepEqual(canStartMining(fresh), true);
  // an unstarted, unintended page load asked again is STILL idle (nothing latched)
  assert.equal(canStartMining({ started: false, intent: false }), false);
});

test('gate: the wiring exists and page load no longer calls startWorkers()', () => {
  // js/signup.js is a browser module (it imports vendor ESM that touches the DOM
  // lazily), so this asserts on its SOURCE: the gate must be wired, the
  // load-time autostart must be gone, and SELFTEST must press the button.
  const src = readFileSync(new URL('../js/signup.js', import.meta.url), 'utf8');

  assert.match(src, /canStartMining\s*\(/, 'the wiring calls the pure predicate');
  assert.match(src, /get started\(\)/, 'the gate is exposed on the QA surface');
  assert.match(src, /startMiningFromIntent/, 'there is a single start entry point');

  // the DOMContentLoaded handler must not contain a bare startWorkers() call
  const handler = src.slice(src.indexOf("addEventListener('DOMContentLoaded'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.ok(body.length > 0, 'the DOMContentLoaded handler was found');
  assert.ok(!/startWorkers\s*\(/.test(body), 'the grind is NOT started at load any more');
  assert.match(body, /cta-mine/, 'SELFTEST drives the gate through the RSVP button');

  // the button is the only entry point, and it lives outside that handler
  assert.match(src, /cta-mine/, 'js/signup.js looks the RSVP button up');
});
