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

Acceptance is a **set rule**, not an arrival chain:

1. drop anything that fails verification (below);
2. keep one event per pubkey (highest difficulty wins, ties by newest);
3. sort by difficulty desc, then `created_at` asc, then `id` asc;
4. accept the longest prefix where `bits[k] >= rung(k)`.

Because the sort is total and the gate only looks at the sorted prefix, the same
set of events always produces the same result — shuffle the input, dedupe it,
replay it in a different order, and you get an identical answer. That is what
makes the count idempotent and grief-proof: a spammer with a high-difficulty event
takes **one** seat (the highest), and backdating `created_at` buys nothing but a
tiebreak.

Note the consequence of step 4: rungs ascend while difficulties descend, so the
weakest accepted RSVP is the one that has to clear the highest rung of the
accepted prefix. Hosting a new, stronger RSVP can therefore displace a weak one —
this is intended (strength, not timing, decides), and it is order-independent.

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
| `wss://relay.orangesync.tech` | **auth-required** (NIP-42) | untested | needs NIP-42 auth before `REQ`; excluded from the default browser flow |

`applesauce-relay`'s `RelayPool.subscription()` does not forward per-relay `EOSE`
markers, so both the page and the collector settle on silence/event-count instead
of waiting for `EOSE`.
