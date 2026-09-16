#!/usr/bin/env node
/**
 * collect-rsvps.mjs — org-side collection / counting script.
 *
 * Pulls the RSVP events for the hackday off the public relays, runs them through
 * the SAME verifier the page and the test use (`js/pow-ratchet.js`), and prints
 * the accepted set, the rejected set with reasons, and the difficulty the next
 * unvetted RSVP has to reach.
 *
 * This is the "authoritative" side of the ratchet: it trusts nothing that came
 * over the wire except the raw event bytes. The submitted id is recomputed, the
 * schnorr signature is verified, the leading zero bits are counted here.
 *
 * Usage:
 *   node scripts/collect-rsvps.mjs
 *   node scripts/collect-rsvps.mjs --relays wss://relay.orangesync.tech --wait 12000
 *   node scripts/collect-rsvps.mjs --vetted vetted-pubkeys.json --json accepted.json
 *   node scripts/collect-rsvps.mjs --params '{"base":16,"cap":22}'      (preview a ladder)
 *
 * Flags:
 *   --relays a,b,c   relays to query            (default: params.publishRelays)
 *   --wait ms        how long to listen         (default 8000)
 *   --vetted file    JSON array of allowlisted pubkeys (hex), or {"vettedPubkeys":[...]}
 *   --params json    override ladder params (must match what the page used)
 *   --json file      also write {accepted, rejected, nextRequiredBits} as JSON
 *   --quiet          only print the summary line
 */
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import { EventStore } from '../vendor/esm/applesauce-core@6.2.0/es2022/applesauce-core.bundle.mjs';
import { RelayPool } from '../vendor/esm/applesauce-relay@6.2.1/es2022/applesauce-relay.bundle.mjs';
import { DEFAULT_PARAMS, describeRsvp, resolve, summarize } from '../js/pow-ratchet.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

let params = DEFAULT_PARAMS;
if (flag('params')) params = { ...params, ...JSON.parse(flag('params')) };
if (flag('vetted')) {
  const raw = JSON.parse(readFileSync(flag('vetted'), 'utf8'));
  params = { ...params, vettedPubkeys: Array.isArray(raw) ? raw : raw.vettedPubkeys ?? [] };
}
const relays = flag('relays') ? flag('relays').split(',').filter(Boolean) : params.publishRelays;
const waitMs = Number(flag('wait', 8000));
const quiet = has('quiet');
const filter = { kinds: [params.kind], '#nhr': [params.eventTag] };

const log = (...args) => { if (!quiet) console.log(...args); };

async function main() {
  const store = new EventStore();
  const pool = new RelayPool();
  let received = 0;
  let lastEventAt = Date.now();

  log(`querying ${relays.length} relays for kind ${params.kind} tagged ["${params.tagName}","${params.eventTag}"]`);
  log(`ladder: base ${params.base} bits · +${params.step} bit every ${params.seatsPerStep} accepted · cap ${params.cap} bits · vanity floor ${params.vanityChars} chars`);
  if (params.vettedPubkeys.length) log(`vetted allowlist: ${params.vettedPubkeys.length} pubkey(s)`);

  // One subscription. The EventStore verifies every signature before storing it,
  // so a relay cannot smuggle in an unverifiable event.
  const sub = pool
    .subscription(relays, filter, { reconnect: false, resubscribe: false })
    .subscribe({
      next: (value) => {
        if (value === 'EOSE') return; // RelayPool collapses per-relay EOSE markers
        received += 1;
        lastEventAt = Date.now();
        store.add(value);
      },
      error: (e) => log(`  ! subscription error: ${e?.message ?? e}`),
    });

  // RelayPool does not forward per-relay EOSE markers, so we settle on silence:
  // stop after `idleMs` without a new event, or after the hard `--wait` ceiling.
  const idleMs = Math.min(2500, waitMs);
  await new Promise((done) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      const idle = received > 0 && Date.now() - lastEventAt > idleMs;
      const capped = Date.now() - startedAt > waitMs;
      if (idle || capped) {
        clearInterval(poll);
        sub.unsubscribe();
        log(`  settled after ${Date.now() - startedAt}ms (${received} event(s)${capped ? ', hit --wait ceiling' : ', quiet period'})`);
        done();
      }
    }, 150);
  });

  const events = store.getByFilters(filter);
  const result = resolve(events, params);
  pool.close();

  log(`\nreceived ${events.length} event(s) · accepted ${result.accepted.length} · rejected ${result.rejectedCount} · unvetted seats used ${result.seatsUsed}/${result.capacity}`);
  log(`next unvetted RSVP needs: ${result.nextRequiredBits === null ? 'ladder is FULL (cap reached)' : `${result.nextRequiredBits} bits`}\n`);

  log('ACCEPTED (sorted by difficulty → seat)');
  for (const entry of result.accepted) {
    const who = describeRsvp(entry.event);
    const seat = entry.vetted ? 'vetted' : `seat ${entry.seat}`;
    log(`  ${entry.bits.toString().padStart(2)}b  ${seat.padEnd(8)} ${summarize(entry)}  ${who.name ?? '—'}${who.intent ? ` (${who.intent})` : ''}`);
    log(`        id ${entry.id}`);
  }

  if (result.rejected.length && !quiet) {
    log('\nREJECTED / not counted');
    const byReason = new Map();
    for (const r of result.rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) log(`  ${String(count).padStart(3)}  ${reason}`);
  }

  const summaryLine = `accepted=${result.accepted.length} rejected=${result.rejectedCount} seatsUsed=${result.seatsUsed} capacity=${result.capacity} nextRequiredBits=${result.nextRequiredBits}`;
  console.log(summaryLine);

  if (flag('json')) {
    writeFileSync(
      flag('json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          params,
          relays,
          events: events.length,
          accepted: result.accepted.map((e) => ({
            id: e.id,
            pubkey: e.pubkey,
            npub: e.npub,
            bits: e.bits,
            vanityChars: e.vanityChars,
            nonceBits: e.nonceBits,
            seat: e.seat,
            rung: e.rung,
            vetted: e.vetted,
            ...describeRsvp(e.event),
          })),
          rejected: result.rejected.map((r) => ({ id: r.id, pubkey: r.pubkey, reason: r.reason })),
          nextRequiredBits: result.nextRequiredBits,
        },
        null,
        2,
      ),
    );
    console.log(`wrote ${flag('json')}`);
  }
}

main().catch((e) => {
  console.error(`collect-rsvps failed: ${e?.stack ?? e}`);
  process.exit(1);
});
