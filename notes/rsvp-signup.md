# RSVP signup: the proof-of-work ratchet (operator notes)

Design: `design-signup-nostr-form.md`. Implementation: `signup.html` + `js/*.js`.
Everything below is the *operational* view: what the parameters are, how to count
RSVPs, and how to change the ladder without breaking the invariant.

## the shape of an RSVP

One nostr event, kind **1337** (regular, not replaceable), tagged for this hackday:

```json
{
  "kind": 1337,
  "tags": [
    ["t", "nostrhackday"],
    ["nhr", "2026-09-29-berlin"],
    ["status", "accepted"],
    ["client", "nostrhackday-signup"],
    ["nonce", "<counter>", "<declared bit difficulty>"]
  ],
  "content": "{\"v\":1,\"name\":\"…\",\"intent\":\"build\",\"idea\":\"…\"}"
}
```

Difficulty = **leet npub prefix bits + NIP-13 nonce bits**:

* the leet prefix (`npub1n05…` → `n05…` = "nostrhackday" in leet) is *free to
  check with your eyes*: 3 matched bech32 characters = 15 bits ≈ 2¹⁵ keygens;
* the nonce tag carries the exact rung of the ladder on top of that.

## the ladder

| parameter | value | meaning |
| --- | --- | --- |
| `base` | 16 bits | floor for the first seat (15 vanity + 1 nonce) |
| `step` | +1 bit | every `seatsPerStep` accepted RSVPs |
| `seatsPerStep` | 2 | so `rung(k) = 16 + floor(k/2)` |
| `cap` | 22 bits | ladder closes; **14 unvetted seats** total |
| `vanityChars` | 3 | visible floor (`n05`), ~32³ = 32,768 keygens ≈ 1 min single-thread |

Acceptance is **sticky** — a seat, once taken, is never re-judged:

1. drop anything that fails verification (below);
2. keep one event per pubkey (highest difficulty wins, ties by newest);
3. sort by `created_at` asc, then `id` asc (arrival order);
4. walk that order and accept each event whose `bits >= rung(seats accepted so
   far)`. A failure is rejected and does not consume a seat, but the next
   candidate is judged at the same rung.

The result is still a pure function of the event set — shuffle the input, dedupe
it, replay it in a different order and you get an identical answer — but it is
**time-priority**, not strength-priority. An accepted seat is never displaced when
a stronger RSVP arrives later, so the accepted count cannot go down.

> Before 2026-09-17 the rule re-ranked by difficulty DESC and accepted the
> longest prefix (`bits[k] >= rung(k)`). Rungs ascend while difficulties descend,
> so the weakest accepted member was the binding constraint and a rung that
> climbed under it could retroactively reject an already-seated RSVP — the
> "accepted resets / counter drops" reports. Sticky fixes that class.
>
> Tradeoff: `created_at` is now load-bearing, so an event could be backdated to
> grab a cheaper early rung. Difficulty (vanity + nonce bits) is still recomputed
> by `verifyRsvp()`, so only the clock can be gamed, and only across 1-bit rungs.

### vetted attendees

Pubkeys in `params.vettedPubkeys` (the org allowlist) sit at the floor and
**do not consume ladder seats**, so organising the event does not push the
ratchet up. They still have to clear the visible floor — the ratchet is keyed on
a *verifiable* property (allowlist membership), never on a claimed one.

Set the allowlist in code (`js/pow-ratchet.js` → `DEFAULT_PARAMS.vettedPubkeys`)
or pass it at collection time (`scripts/collect-rsvps.mjs --vetted file.json`).
Put the same list in both places or the page and the collection will disagree.

## counting RSVPs (org side)

```sh
node scripts/collect-rsvps.mjs                        # all configured relays
node scripts/collect-rsvps.mjs --wait 12000 --json accepted.json
node scripts/collect-rsvps.mjs --relays wss://relay.orangesync.tech --vetted vetted.json
```

It prints the accepted set (difficulty, seat, rung, name/intent), a breakdown of
rejections, and the difficulty the next unvetted RSVP must reach. The verifier is
the same module the page and the test use, so a page that accepts something the
collector rejects (or vice versa) is a bug, not a policy difference.

## verifier discipline

`verifyRsvp()` recomputes everything it needs and trusts nothing that arrived:

* **id** — recomputed from its own NIP-01 serialization (JSON of
  `[0, pubkey, created_at, kind, tags, content]`) hashed locally; a submitted id
  that does not match is rejected (`id-mismatch`);
* **signature** — schnorr-verified against the recomputed id (`bad-signature`);
* **work** — leading zero bits counted from the recomputed id; a `["nonce",_,bits]`
  declaration **above** the achieved value is rejected
  (`declared-bits-exceeds-actual`), so claiming work you did not do is a fail;
* **floor** — the vanity prefix is recomputed from the pubkey, so the counted
  difficulty is the pubkey's real prefix length, not a claim;
* plus structural checks (kind, tag shape, `["nhr", …]` coordinate, content size).

## running / testing it

```sh
python3 -m http.server 8099          # then open http://localhost:8099/signup.html
node --test test/pow-ratchet.test.mjs        # fast: 12 tests, ~6 s
POW_SLOW=1 node --test test/pow-ratchet.test.mjs   # + a real 2^15 keygen grind (~2 min)
```

