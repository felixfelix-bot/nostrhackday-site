# Nostrhackday

**Let's Build on Nostr** — Tue **29.09.2026**, 10:00–18:30, c-base, Rungestraße 20, 10179 Berlin.
Two days before bitcoin++ Berlin (payments edition, 01.10.–03.10.2026) — https://btcpp.dev/berlin26
The day before the Cashu Ecash Hackday (30.09.2026) — https://x.com/CashuBTC/status/2099845950768324657

## Live

- https://nostrhackday.orangesync.tech/
- https://felixfelix-bot.github.io/nostrhackday-site/
- https://npub15xyvqavhg8sw9f2uqnnxx5e7myl9d54lw697tp6aemf0n5p8sx0qmusn8g.nsite.lol/

## RSVP = in-browser proof of work

One page, no server, no accounts, no email. The page mines a nostr keypair whose
npub carries a **leet prefix** (3 chars, `n05…`) plus a **low-entropy "raindrop"
window** (9 chars, ≤6 distinct) — both readable off the screen — then signs a
kind-1337 event and publishes it to public relays. Accepted RSVPs raise the
difficulty ladder.

The miner, the verifier, the org collection script and the tests all share one
module: `js/pow-ratchet.js`.

### Flow v2 — the RSVP button, and the unattended proof event

The CTA is labelled **RSVP**, and it is a real gate: the grind starts when it is
*pressed*, never on page load. A page load is not an RSVP — and a proof event
takes a seat on the ladder, where each seat is ≈2× the previous person's work —
so nothing mines, and therefore nothing can be published, until someone puts
their hand up. The predicate is `canStartMining({ started, intent })` in
`js/pow-ratchet.js` (pure, unit-tested); the wiring latches `started` on the
first press, flips the CTA to `mining…` and spends it, so a second press cannot
spawn a second worker set.

1. **Press RSVP to start the grind.** Until then the panel is idle (`press RSVP
   to start mining your npub`) and nothing is mined. After the press the workers
   grind the leet prefix and the raindrop window on every core, and keep topping
   the nonce up to the current rung (`requiredBits()` — each seat is ≈2× the
   previous person's work).
2. **The moment the key clears the current rung, the page publishes a `kind 1337`
   PROOF event by itself.** No click, no form, no consent checkbox — because it
   carries nothing personal. The content is one human-readable line followed by
   the machine proof text —
   `RSVPed to nostrhackday — mined this key live in my browser: 16 bits of work (nonce + leet npub prefix).`
   then `{"v":3,"proof":1,"event":…,"bits":…,"nonce":…,"npub":…}` (where `npub`
   is the mined *prefix*, and the nonce digits are the only varying bytes). The
   tags
   are exactly the programmatic ones a valid RSVP
   gets (`t`, the event marker, `status`, `client`, `nonce`) — no name, alias,
   intent, contact or user agent, ever.
   Publishing is **once per page load** and **monotone**: it fires only when
   `vanityBits + nonceBits >= requiredBits(seats)` and never below the rung
   (see `shouldAutoPublishProof()`), and the status line then shows the event id
   as a njump link.
3. **Only after that does the details form appear** — name/alias/intent/skill/
   idea/diet/contact plus the consent checkbox, which applies to *this* event,
   the one with personal fields. There is no need to fill it in: the proof event
   already holds the seat.
4. **The details event reuses the mined key at the same rung**, so `resolve()`
   (which dedupes seats by pubkey through `betterOf()`) counts it as the *same*
   seat — it never consumes a second one. `test/pow-ratchet.test.mjs` asserts
   that with a real follow-up event, in both arrival orders.
5. **The nsec handover is revealed with the form**, before any submission, so a
   visitor who never fills the form still leaves with their key. Importing the
   nsec into any nostr signer keeps the identical identity.

The live counter shows **accepted**, **events seen** and **next RSVP needs**. The
seat count is deliberately *not* shown (operator, 2026-09-17: it could discourage
people from applying), and a note beside the grind makes clear that not clearing
the cut still leaves the door at c-base open.

Acceptance is **sticky**: once a seat is taken it is never re-evaluated, so the
accepted count cannot go down when the rung climbs under it.

## Publishing as an nsite

```bash
export PATH="$HOME/.deno/bin:$HOME/.local/bin:$PATH"
./deploy-nsite.sh
```

`nsyte deploy` reads `.nsite/config.json` and signs with the key at
`~/.hermes/state/nostrhackday-nsec.key` (not in this repo).

After any republish, restart the serving gateway — it caches manifests and will
otherwise keep serving the previous copy:

```bash
ssh debian@23.182.128.51 'docker restart tollgate-nsite-gateway'
```

## Custom domain (`nostrhackday.orangesync.tech`)

Served on `testserver2` (23.182.128.51) by Caddy in front of the nsite gateway, with the
`Host` header rewritten to the site's npub hostname so the short name stays in the address
bar. **Three pieces must all hold on the VPS:**

1. **Caddy** site block with `tls { on_demand }` and
   `reverse_proxy localhost:3002 { header_up Host <npub>.nsite.orangesync.tech }`.
2. The **on-demand ask endpoint** on `127.0.0.1:6799` must answer **200** for this FQDN — its
   allowlist is `TLS_ASK_ALLOWED_SUFFIXES` in `/home/debian/preview-infra/preview_gateway.py`.
   A **403** there means Caddy never issues a certificate and every HTTPS request dies with
   `SSL_ERROR_INTERNAL_ERROR_ALERT` (`curl: (35)`), while the same site keeps serving fine at
   its npub URL. That is exactly how the domain broke on **2026-09-24**.
3. **Only one process may own port 6799.** The legacy `nsite-ask.service` (a 557-byte script
   that allows only `*.nsite.orangesync.tech`) was re-enabled on 2026-09-21, took the port, and
   pushed `preview-gateway` into an `Address already in use` crash loop — all custom domains
   lost TLS while `*.nsite.orangesync.tech` kept working. Its unit file is now parked at
   `/etc/systemd/system/nsite-ask.service.disabled`. **Do not re-enable it.**

Verify from anywhere:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://nostrhackday.orangesync.tech/     # 200
ssh debian@23.182.128.51 "curl -s -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:6799/ask?domain=nostrhackday.orangesync.tech'"                    # must be 200
```

## GitHub Pages

Push to `main`; the workflow in `.github/workflows/` builds and deploys.
