/**
 * ladder-45.test.mjs — the venue holds 45 people (operator, 2026-09-17).
 *
 * The ladder used to close at the rung cap: `rung(k) = 16 + floor(k/2)` admitted
 * 14 seats and rejected the 15th as LADDER_FULL. That is a cost ladder, not a
 * seat count, and the counter was advertising 14 seats for a 45-seat room.
 *
 * The split now:
 *   · `seats` (45) — the hard seat limit; the 46th unvetted RSVP is LADDER_FULL.
 *   · `cap`   (22) — the highest rung. The rung still climbs +1 bit per 2 seats
 *     and then CLAMPS: seats 15…45 all cost 2^22. Nobody is turned away for being
 *     past a ceiling, and the late-comer cost stays at the design's maximum
 *     (2^38 for seat 43, which no browser could ever mine, is exactly what we
 *     are avoiding).
 *
 * Run: node --test test/ladder-45.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PARAMS, ladderCapacity, ladderTable, requiredBits, resolve } from '../js/pow-ratchet.js';

const SMALL = Object.freeze({ ...DEFAULT_PARAMS, base: 5, cap: 8, step: 1, seatsPerStep: 2, seats: 8, vanityChars: 1 });

test('the shipped ladder has 45 seats', () => {
  assert.equal(DEFAULT_PARAMS.seats, 45, 'the room holds 45');
  assert.equal(ladderCapacity(), 45);
  assert.equal(ladderCapacity(DEFAULT_PARAMS), 45);
});

test('the rung climbs per seat pair and then clamps at the cap', () => {
  assert.equal(requiredBits(0), 16, 'first seat: the floor');
  assert.equal(requiredBits(1), 16);
  assert.equal(requiredBits(2), 17, '+1 bit per 2 seats');
  assert.equal(requiredBits(13), 22);
  assert.equal(requiredBits(14), 22, 'the cap is a ceiling, not a closure');
  assert.equal(requiredBits(30), 22);
  assert.equal(requiredBits(44), 22, 'the last seat costs what the first rung at the cap cost');
  assert.equal(requiredBits(45), null, 'no 46th seat');
  assert.equal(requiredBits(999), null);
});

test('the ladder table has no seat past the cap rung', () => {
  const rows = ladderTable();
  assert.equal(rows.reduce((n, r) => n + r.seats, 0), 45, 'every seat is in the table');
  assert.equal(Math.max(...rows.map((r) => r.bits)), 22, 'the top rung is the cap');
  const top = rows[rows.length - 1];
  assert.equal(top.bits, 22);
  assert.equal(top.seats, 33, 'seats 12…44 share the cap rung');
});

test('resolve() reports the room, not the cost ladder', () => {
  // arithmetic only: an empty ladder reports every seat open
  const empty = resolve([], DEFAULT_PARAMS);
  assert.equal(empty.capacity, 45);
  assert.equal(empty.seatsOpen, 45, 'all 45 seats are open on an empty ladder');
  assert.equal(empty.nextRequiredBits, 16);

  const smallEmpty = resolve([], SMALL);
  assert.equal(smallEmpty.capacity, 8, 'the test ladder still closes at its own seat count');
});

test('the test ladder keeps its own closure semantics', () => {
  assert.equal(ladderCapacity(SMALL), 8);
  assert.equal(requiredBits(7, SMALL), 8, 'the last test seat sits at the test cap');
  assert.equal(requiredBits(8, SMALL), null, 'and the ladder closes there');
});
