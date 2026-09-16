/**
 * pow-ratchet.js — Nostr Hackday RSVP proof-of-work ratchet.
 *
 * Single source of truth shared by three consumers:
 *   • js/signup.js                — the browser signup page (+ js/pow-worker.js)
 *   • scripts/collect-rsvps.mjs   — the org collection / count script
 *   • test/pow-ratchet.test.mjs   — `node --test`
 *
 * ── Protocol (locked decisions, see design-signup-nostr-form.md §1, §2, §5a) ──
 *
 * RSVP event: kind 1337 (regular, NOT replaceable), tagged with the hackday
 * coordinate + a NIP-13 `["nonce", <value>, <bits>]` tag.
 *
 * Identity: primary = ephemeral key generated client-side and discarded; upgrade
 * = NIP-07 extension. No backend, no server fallback, no build step.
 *
 * Proof of work is THREE things, all carried by the event:
 *   1. VISIBLE vanity npub prefix — leet of "nostrhackday", 3 characters at the
 *      floor (n/0/5 → 32^3 = 32 768 keypair generations ≈ 15 bits).
 *   2. VISIBLE low-entropy "raindrop" window — the npub must contain 9
 *      consecutive characters with at most 6 distinct characters. This is the
 *      cheat-resistant stand-in for the rest of the target word ("hackday"),
 *      which could never be mined as an exact 7-character match. ~94% of npubs
 *      already have such a window, so it is a floor everyone pays for free.
 *   3. An exact-rung NIP-13 nonce top-up so total difficulty can hit any bit.
 *      difficulty = 5 * vanity_chars + declared_nonce_bits
 *      (the raindrop window adds NO bits — it is a pass/fail visible property)
 *
 * Ladder / SET rule (order-independent, idempotent, grief-proof):
 *   sort candidates by difficulty DESC (tiebreak created_at ASC, then id ASC),
 *   then accept the LONGEST PREFIX k where difficulty[k] >= requiredBits(k).
 *   requiredBits(k) = BASE + floor(k / SEATS_PER_STEP) * STEP, and the ladder is
 *   closed once that exceeds CAP. Every accepted unvetted RSVP therefore costs
 *   ≈2× the one before it per two seats. Vetted (org allowlist) pubkeys sit at
 *   the floor and never consume ladder seats — the ratchet turns on VERIFIABLE
 *   allowlist membership, never on a claimed identity.
 *
 * Verifier discipline: `verifyRsvp` recomputes the event id from its own
 * canonical NIP-01 serialization, verifies the schnorr signature, and counts
 * the leading zero bits itself. The submitted `id` and the declared nonce bits
 * are never trusted — a declared value above the achieved value is a rejection.
 */

import { sha256 } from '../vendor/esm/@noble/hashes@2.4.0/es2022/sha2.mjs';
import { getPublicKey, verifyEvent, finalizeEvent } from '../vendor/esm/nostr-tools@2.23.3/es2022/pure.bundle.mjs';
import { npubEncode, nsecEncode } from '../vendor/esm/nostr-tools@2.23.3/es2022/nip19.bundle.mjs';

/** RSVP event kind. */
export const RSVP_KIND = 1337;

/** bech32 alphabet — every vanity character must live in it, or it can never appear in an npub. */
export const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/**
 * Locked ratchet parameters.
 *
 * base 16 bits = 3 leet chars = 32^3 tries (~35-55 s single-thread at the
 *   ~850-1300 keys/s measured on the hackday laptop, ~10-20 s on 4 workers),
 *   times the 1.44x the raindrop window adds (see below)
 * cap  22 bits = the highest rung; the ladder then admits no further unvetted RSVPs
 * step +1 bit (2×) per `seatsPerStep` (2) accepted unvetted RSVPs
 */
