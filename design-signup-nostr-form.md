# Nostr-Native Signup Form — Design

**Project:** nostrhackday landing page (`/home/c03rad0r/repos/nostrhackday-site`)
**Goal:** Replace the footer "SIGN UP" button (currently → `https://c-base.org/`) with a
proper signup form that is itself a custom **Nostr client** submitting a **custom event kind**.
**Audience:** "Let's Build on Nostr" hackday at c-base, Berlin, Wed 2026-09-30. Attendees are
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
    ["nhr", "2026-09-30-berlin"],
    ["status", "accepted"]
  ],
  "content": "{ \"name\":\"Ada\", \"alias\":\"@ada_hacks\", \"npub\":\"npub1...\", \"contact\":{\"telegram\":\"@ada\", \"matrix\":\"@ada:matrix.org\", \"email\":\"ada@example.com\"}, \"diet\":\"vegetarian\", \"idea\":\"building a cashu app\", \"intent\":\"attending\" }",
  "sig": "<schnorr-sig>"
}
```

**Tag contract (keep minimal, always present):**
- `["t","nostrhackday"]` — NIP-32 hashtag, makes signups queryable by any client/indexer.
- `["nhr","2026-09-30-berlin"]` — stable per-event marker tag; this is what the org's collection
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
  `kinds:[1337] #nhr:["2026-09-30-berlin"]` against the org relay + public relays, dedupes by
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
2. **Proof of work (mandatory for all):** mine NIP-13 against the serialized kind-1337 event
   (≈399 bytes) until the id's leading zero count ≥ required bits. See §5a for the ratchet.
3. **Client-side submit gate:** disable button while mining+publishing, one submission per key.
4. **Org's collection step dedupes by pubkey and manually vets** the short list — a human eye on
   the small set is the real anti-spam.
5. *(Still skipped)* No zap-required, no CAPTCHA, no whitelist.

### 5a. PoW ratchet — signer-agnostic, order-independent SET rule (operator-steered)

**PoW is signer-agnostic.** Mining rewrites only the `nonce` tag; the event `id` commits to it.
So the page mines **once**, then whichever key signs (ephemeral in-browser or NIP-07) signs the
**same** mined id + tags — signing is a separate step that does not re-mine. One code path for
both identity modes. The id commits to the nonce, and the sig commits to the id, so verifying =
recompute sha256 over (id-input) and check leading zeros, independent of which key signed.

**Do NOT ratchet only random-nsec (ephemeral) submissions.** A NIP-07 signature is
indistinguishable, on the wire, from a scripted freshly-generated key, so any gate that treats
"random key" as spam-able and "NIP-07" as trusted is immediately walk-around-able. Ratchet on a
**verifiable property**: `vetted` (org allowlist / known contact) vs `everyone else`. Allowlisted
RSVPs are accepted at the **floor**; everyone else competes in the **ladder**.

**Ladder (order-independent SET rule, kills backdating/reorder grief):**
- Sort all submissions' difficulty `bits` DESC.
- Accept the **longest prefix** where the k-th submission (0-indexed) satisfies `bits[k] ≥ BASE+k`.
- `BASE` = floor (mandatory for all), `CAP` = highest tier; `+1` bit per rung (each rung = 2× the
  previous rung's mining cost).
- **Hard limit:** the ladder admits at most `CAP − BASE + 1` unvetted RSVPs. One 30-bit event can
  only ever occupy slot 0 (it cannot manufacture slots 1..N at lower bit-counts than their rung
  demands), so a single high-PoW spammer captures one anonymous seat and nothing more.
- Vetted RSVPs do **not** consume ladder capacity (they only need the `BASE` floor).

**Locked parameters (measured 2026-09-15, i7-7600U, 399-byte event):**

| Param | Value | Basis |
|-------|-------|-------|
| BASE | 16 | desktop WASM 1.5s, pure-JS desktop 1.5s, mobile WASM 3.6s, mobile pure-JS 6s — comfortable floor |
| CAP | 22 | 7 unvetted seats; worst rung 22 = 14s desktop-WASM (90s pure-JS) only at the 7th seat |
| step | +1 bit / 2 accepted | operator steer |
| miner | WASM (hash-wasm) in Web Workers ≤`navigator.hardwareConcurrency` (cap 4), @noble pure-JS single-thread fallback | measured 290k h/s (4w) / 196k (wasm-single) / 44k (pure-JS chrome) |
| SET rule | sort bits DESC, accept longest prefix `bits[k] ≥ BASE+k` | kills reorder/backdate + grief |

Measured mining seconds (pure-JS chrome fallback, worst universal path): 16→1.5s, 18→5.9s,
20→23.6s, 22→94.5s. With WASM workers: 16→0.2s, 20→3.6s, 22→14.4s. Mobile ≈ 4× slower: 16→0.9s,
20→14.4s (WASM multi-worker estimate 72.6k h/s).

The gate is a **friction + bounded-capacity** defense, not crypto-economics: it stops instant
flooding and caps anonymous seats at 7, then the org's manual vetting of that small set is the
final word (a bot can mine all 7 seats in ~29s but gains nothing more than 7 rows a human reads).

**Shared module `pow-ratchet.js`** (used verbatim by: signup page, org collection script, Playwright
test): `powMine(event, bits)` (returns id+nonce), `powVerify(id, event, bits)`, and
`acceptSet(submissions, {BASE, CAP})` implementing the SET rule. Single source of truth so the page
mining, the collection script, and the test all agree on the ratchet.

---

## 6. Recommended build plan (lean, 4 phases)

**Phase 0 — Verify (½ day).**
- Probe-write a throwaway kind-1337 event via `nak event` to: nostr.mom, offchain.pub,
  purplepag.es, relay.primal.net, nos.lol; record accept/retention per relay.
- PR-kind to NIP registry (`kinds.md`) for `1337`.

**Phase 1 — `signup.html` (½–1 day).**
- Vanilla HTML+CSS (matching `style.css`)+JS; vendored `@noble/secp256k1` + `hash-wasm`.
- Mine NIP-13 PoW once (shared `pow-ratchet.js`: WASM Web Workers ≤4, pure-JS fallback) at the
  required bit level → then sign the mined event with ephemeral key OR NIP-07 (`window.nostr`) →
  publish via WebSocket pool (4 public + org relay) → success/error UI; honeypot + min-time;
  privacy note.
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
