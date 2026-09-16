# Nostr-Native Signup Form — Design

**Project:** nostrhackday landing page (`/home/c03rad0r/repos/nostrhackday-site`)
**Goal:** Replace the footer "SIGN UP" button (currently → `https://c-base.org/`) with a
proper signup form that is itself a custom **Nostr client** submitting a **custom event kind**.
**Audience:** "Let's Build on Nostr" hackday at c-base, Berlin, Tue 2026-09-29 (date moved from Wed 2026-09-30 at the operator's request, 2026-09-16). Attendees are
developers — many will have a Nostr key, many will not (some will get their first key *at* the event).

Deployment targets (both must work): **GitHub Pages** + **nsyte/nsite** single static dir.

---

## 1. Custom event kind — recommendation: **kind 1337** (regular)

**Rationale.**
- Use a **regular kind** (1000–9999), not replaceable/addressable: each RSVP is its own
  distinct event, so signups can be listed, counted, and deduped by pubkey independently.
  An addressable kind (30000-range) would silently overwrite the previous RSVP per pubkey.
- 1337 is in the 1000–9999 range, is well clear of allocated public kinds (zaps 9735, cashu
  1311, report 1984, long-form 30023, app-data 30078), and is memorable for a hackday.
- **Do NOT use standard kind 31925 (NIP-52 calendar-event RSVP).** It exists, but it is rigid
  (status-only vocabulary) and is specced to reference an org-published 31922/31923 date-based
  calendar event. A bespoke client + bespoke kind is *on-theme for a hackday whose point is
  building custom Nostr kinds/clients* and can carry arbitrary contact/notes. *(Optional polish,
  not required: also publish a NIP-52 31922 calendar event for ecosystem discoverability.)*
- **⚠ VERIFY:** `1337` is occasionally used as an ad-hoc dev/test kind. De-risk by opening a PR
  to register `1337` in the NIP registry (`kinds.md`) under "nostrhackday RSVP / event signup".
  The number alone does not guarantee collision-freedom; registration does.

### Example event

```json
{
  "id": "<sha256-hex>",
  "pubkey": "<ephemeral-pubkey-hex>",
  "created_at": 1780243200,
  "kind": 1337,
  "tags": [
    ["t", "nostrhackday"],
    ["nhr", "2026-09-29-berlin"],
    ["status", "accepted"]
  ],
  "content": "{ \"name\":\"Ada\", \"alias\":\"@ada_hacks\", \"npub\":\"npub1...\", \"contact\":{\"telegram\":\"@ada\", \"matrix\":\"@ada:matrix.org\", \"email\":\"ada@example.com\"}, \"diet\":\"vegetarian\", \"idea\":\"building a cashu app\", \"intent\":\"attending\" }",
  "sig": "<schnorr-sig>"
}
```

**Tag contract (keep minimal, always present):**
- `["t","nostrhackday"]` — NIP-32 hashtag, makes signups queryable by any client/indexer.
- `["nhr","2026-09-29-berlin"]` — stable per-event marker tag; this is what the org's collection
  query filters on (`#nhr`), so future/other hackdays don't collide.
- `["status","accepted"|"tentative"|"interested"]` — mirrors NIP-52 RSVP vocabulary.

**`content` = JSON string.** All fields optional. Never require `npub`. `email`/`telegram`/`matrix`
explicitly optional. `intent` ("attending"/"maybe"/"interested") lives in content for human display
and in the `status` tag for querying.

---

## 2. Identity model — recommendation: **ephemeral in-browser key (primary), NIP-07 (upgrade), no server fallback**

**Primary: generate a throwaway key in the browser for EVERY submission.**
- Works for **every** visitor, keyed or not — this is the whole point of the feature.
- Sign the 1337 event locally (`@noble/secp256k1`, vendored single-file), publish, then **discard**
  the key. Never transmit the nsec anywhere; it never leaves the tab.
- Optional (nice-to-have): offer to keep the key in `localStorage` (or export the nsec) so the
  attendee can later find/cancel their RSVP. Default = discard.
- "Let's Build on Nostr" audience is mixed; not requiring an extension is what makes a real
  signup form for non-keyholders. And it gently *teaches* the ephemeral-key concept, on-theme.

**Upgrade path: if `window.nostr` (NIP-07 / Amber) is present, offer it first** so keyholders can
sign with their real identity in one click; ephemeral key is the automatic default otherwise.

**No server-side fallback.** Anyone with JS can use the ephemeral key, so a plain-HTTP fallback
would only serve JS-disabled visitors — an edge case not worth backend infra on a static site.

**Why not napplet for identity:** a napplet's host shell owns all keys and forbids the app from
generating/holding raw keys or opening its own WebSockets — the *opposite* of this design. (See §3.)

---

## 3. Client architecture — recommendation: **separate `signup.html`, no build step, vanilla JS**

**Recommend `signup.html`** (one new static file), linked from the SIGN UP button.

- The repo is a tiny single-page site; a dedicated page keeps `index.html` lean and isolates the
  ~few-hundred lines of signing/publish JS. Both GitHub Pages and nsyte serve multi-file static
  dirs ("multiple pages and routes" is supported), so the deploy story is unchanged.
- **No framework, no bundler.** Vendored `@noble/secp256k1` (one minified file) + a small custom
  WebSocket relay pool client. Matches the repo's zero-build approach and survives nsyte upload.
- Inline-modal-in-`index.html` is a valid alternative but couples the landing content to the app;
  reject for maintainability. Not a hard veto — just not the cleaner default.

### **Napplet: OVERKILL AND ACTUALLY WRONG — reject.**
- A NIP-5D napplet requires a host shell runtime (Paja/Kehto) and a sandboxed iframe; the visitor
  can't just open a URL — they need a napplet-capable host. Worse UX for the exact audience we want.
- The sandbox **forbids direct `WebSocket` and `localStorage`** and the shell owns keys/signing —
  directly incompatible with "generate an ephemeral key in page, write to relays from the page."
- It adds a full toolchain + conformance pipeline for a single signup form. Zero upside here.

---

## 4. Relay / write path — recommendation: **publish from browser to 4 public relays; org aggregates via a collection relay/script**

Client opens WebSocket(s) from the page and publishes kind 1337 to a small set of relays that
accept arbitrary-kind, anonymous-key writes:

| Relay | Suitability | Note |
|-------|-------------|------|
| `wss://nostr.mom` | ✅ use | Accepts all kinds, no PoW. Primary. |
| `wss://offchain.pub` | ✅ use | Reliable, no PoW requirement. |
| `wss://purplepag.es` | ✅ use | Accepts varied kinds. |
| `wss://relay.primal.net` | ✅ use (verify) | Generally accepts notes; confirm it stores custom regular kinds. |
| `wss://relay.damus.io` | ⚠ skip for this | Rate-limits rapid writes ("noting too much"); fine at 1-signup/visitor but low value here. |
| `wss://nos.lol` | ⚠ verify | Requires PoW on some kinds (28-bit on nsite manifest); check whether a custom regular kind needs PoW from a fresh key. |
| `wss://relay.ngit.dev` | ❌ DO NOT use | **Rejects non-git kinds** ("restricted: event must reference an accepted repository"). It's in the `.nsite` manifest config only — keep it there for site manifests, never for signups. |

**⚠ VERIFY all of the above live before build:** send a probe kind-1337 event from a throwaway key
via `nak event` to each relay and confirm acceptance + retention (see §Build Plan Phase 0). The
`.nsite` relay list is *not* a safe write set for arbitrary kinds.

**Organiser collection (the durable half).** The org can't trust any single public relay to retain
30 signups. So: (a) client publishes to the 4 public relays above, **and** (b) the org maintains a
**collection relay + aggregation script**:
- Point the writer pool at the org's self-hosted relay too — `wss://relay.orangesync.tech` is
  already in `.nsite/config.json`, so the org already operates nostr infra. Publishing to it gives
  a canonical, org-controlled copy.
- A short fetch script (run on demand / nightly before the event, using `nak req`) queries
  `kinds:[1337] #nhr:["2026-09-29-berlin"]` against the org relay + public relays, dedupes by
  pubkey, and dumps a plain list (name / alias / intent / contact). Optionally mirror to a sheet.
This is pure-client for the visitor (no backend they depend on) with reliable org accounting.

---

## 5. Privacy + anti-spam

**Privacy.** Publishing to public relays is inherently public; that is a feature for a public
hackday. Mitigation:
- Ephemeral key means the RSVP is **not linkable to the attendee's real identity unless they add
  contact info themselves** — and all contact fields are optional.
- Put a plain-language disclosure on the form: *"Your RSVP is published publicly to Nostr relays
  under an anonymous key. Any contact info you add becomes public."*
- **Fallback for privacy-concerned visitors:** if they don't want a public RSVP, `email` the org
  directly (surface the org contact). **Do not build NIP-17/NIP-44 encrypted DM into v0** — for a
  30-person free hackday this is over-engineering; note it as a future option if a private RSVP
  lane is ever requested.

**Anti-spam.** Ephemeral keys + public relays = trivial to spam, so the form requires a **proof of
work** (NIP-13 `["nonce",<counter>,<bits>]` tag) from **every** submission — keyed (NIP-07) and
ephemeral alike (operator steer 2026-09-15: "make everyone submit proof of work"). Layers:

1. **Honeypot field** (hidden input bots fill) + **min wall-clock time** before submit (e.g. ≥3s).
2. **Proof of work (mandatory for all, visible):** grind a keypair whose npub starts with the
   leet prefix (e.g. 3 chars), then sign the kind-1337 event with it, and carry any per-rung
   exact top-up as a NIP-13 `nonce` tag. See §5a for the ratchet + measured cost table.
3. **Client-side submit gate:** disable button while mining+publishing, one submission per key.
4. **Org's collection step dedupes by pubkey and manually vets** the short list — a human eye on
   the small set is the real anti-spam.
5. *(Still skipped)* No zap-required, no CAPTCHA, no whitelist.

### 5a. PoW — visible vanity-npub prefix + exact-rung nonce (operator-steered 2026-09-15)

**Operator steer: "give everyone a vanity npub with the leet equivalent of `nostrhackday` at the
beginning, make them publish an event saying they're coming, first one grinds until done, each
consecutive one needs ≥2× the PoW of the ones already counted. Visualize the npubs like the
demo."**

The proof of work is **visible** — it is the npub's prefix. Anyone can read it; no verifier.
This is exactly what `asymmetric-vanity-npubs/demo` renders (vanity zone green, anti-phish zone
orange). We reuse that renderer.

**Hard constraint (measured, cannot fake):** grinding a prefix of `L` leet chars costs `32^L`
keypair generations. Real browser keygen ≈ **542 keys/sec single-thread** (measured, @noble/curves,
pure-JS EC point-multiply — WASM does NOT speed this up, unlike sha256). ~4 workers ≈ 1,800/s.

| prefix L (leet chars) | = bits | tries | wall @1800/s (4w) | wall @542/s (1w) |
|---|---|---|---|---|
| 2 | 10 | 1,024 | 0.6 s | 1.9 s |
| 3 | 15 | 32,768 | 18 s | 60 s |
| 4 | 20 | 1,048,576 | 9.7 min | 32 min |
| 5 | 25 | 3.36e7 | 5.2 h | 17 h |
| 13 (full `nostrhackday` leet) | 65 | 3.7e19 | **≈6.5e8 years** | — |

**Full leet of `nostrhackday` is impossible** — 2^65 tries ≈ 10¹⁹ at 1,800/s ≈ 6.5×10⁸ years.
The honest design uses a **short leet prefix that is the visible proof of "I ground for this"**
(and matches the friendly floor of the earlier NIP-13 BASE=16≈3 chars), with the exact ≥2×
per-rung demand carried by a **NIP-13 nonce on the event** (chars are quantized at 5 bits; they
cannot express a smooth 2× ladder).

**Identity model (per §2, unchanged + npub):** the page mines a keypair until its npub starts with
the required leet prefix, then signs the kind-1337 RSVP with that **ephemeral key** (discarded, or
offered for localStorage export). NIP-07 users may sign with their real key instead — but then
their real npub isn't leet-minted, so a NIP-07 signer with a full-leet real npub is *rare*; to keep
the ratchet honest and signer-agnostic we do **not** trust "NIP-07 = legit". Instead: **every
RSVP must be signed by a key whose npub meets the ladder prefix**, so NIP-07 users are welcome but
still must provide a minted key (we can even offer to derive one and let NIP-07 sign its event —
signing-key ≠ event-key is fine in Nostr as long as the published event's pubkey is the minted one).

**Ladder (order-independent SET rule — same as prior §5a, now over prefix length + nonce bits):**
- Sort submissions by total difficulty DESC.
- Accept the longest prefix where the k-th submission (0-indexed) satisfies
  `difficulty_k ≥ BASE + k` difficulty-steps, each step = 2× (one NIP-13 bit).
- A vanity prefix of L chars contributes `5L` base bits, **topped up with a NIP-13 `nonce` tag**
  to hit the exact rung. So difficulty = `5L + nonce_bits`, expressible to the bit.
- `BASE` = floor mandatory for all; `CAP` = highest rung; ladder admits ≤ `CAP−BASE+1` unvetted
  RSVPs. A single high-difficulty spammer occupies slot 0 only (cannot backdate slots 1..N).
- **Vetted** (org allowlist / known contact) accepted at `BASE` floor, don't consume ladder seats.

**Locked parameters** (grounded in the 2^5-per-char keygen cost — see table):

| Param | Value | Basis |
|-------|-------|-------|
| BASE | 3 leet chars = 2^15 (32K tries) + 0 nonce | 18 s @4w / 60 s @1w — friendly floor, visible `npub1n<3chars>...` |
| CAP | 5 leet chars + 4 nonce = 2^29 | ~4.3 h @1800/s single high-attacker; vetted unaffected |
| step | +1 difficulty-bit (2×) per accepted unvetted RSVP; prefix top-ups in +1-char jumps, nonce fills exact rung | operator steer "≥2×" |
| SET rule | sort total difficulty DESC, accept longest prefix `diff_k ≥ BASE+k` | kills reorder/backdate + grief |
| miner | browser keygen (542/s @1w, ~1800/s @4w WASM-independent) | measured on this box |
| visible | `npub1` + leet prefix rendered with asymmetric-vanity-npubs viz (green vanity / orange anti-phish) | reuse demo renderer |

> With BASE=3 the npub prefix is `npub1` + **3 leet chars** (e.g. `npub1n0s...` for "no"—we pick
> common leet of `nostrhackday`: n0,5t,h4,ck,d4y...). That is genuinely 2^15 ≈ 32K keygen tries,
> visible in the npub, and takes ~1 min on a laptop. The **full word is 10⁹ years** — surfaced
> here so we never claim otherwise.

**Shared module `pow-ratchet.js`** — now two functions, same single-source-of-truth contract:
`vanityMine(targetChars, nonceBits)` → returns the keypair whose npub prefix matches AND whose
event id passes the nonce; `verifyRsvp(event, {BASE, CAP})` recomputes prefix length + nonce bits
and runs `acceptSet()`. Used by signup page, collection script, and Playwright test.

---

## 6. Recommended build plan (lean, 4 phases)

**Phase 0 — Verify (½ day).**
- Probe-write a throwaway kind-1337 event via `nak event` to: nostr.mom, offchain.pub,
  purplepag.es, relay.primal.net, nos.lol; record accept/retention per relay.
- PR-kind to NIP registry (`kinds.md`) for `1337`.

**Phase 1 — `signup.html` (½–1 day).**
- Vanilla HTML+CSS (matching `style.css`)+JS; vendored `@noble/secp256k1` + `@noble/curves`.
- Grind a keypair to the required vanity-npub prefix (shared `pow-ratchet.js`: browser
  keygen Web Workers ≤4 — WASM does NOT help EC point-multiply, measured 542/s @1w) + any
  exact-rung NIP-13 nonce → sign the kind-1337 event with the minted ephemeral key → publish
  via WebSocket pool (4 public + org relay) → success/error UI showing the minted npub;
  honeypot + min-time; privacy note.
- `pow-ratchet.js` also ships the SET-rule `acceptSet()` so the collection script + Playwright
  test consume the same ratchet as the page.

**Phase 2 — Wire up (1 hr).**
- Point SIGN UP button at `signup.html`; update `.nsyte-ignore` if needed; keep `index.html` static.

**Phase 3 — Collection + E2E + deploy (½–1 day).**
- Org aggregation script (org relay + public query, dedupe-by-pubkey → list).
- **Playwright test the form** (load, fill, sign, publish, then assert the event is on a relay) and
  **test the deployed nsite URL**, including mobile viewport (per repo QA convention).
- Deploy **both** GitHub Pages and nsyte; for the nsyte deploy use a **stable nsec** (fresh-npub-
  per-deploy would rotate the URL and break the shared signup link once it's public).

**Total ≈ 2–3 dev-days.** Matches a small single-page site.