export const DEFAULT_PARAMS = Object.freeze({
  kind: RSVP_KIND,
  tagName: 'nhr',
  eventTag: '2026-09-29-berlin',
  hashtag: 'nostrhackday',
  base: 16,
  cap: 22,
  step: 1,
  seatsPerStep: 2,

  /** leet of "nostrhackday"; positions are mined left-to-right, 5 bits each. */
  vanityTarget: 'n05trh4ckd4y',
  /** visible floor: how many of those characters must match (3 → 15 bits → 32^3 tries). */
  vanityChars: 3,

  /**
   * "Raindrop" floor — the second, cheap-to-check visible property.
   *
   * The rest of the target word ("hackday") can never be mined as an exact
   * 7-character match (32^7 ≈ 3.4e10). It is represented instead by LOW ENTROPY:
   * a window of `windowSize` characters containing at most `maxUnique` distinct
   * characters is visibly patterned, not noise. W=9 over the 32-char bech32
   * alphabet gives E[unique] = 7.953 (see `expectedUnique`).
   *
   * Measured (scripts in the PR body / `node --test`), not assumed:
   *   P(one given 9-window has ≤6 unique)          = 0.054
   *   mean qualifying windows per 58-char body     = 2.72
   *   P(an ~58-char npub body has at least one)    = 0.695   (Monte-Carlo, 100k bodies)
   *
   * The windows OVERLAP, so their hits are correlated and cannot be treated as
   * 50 independent 0.054 shots (that would give 0.938 and a 1.07x cost — wrong).
   * The honest cost of the floor is 1/0.695 ≈ 1.44x, i.e. ~47k tries instead of
   * 32 768 — STILL CHEAP: everyone can mine it on the day. ≤5 unique would cost
   * far more (measured P ≈ 0.005 per window), so the floor is 6.
   */
  windowSize: 9,
  maxUnique: 6,

  /** pubkeys exempt from the ladder (org allowlist). They still pay the floor. */
  vettedPubkeys: [],

  maxContentBytes: 4096,

  /** write set — verified reachable/accepting by scripts/relay-probe.mjs */
  publishRelays: [
    'wss://nostr.mom',
    'wss://offchain.pub',
    'wss://purplepag.es',
    'wss://relay.primal.net',
    'wss://relay.orangesync.tech',
  ],
});

/** Stable rejection reason codes (safe to render, log, or assert on). */
export const REASONS = Object.freeze({
  NOT_AN_OBJECT: 'not-an-object',
  BAD_ID_FORMAT: 'bad-id-format',
  BAD_PUBKEY_FORMAT: 'bad-pubkey-format',
  BAD_SIG_FORMAT: 'bad-sig-format',
  BAD_CREATED_AT: 'bad-created-at',
  WRONG_KIND: 'wrong-kind',
  BAD_TAGS: 'bad-tags',
  BAD_CONTENT: 'bad-content',
  CONTENT_TOO_LARGE: 'content-too-large',
  ID_MISMATCH: 'id-mismatch',
  BAD_SIGNATURE: 'bad-signature',
  MISSING_EVENT_TAG: 'missing-event-tag',
  MISSING_NONCE_TAG: 'missing-nonce-tag',
  BAD_NONCE_TAG: 'bad-nonce-tag',
  DECLARED_BITS_EXCEEDS_ACTUAL: 'declared-bits-exceeds-actual',
  VANITY_FLOOR: 'vanity-floor',
  LOW_ENTROPY_MISSING: 'low-entropy-missing',
  DUPLICATE_PUBKEY: 'duplicate-pubkey',
  LADDER_FULL: 'ladder-full',
  INSUFFICIENT_DIFFICULTY: 'insufficient-difficulty',
});

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Ladder maths
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Required difficulty (bits) for the k-th accepted unvetted RSVP, or `null` when
 * the ladder is closed (that rung would exceed CAP).
 */
export function requiredBits(k, params = DEFAULT_PARAMS) {
  if (!Number.isInteger(k) || k < 0) throw new TypeError(`requiredBits(k): k must be a non-negative integer, got ${k}`);
  const bits = params.base + Math.floor(k / params.seatsPerStep) * params.step;
  return bits > params.cap ? null : bits;
}

/** How many unvetted RSVPs the ladder can ever admit. */
export function ladderCapacity(params = DEFAULT_PARAMS) {
  let k = 0;
  while (requiredBits(k, params) !== null) k += 1;
  return k;
}