`signup.html?selftest=1` switches the *client* to test-scale parameters (1 leet
char / base 5 / cap 8), autopilots one RSVP and skips relay publishing — a QA
hook for headless runs. It cannot weaken verification: `resolve()` and
`verifyRsvp()` are unchanged, so a test-scale event is rejected by any real
ladder regardless of what the page believes.

`window.__nhd` exposes the live page state (`phase`, `npub`, `bits`,
`nextRequiredBits`, `accepted`, `published`, `signed`) for the same reason.

## the REQ must use INDEXED tags

strfry relays (nostr.mom, offchain.pub, relay.primal.net) refuse a REQ on a
multi-letter tag: `bad req: error parsing #nhr: unindexed tag filter`. The page
used to ask for `#nhr`, so every REQ was refused and the counter read 0 no matter
what was on the relays — looks exactly like an empty relay. It now asks for
`#t = nostrhackday` (indexed) and `verifyRsvp` still requires the `nhr` tag.
13 real RSVPs were invisible this way until 2026-09-17.

## one title line, and it is the served heading

The panel prints its title **once**: the `<span id="mine-title-text">` in `index.html`.
The grind head carries only the dot and the state badge (`idle` → … → `found`) —
it used to repeat the same words three lines under the heading (operator,
2026-09-17). `setPanelTitle(running)` in `js/signup.js` is the single writer, and
`js/viz.js` no longer has a `setTitle()` at all.

## the ladder has seats (45) and the counter only counts relays

`DEFAULT_PARAMS.seats = 45` is the room; `cap = 22` bits is the highest rung. The
rung still climbs +1 bit per 2 accepted unvetted RSVPs and then **clamps** at the
cap — seats 12…44 all cost 2^22, so a 45-seat room does not make seat 43 cost
2^38 (which no browser could mine). The ladder closes when the seats run out
(`LADDER_FULL` on the 46th), not when the rung hits the cap.

The page no longer prints a **seats open** figure (operator, 2026-09-17: it could
discourage people from applying). It keeps **accepted**, **events seen** and
**next RSVP needs**, and a note beside the grind spans the gap — "Didn't make the
cut? You're still welcome — come to c-base anyway." The mining panel's `target`
stat reads the live rung (`state.targetBits`), so it never shows the 16-bit floor
while the ladder is already higher, and `retarget()` raises running workers even
before a key has been mined.

**The counter counts the store, so only events a relay actually holds may enter
it.** Both publish paths (`onProof`, `onSigned`) publish FIRST and call
`store.add(event)` only when at least one relay accepted (a dry run's synthetic
`ok: true` entry keeps the offline/selftest flow working). The old order — add,
then publish — is why "accepted 1" became 0 on reload (2026-09-17): the event had
never reached a relay.

**The write set is verified, not assumed** (probe 2026-09-17, `kind 1337`):
`nostr.mom`, `offchain.pub`, `relay.primal.net` accept *and serve* it;
`purplepag.es` answers `blocked: kind 1337 is not allowed` and
`relay.orangesync.tech` wants NIP-42 auth (`auth-required: not authenticated`).
Only the three verified relays are in `publishRelays`.

## releasing: stamp the assets

```
scripts/stamp-assets.sh            # rewrite ?v=<short sha> on every local js/css url
scripts/stamp-assets.sh --check    # exit 1 when the tree is stale — run in release
./deploy-nsite.sh && ssh debian@23.182.128.51 'docker restart tollgate-nsite-gateway'
```

The gateway serves `cache-control: public, max-age=3600` (GitHub Pages:
`max-age=600`) and browsers key ES modules by URL, so an unversioned deploy can be
served as NEW html + HOUR-OLD js. That is exactly how the pulled fingerprint grid
came back for one visitor on 2026-09-17 — the fix is the token on every local
`<script>`, `<link>` and module specifier (including `new Worker(...)`).

## the panel has no fingerprint grid (pulled 2026-09-17)

The 2D character grid and the rolling log of raw attempts are **gone** — operator
call: "too complicated and it needs to be explained properly in a demo". They
live in the `asymmetric-vanity-npubs` demo, not on the RSVP page.

What is left is the part that can be explained in one breath: the "mining toward
…" strip (green = matched, from `DEFAULT_PARAMS.vanityTarget`, never from
markup), the progress bar directly under it, the live stats, and — once the key
exists — the mined npub with its green/orange zones, the raindrop ring/badge and
the nsec handover. `viz.push(sample, best)` now only advances the strip, on the
monotonic best candidate `mineVanityKey()` reports.

Verified on the shipped ladder (nothing published — `?relays=` empties the relay
list) by `~/worktrees/nostrhackday-e2e/run-e.mjs`: strip 0 → 2 → 3 onto `n05…`,
bar to 100%, zero grid nodes in the DOM in every state, headline = mined npub,
nsec shown without a click.

## known relay notes (probed 2026-09-16)

| relay | read | write | note |
| --- | --- | --- | --- |
| `wss://nostr.mom` | ok | ok | accepts `#nhr` tag filters |
| `wss://relay.damus.io` | ok | ok | |
| `wss://purplepag.es` | ok | ok | profile/kind-focused, fine for kind 1337 |
| `wss://relay.primal.net` | ok | untested | |
| `wss://relay.orangesync.tech` | **auth-required** (NIP-42) | untested | needs NIP-42 auth before `REQ` — **out of the page's relay list** (the one list is both read and write) |

`applesauce-relay`'s `RelayPool.subscription()` does not forward per-relay `EOSE`
markers, so both the page and the collector settle on silence/event-count instead
of waiting for `EOSE`.