/** Rungs as a table — used by the page UI and by the tests. */
export function ladderTable(params = DEFAULT_PARAMS) {
  const rows = [];
  for (let k = 0; k < ladderCapacity(params); k += 1) {
    const bits = requiredBits(k, params);
    if (rows.length && rows[rows.length - 1].bits === bits) rows[rows.length - 1].seats += 1;
    else rows.push({ bits, seats: 1 });
  }
  return rows;
}

/** Bit difficulty contributed by a vanity prefix of `chars` matching characters (5 bits each). */
export function vanityBitsForChars(chars) {
  return 5 * chars;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vanity / npub
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Longest prefix of the npub (after the `npub1` separator) matching the leet
 * target, plus the derived bits.
 */
export function vanityInfo(pubkey, params = DEFAULT_PARAMS) {
  const npub = npubEncode(pubkey);
  const target = params.vanityTarget;
  const body = npub.startsWith('npub1') ? npub.slice(5) : npub;
  let chars = 0;
  while (chars < target.length && chars < body.length && body[chars] === target[chars]) chars += 1;
  return {
    npub,
    target,
    chars,
    bits: vanityBitsForChars(chars),
    matched: body.slice(0, chars),
    /** the non-mined tail you should eyeball when verifying (orange anti-phish band) */
    fingerprint: body.slice(chars, chars + 4),
    meetsFloor: chars >= params.vanityChars,
    requiredChars: params.vanityChars,
    body,
  };
}

/** Bit difficulty of a pubkey's visible vanity prefix. */
export function vanityBits(pubkey, params = DEFAULT_PARAMS) {
  return vanityInfo(pubkey, params).bits;
}

// ─────────────────────────────────────────────────────────────────────────────
// "Raindrop" — the low-entropy window floor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expected number of DISTINCT characters in a window of `windowSize` drawn
 * uniformly from an alphabet of `alphabetSize` (occupancy problem): each
 * character of the alphabet is absent with probability ((A-1)/A)^W, so
 * E[unique] = A * (1 − ((A−1)/A)^W). Bech32 has A = 32, so W=9 → 7.953.
 */
export function expectedUnique(windowSize, alphabetSize = BECH32_CHARSET.length) {
  const size = Math.max(1, Math.floor(windowSize));
  return alphabetSize * (1 - Math.pow((alphabetSize - 1) / alphabetSize, size));
}

/**
 * Scan the bech32 DATA part of an npub (everything after `npub1`) for the
 * lowest-entropy OVERLAPPING window of `windowSize` characters.
 *
 * A window with few distinct characters repeats itself visibly — the npub shows
 * a "raindrop" of repeated colours instead of flat noise. That is the cheap,
 * eyeball-checkable stand-in for the part of the target word that cannot be
 * mined as an exact match.
 *
 * @returns {{found:boolean, start:number, chars:string, unique:number|null,
 *            expected:number, rarity:number, windowSize:number, maxUnique:number,
 *            windows:Array<{start:number,chars:string,unique:number,rarity:number}>, body:string}}
 *   `found` is true iff the best window has `unique <= maxUnique`. The best
 *   window is the one with the lowest `unique`, tie-broken by the EARLIEST
 *   `start`. When the body is shorter than one window, `windows` is empty,
 *   `start` is -1 and `unique` is null.
 */
export function scanLowEntropyWindows(
  npub,
  { windowSize = DEFAULT_PARAMS.windowSize, maxUnique = DEFAULT_PARAMS.maxUnique } = {},
) {
  const size = Math.max(1, Math.floor(windowSize) || 1);
  const body = typeof npub === 'string' ? (npub.startsWith('npub1') ? npub.slice(5) : npub) : '';
  const expected = expectedUnique(size);
  const windows = [];
  let best = null;

  for (let start = 0; start + size <= body.length; start += 1) {
    const chars = body.slice(start, start + size);
    const seen = new Set();
    for (const c of chars) seen.add(c);
    const unique = seen.size;
    // strictly lower keeps the EARLIEST start among equally low-entropy windows
    if (best === null || unique < best.unique) {
      best = { start, chars, unique, rarity: expected - unique };
    }
    windows.push({ start, chars, unique, rarity: expected - unique });
  }

  return {
    found: best !== null && best.unique <= maxUnique,
    start: best ? best.start : -1,
    chars: best ? best.chars : '',
    unique: best ? best.unique : null,
    expected,
    rarity: best ? best.rarity : 0,
    windowSize: size,
    maxUnique,
    windows,
    body,
  };
}

/** Short human label for a scan result, e.g. `6 unique in 9 · rarity 2.0`. */
export function lowEntropyLabel(scan) {
  if (!scan || scan.unique === null || scan.unique === undefined) return 'no window';
  return `${scan.unique} unique in ${scan.windowSize} · rarity ${scan.rarity.toFixed(1)}`;
}

/** One-line description of the criterion itself (used in rejection messages). */
export function lowEntropyCriterion(params = DEFAULT_PARAMS) {
  return `an npub must contain a ${params.windowSize}-character window with <= ${params.maxUnique} unique characters`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event id / nonce / PoW measurement
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical NIP-01 serialization (compact, no whitespace). */
export function serializeEvent(event) {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

/** Recompute the event id ourselves: sha256 over the canonical serialization. */
export function computeEventId(event) {
  return bytesToHex(sha256(new TextEncoder().encode(serializeEvent(event))));
}

/** Number of leading zero BITS of a hex string (bit-exact, not nibble-approx). */
export function leadingZeroBits(hex) {
  if (typeof hex !== 'string' || hex.length === 0) return 0;
  let bits = 0;
  for (let i = 0; i < hex.length; i += 1) {
    const nibble = parseInt(hex[i], 16);
    if (Number.isNaN(nibble)) return bits;
    if (nibble === 0) { bits += 4; continue; }
    bits += Math.clz32(nibble) - 28;
    break;
  }
  return bits;
}

/** The `["nonce", value, bits]` tag, if present. */
export function nonceTag(event) {
  if (!Array.isArray(event?.tags)) return null;
  const tag = event.tags.find((t) => Array.isArray(t) && t[0] === 'nonce');
  if (!tag) return null;
  const raw = tag[2];
  const bits = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  return { tag, value: tag[1], declaredBits: Number.isFinite(bits) ? bits : null };
}

/** Total difficulty of an event: vanity bits + verified nonce top-up. */
export function difficultyOf(event, params = DEFAULT_PARAMS) {
  const info = vanityInfo(event.pubkey, params);
  const nonce = nonceTag(event);
  const actual = leadingZeroBits(event.id);
  const declared = nonce?.declaredBits ?? 0;
  return {
    vanityChars: info.chars,
    vanityBits: info.bits,
    declaredNonceBits: declared,
    actualNonceBits: actual,
    bits: info.bits + Math.min(declared, actual),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification
// ─────────────────────────────────────────────────────────────────────────────

/** Verification results are cached by id+sig (the id alone does not bind the signature). */
const VERIFY_CACHE = new Map();
const VERIFY_CACHE_MAX = 512;

function plainEvent(event) {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  };
}

export function isVetted(pubkey, params = DEFAULT_PARAMS) {
  return (params.vettedPubkeys ?? []).includes(pubkey);
}

/**
 * Full independent verification of one RSVP.
 *
 * @returns {{ok: true, ...}|{ok: false, reason: string, ...}}
 */
export function verifyRsvp(event, params = DEFAULT_PARAMS) {
  const fail = (reason, extra = {}) => ({ ok: false, reason, event, ...extra });

  if (!event || typeof event !== 'object' || Array.isArray(event)) return fail(REASONS.NOT_AN_OBJECT);
  const { id, pubkey, sig, created_at, kind, tags, content } = event;

  if (typeof id !== 'string' || !HEX64.test(id)) return fail(REASONS.BAD_ID_FORMAT);
  if (typeof pubkey !== 'string' || !HEX64.test(pubkey)) return fail(REASONS.BAD_PUBKEY_FORMAT);
  if (typeof sig !== 'string' || !HEX128.test(sig)) return fail(REASONS.BAD_SIG_FORMAT);
  if (!Number.isInteger(created_at) || created_at <= 0) return fail(REASONS.BAD_CREATED_AT);
  if (kind !== params.kind) return fail(REASONS.WRONG_KIND, { got: kind, want: params.kind });
  if (!Array.isArray(tags) || !tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))) {
    return fail(REASONS.BAD_TAGS);
  }
  if (typeof content !== 'string') return fail(REASONS.BAD_CONTENT);
  if (byteLength(content) > params.maxContentBytes) {
    return fail(REASONS.CONTENT_TOO_LARGE, { bytes: byteLength(content), max: params.maxContentBytes });
  }

  // 1. Recompute the id ourselves — a submitted id we didn't derive is worthless.
  const recomputedId = computeEventId(plainEvent(event));
  if (recomputedId !== id) return fail(REASONS.ID_MISMATCH, { recomputedId });

  // 2. Verify the schnorr signature ourselves (over the recomputed id).
  const cacheKey = `${id}:${sig}`;
  let signatureOk = VERIFY_CACHE.get(cacheKey);
  if (signatureOk === undefined) {
    try {
      signatureOk = verifyEvent(plainEvent(event));
    } catch {
      signatureOk = false;
    }
    if (VERIFY_CACHE.size >= VERIFY_CACHE_MAX) VERIFY_CACHE.clear();
    VERIFY_CACHE.set(cacheKey, signatureOk);
  }
  if (!signatureOk) return fail(REASONS.BAD_SIGNATURE);

  // 3. Must be tagged for THIS hackday.
  const hasCoordinate = tags.some((t) => t[0] === params.tagName && t[1] === params.eventTag);
  if (!hasCoordinate) return fail(REASONS.MISSING_EVENT_TAG, { tagName: params.tagName, eventTag: params.eventTag });

  // 4. Nonce tag must exist, be well-formed, and must not overclaim.
  const nonce = nonceTag(event);
  if (!nonce) return fail(REASONS.MISSING_NONCE_TAG);
  if (nonce.declaredBits === null || nonce.declaredBits < 0 || nonce.declaredBits > 64) {
    return fail(REASONS.BAD_NONCE_TAG, { nonce: nonce.tag });
  }
  const actualNonceBits = leadingZeroBits(id);
  if (nonce.declaredBits > actualNonceBits) {
    return fail(REASONS.DECLARED_BITS_EXCEEDS_ACTUAL, {
      declaredBits: nonce.declaredBits,
      actualBits: actualNonceBits,
    });
  }

  // 5. Visible vanity floor.
  const info = vanityInfo(pubkey, params);
  if (info.chars < params.vanityChars) {
    return fail(REASONS.VANITY_FLOOR, {
      npub: info.npub,
      vanityChars: info.chars,
      requiredChars: params.vanityChars,
    });
  }

  // 6. Low-entropy "raindrop" floor: the npub must contain at least one window
  //    of `windowSize` characters with at most `maxUnique` distinct characters.
  //    This is the visible stand-in for the unmineable half of the target word.
  const scan = scanLowEntropyWindows(info.npub, params);
  if (!scan.found) {
    return fail(REASONS.LOW_ENTROPY_MISSING, {
      npub: info.npub,
      windowSize: scan.windowSize,
      maxUnique: scan.maxUnique,
      bestUnique: scan.unique,
      bestStart: scan.start,
      criterion: lowEntropyCriterion({ windowSize: scan.windowSize, maxUnique: scan.maxUnique }),
      text:
        `no ${scan.windowSize}-character window with <= ${scan.maxUnique} unique characters ` +
        `(lowest unique found: ${scan.unique === null ? 'no window fits' : scan.unique})`,
      lowEntropy: scan,
    });
  }

  return {
    ok: true,
    event,
    id,
    pubkey,
    npub: info.npub,
    vanity: info,
    vanityChars: info.chars,
    vanityBits: info.bits,
    nonceValue: nonce.value,
    nonceBits: nonce.declaredBits,
    actualNonceBits,
    bits: info.bits + nonce.declaredBits,
    vetted: isVetted(pubkey, params),
    lowEntropy: scan,
    lowEntropyUnique: scan.unique,
    lowEntropyStart: scan.start,
    lowEntropyRarity: scan.rarity,
  };
}

/** "Best of the same pubkey" ordering — a strict total order, so dedupe is order-independent. */
function betterOf(a, b) {
  if (!b) return a;
  if (a.bits !== b.bits) return a.bits > b.bits ? a : b;
  if (a.event.created_at !== b.event.created_at) return a.event.created_at > b.event.created_at ? a : b;
  return a.id < b.id ? a : b;
}

/** Human-readable view of an RSVP's content JSON (all fields optional). */
export function describeRsvp(event) {
  let data = {};
  try {
    const parsed = JSON.parse(event.content || '{}');
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch { /* content is free-form JSON; ignore parse failures */ }
  const status = event.tags.find((t) => t[0] === 'status')?.[1] ?? null;
  return {
    name: typeof data.name === 'string' ? data.name : null,
    alias: typeof data.alias === 'string' ? data.alias : null,
    intent: typeof data.intent === 'string' ? data.intent : null,
    status,
    idea: typeof data.idea === 'string' ? data.idea : null,
    contact: data.contact && typeof data.contact === 'object' ? data.contact : null,
    diet: typeof data.diet === 'string' ? data.diet : null,
  };
}

/**
 * The SET rule. Given ANY set of candidate RSVP events (any order, duplicates
 * included) return the accepted set, the rejected set, and the difficulty the
 * next unvetted RSVP must reach.
 *
 * Idempotent and order-independent: shuffle or dedupe the input first and you
 * get bit-identical output.
 */
export function resolve(events, params = DEFAULT_PARAMS) {
  const rejected = [];
  const byPubkey = new Map();

  const list = Array.isArray(events) ? events : [];
  for (const event of list) {
    const verdict = verifyRsvp(event, params);
    if (!verdict.ok) {
      rejected.push({ id: safeId(event), pubkey: safePubkey(event), reason: verdict.reason, detail: verdict });
      continue;
    }
    const incumbent = byPubkey.get(verdict.pubkey);
    if (!incumbent) {
      byPubkey.set(verdict.pubkey, verdict);
      continue;
    }
    const winner = betterOf(verdict, incumbent);
    const loser = winner === verdict ? incumbent : verdict;
    rejected.push({ id: loser.id, pubkey: loser.pubkey, reason: REASONS.DUPLICATE_PUBKEY, detail: loser });
    byPubkey.set(verdict.pubkey, winner);
  }

  const candidates = [...byPubkey.values()];
  const vetted = candidates.filter((c) => c.vetted).sort(compareForLadder);
  const unvetted = candidates.filter((c) => !c.vetted).sort(compareForLadder);

  const acceptedVetted = vetted.map((v) => ({ ...v, seat: null, rung: params.base, vetted: true }));

  const accepted = [];
  let stopped = false;
  for (let k = 0; k < unvetted.length; k += 1) {
    const rung = requiredBits(k, params);
    const candidate = unvetted[k];
    if (rung === null) {
      rejected.push({ id: candidate.id, pubkey: candidate.pubkey, reason: REASONS.LADDER_FULL, detail: candidate });
      stopped = true;
      continue;
    }
    if (candidate.bits >= rung) {
      accepted.push({ ...candidate, seat: k, rung, vetted: false });
    } else {
      rejected.push({ id: candidate.id, pubkey: candidate.pubkey, reason: REASONS.INSUFFICIENT_DIFFICULTY, detail: { ...candidate, rung } });
      stopped = true;
    }
  }

  const nextRung = requiredBits(accepted.length, params);

  return {
    accepted: [...accepted, ...acceptedVetted].sort((a, b) => b.bits - a.bits || a.event.created_at - b.event.created_at || (a.id < b.id ? -1 : 1)),
    acceptedUnvetted: accepted,
    acceptedVetted,
    rejected,
    acceptedCount: accepted.length + acceptedVetted.length,
    rejectedCount: rejected.length,
    nextRequiredBits: nextRung,
    ladderFull: nextRung === null,
    ladderClosed: stopped && nextRung === null,
    capacity: ladderCapacity(params),
    seatsUsed: accepted.length,
    seatsOpen: nextRung === null ? 0 : ladderCapacity(params) - accepted.length,
    params,
  };
}

function compareForLadder(a, b) {
  if (a.bits !== b.bits) return b.bits - a.bits;            // higher difficulty first
  if (a.event.created_at !== b.event.created_at) return a.event.created_at - b.event.created_at; // older first
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;            // stable id tiebreak
}

// ─────────────────────────────────────────────────────────────────────────────
// Mining
// ─────────────────────────────────────────────────────────────────────────────

const U32 = new Uint32Array(1);

function writeU32(buf, offset, value) {
  U32[0] = value >>> 0;
  buf[offset] = U32[0] & 0xff;
  buf[offset + 1] = (U32[0] >>> 8) & 0xff;
  buf[offset + 2] = (U32[0] >>> 16) & 0xff;
  buf[offset + 3] = (U32[0] >>> 24) & 0xff;
}

/**
 * Deterministic, uniform, non-repeating candidate secret key for
 * (seed, workerIndex, counter). Each worker grinds a disjoint key space, so N
 * workers never redo the same candidate work.
 */
export function deriveCandidate(seed, workerIndex, counter) {
  const buf = new Uint8Array(40);
  buf.set(seed.subarray(0, 32), 0);
  writeU32(buf, 32, workerIndex);
  writeU32(buf, 36, counter);
  return sha256(buf);
}

export function randomSeed() {
  const seed = new Uint8Array(32);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(seed);
  else for (let i = 0; i < 32; i += 1) seed[i] = Math.floor(Math.random() * 256);
  return seed;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Grind for a keypair that clears BOTH visible floors:
 *   · npub starts with `params.vanityChars` leet characters, and
 *   · the npub body contains a low-entropy window (`params.windowSize` chars
 *     with at most `params.maxUnique` unique characters) — the "raindrop".
 * The window check only runs on prefix hits (~1/32^vanityChars of candidates),
 * and ~69.5% of those already have one (measured), so the extra floor costs
 * ≈1.44x — the minted keys ALWAYS carry a raindrop, by construction.
 * Yields to the event loop between batches so a Worker stays responsive and can
 * be stopped/retargeted mid-grind.
 *
 * @returns {Promise<{secretKey: Uint8Array, pubkey: string, npub: string, vanityChars: number, vanityBits: number, scan: object, tries: number, elapsedMs: number}>}
 */
export async function mineVanityKey({
  seed = randomSeed(),
  workerIndex = 0,
  params = DEFAULT_PARAMS,
  batch = 48,
  startCounter = 0,
  onProgress,
  shouldStop,
} = {}) {
  const startedAt = Date.now();
  let counter = startCounter;
  // A few of the candidates we actually tried, so the page can show the real
  // search space scrolling past (vanityInfo already encodes the npub for the
  // prefix test, so sampling costs no extra hashing).
  const samples = [];
  for (;;) {
    for (let i = 0; i < batch; i += 1) {
      const secretKey = deriveCandidate(seed, workerIndex, counter);
      counter += 1;
      const pubkey = getPublicKey(secretKey);
      const info = vanityInfo(pubkey, params);
      if (info.chars >= params.vanityChars) {
        // prefix landed — now pay the cheap second floor. Scanning is 50 window
        // tests and only ever runs on a prefix hit, so it never touches the
        // hot loop's cost.
        const scan = scanLowEntropyWindows(info.npub, params);
        if (scan.found) {
          return {
            secretKey,
            pubkey,
            npub: info.npub,
            vanityChars: info.chars,
            vanityBits: info.bits,
            /** the raindrop window of THIS npub — callers never need to re-scan */
            scan,
            lowEntropy: scan,
            tries: counter - startCounter,
            elapsedMs: Date.now() - startedAt,
            seed,
            workerIndex,
            endCounter: counter,
            samples: [...samples],
          };
        }
      }
      samples.push({ npub: info.npub, chars: info.chars });
      if (samples.length > 4) samples.shift();
    }
    if (onProgress) {
      const elapsedMs = Date.now() - startedAt;
      onProgress({
        phase: 'vanity',
        tries: counter - startCounter,
        elapsedMs,
        keysPerSecond: elapsedMs > 0 ? Math.round(((counter - startCounter) / elapsedMs) * 1000) : 0,
        samples: [...samples],
      });
    }
    samples.length = 0;
    if (shouldStop?.()) return null;
    await sleep(0);
  }
}

/** Base tag list for an RSVP (the nonce tag is appended by mineNonce). */
export function buildTags({ params = DEFAULT_PARAMS, status = 'accepted', extraTags = [] } = {}) {
  return [
    ['t', params.hashtag],
    [params.tagName, params.eventTag],
    ['status', status],
    ['client', 'nostrhackday-signup'],
    ...extraTags,
  ];
}

/**
 * Unsigned event template. Same shape for every signer — this is what makes the
 * PoW signer-agnostic: mine once, then let the ephemeral key OR a NIP-07
 * extension sign the identical template (id/kind/tags/content are identical;
 * the id changes only if the signing pubkey differs, which is why the nonce
 * grind takes the pubkey as an input).
 */
export function buildEventTemplate({
  pubkey,
  content = '{}',
  params = DEFAULT_PARAMS,
  status = 'accepted',
  createdAt = Math.floor(Date.now() / 1000),
  tags = null,
} = {}) {
  return {
    pubkey,
    created_at: createdAt,
    kind: params.kind,
    tags: tags ?? buildTags({ params, status }),
    content,
  };
}

/**
 * Nonce top-up grind: vary the `["nonce", value, bits]` tag until the event id
 * carries at least `targetBits` leading zero bits. The declared bits are the
 * exact rung the miner committed to, so difficulty = vanityBits + targetBits.
 */
export async function mineNonce({
  template,
  targetBits,
  startNonce = 0,
  batch = 64,
  onProgress,
  shouldStop,
} = {}) {
  const startedAt = Date.now();
  const target = Math.max(0, Math.floor(targetBits));
  const tags = [...template.tags, ['nonce', '0', String(target)]];
  const nonceTagRef = tags[tags.length - 1];
  let counter = startNonce;
  let seen = 0;

  const attempt = () => {
    nonceTagRef[1] = String(counter);
    const id = computeEventId({ ...template, tags });
    counter += 1;
    seen += 1;
    return leadingZeroBits(id) >= target ? id : null;
  };

  if (target === 0) {
    const id = attempt();
    return { id, nonce: String(counter - 1), declaredBits: 0, actualBits: leadingZeroBits(id), tags, tries: 1, elapsedMs: Date.now() - startedAt };
  }

  for (;;) {
    for (let i = 0; i < batch; i += 1) {
      const id = attempt();
      if (id) {
        const actualBits = leadingZeroBits(id);
        return {
          id,
          nonce: String(counter - 1),
          declaredBits: target,
          actualBits,
          tags,
          tries: seen,
          elapsedMs: Date.now() - startedAt,
        };
      }
    }
    if (onProgress) {
      const elapsedMs = Date.now() - startedAt;
      onProgress({
        phase: 'nonce',
        tries: seen,
        targetBits: target,
        elapsedMs,
        hashesPerSecond: elapsedMs > 0 ? Math.round((seen / elapsedMs) * 1000) : 0,
      });
    }
    if (shouldStop?.()) return null;
    await sleep(0);
  }
}

/** Sign a mined template with a raw secret key (ephemeral path). */
export function signWithSecretKey(template, secretKey) {
  return finalizeEvent(template, secretKey);
}

/** Export an ephemeral secret as nsec (only ever called on explicit user request). */
export function secretKeyToNsec(secretKey) {
  return nsecEncode(secretKey);
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

export function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

export function safeId(event) {
  return typeof event?.id === 'string' ? event.id : null;
}

export function safePubkey(event) {
  return typeof event?.pubkey === 'string' ? event.pubkey : null;
}

/** Everything the ratchet needs to know about one submission, for logging/UI. */
export function summarize(verdict) {
  if (!verdict?.ok) return `rejected(${verdict?.reason ?? 'unknown'})`;
  const drop = verdict.lowEntropyUnique === undefined || verdict.lowEntropyUnique === null
    ? ''
    : ` raindrop=${verdict.lowEntropyUnique}/${verdict.lowEntropy?.windowSize ?? '?'}u`;
  return `${verdict.npub.slice(0, 5 + verdict.vanityChars)}… chars=${verdict.vanityChars} nonce=${verdict.nonceBits}b/${verdict.actualNonceBits}b total=${verdict.bits}b${drop}${verdict.vetted ? ' vetted' : ''}`;
}
