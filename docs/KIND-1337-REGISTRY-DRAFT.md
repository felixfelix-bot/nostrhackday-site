# Kind 1337 registry submission — VERDICT: BLOCKED, 1337 is already registered

**Status:** DRAFT for operator review. **Nothing has been posted upstream.** No PR, no
upstream fork branch. Posting is the operator's trigger.

**Card:** kanban `t_7930a533` — "Register kind 1337 in the NIP kinds registry (draft first)"
**Verified:** 2026-09-20, against live sources (SHAs pinned in §1).

---

## 0. Verdict in one line

Kind **1337 is already registered as `Code Snippet` (NIP-C0) in both live registries**, so
the approved submission ("register 1337 in the NIP kinds registry") has **no legal form**.
The VERIFY item in `design-signup-nostr-form.md` §1 closes as **CONFLICT**, not
"unregistered".

The premise in the card and the design doc ("1337 is well clear of allocated public kinds",
"⚠ VERIFY … De-risk by opening a PR to register 1337") is **wrong** — C0 was missed. The
design doc's parenthetical covered zaps (9735), cashu (1311), report (1984), long-form
(30023) and app-data (30078) — but 1337 is C0's code-snippet kind and has been since
2025-03-29, ~18 months before this hackday.

---

## 1. Live registry truth (re-verified at run time — the card's "it moves" was right)

The README table is **not** the registry, and the README says so itself:

- `nostr-protocol/nips` `README.md` **L121–L123**:
  > `## Event Kinds`
  > This table is not exhaustive. For a machine-readable registry of all known event kinds
  > prefer <https://github.com/nostr-protocol/registry-of-kinds> (or alternative registries
  > following the same YAML schema).

- The real registry is **`nostr-protocol/registry-of-kinds`**: one file, **`schema.yaml`**, a
  `kinds:` map (266 entries), schema-validated by `.github/workflows/deploy.yml`. Its README:
  > "Any reasonable event definition can be added here. Implementation and how-to-use guides
  > must exist elsewhere."

The three live anchors for kind 1337:

| registry / doc | kind 1337 entry | location | provenance |
|---|---|---|---|
| registry-of-kinds | `description: Code Snippet` + **`in_use: true`** | `schema.yaml` **L1044** | NIP-C0 lineage |
| nips README table | `1337` → Code Snippet → `[C0](C0.md)` | **L175** (table spans L125–L301) | C0 |
| NIP-C0 spec | "This NIP defines `kind:1337` as a code snippet event." | `C0.md` **L15** | `draft` `optional`; file created 2025-03-29 (`f90101406` "rename 95 to C0."), last touched 2025-12-30 (`2f71cf74a`) |

Pinned for re-verification on any future run:

- `registry-of-kinds` @ **`92df81b9`** — "add slash commands kind." (2026-09-17)
- `nostr-protocol/nips` @ **`11cca8f`** — "nip02: make petnames great again (#2472)"

No open PR or issue in either repo claims kind 1337 (searched 2026-09-20). The two hits that
mention "1337" in title/body (`#2403` animated media, `#2367` data-functions) both reference
*C0's* kind or an unrelated PR number — neither proposes a new meaning for it.

---

## 2. Live collision evidence (production, not just paperwork)

`nak req -k 1337 wss://nostr.mom` — first 500 events, 2026-09-20:

| bucket | count | identification |
|---|---|---|
| C0-shaped code snippets | **440** | carries `l` + `extension` + `name` tags — e.g. `name=sparrowdesktop_build`, `bisq2_build`, `bitcoinkeeper_build`, `bluewallet_build` (base64 bash build scripts) |
| **nostrhackday seat proofs** | **47** | carries the `nhr` tag; all `status: accepted`; newest `created_at 1789799911` = 2026-09-19 20:38 UTC |
| neither / other | 13 | |

So the two meanings already share the kind **on a relay the page publishes to** (47 events
from the shipped flow, from a live hackday signup run). Practical consequences, honestly
sized:

- A C0-aware client listing kind 1337 renders seat proofs as code snippets, and a
  kind-1337 code feed shows the RSVPs. **Cosmetic, but real and already happening.**
- The RSVP count is safe *only* because the collector filters `#nhr`; any consumer that
  filters on kind alone mixes the two namespaces.
- Relays do not care (kind ranges are not enforced), so nothing is broken protocol-wise, and
  `purplepag.es` refusing the kind is unrelated (it is profile/kind-focused).
- Etiquette-wise the flow is squatting on a registered, `in_use: true` kind.

There is a real counter-argument to registering anything here: the NIPs repo's own
acceptance criteria (§"Criteria for acceptance") include "There should be no more than one
way of doing the same thing", and a *registered* RSVP kind already exists (NIP-52 kind
31925). A second, bespoke "event RSVP" concept invites exactly that objection — which is
part of why option C below is on the table.

---

## 3. Options — operator decision (pick one)

**A. Keep 1337 as shipped (recommended until after the event).**
Zero code change, and there is **nothing to post upstream**. Kind 1337 remains a bespoke,
unregistered app kind — which is legitimate (the registry is explicitly not exhaustive, and
unregistered app kinds are normal). Cost: the §2 overlap continues. Optional polish, no
registration needed: publish a NIP-52 `31922` date-based calendar event for the hackday and
let attendees send `31925` RSVPs for ecosystem discoverability (the design doc already
listed this as "optional polish").
*Why recommended now: the event is 9 days out and the RSVP flow is e2e-verified on a live
page; changing the kind is a code change to a shipped signup path with a relay write set
(and 47 events already published under 1337).*

**B. Migrate to a free numbered kind and register it** (do it right; recommended if the
operator wants the registration to actually exist, or judges the overlap unacceptable).
Entry + exact PR text drafted in §4. Cost, all in-repo:
`RSVP_KIND` constant `js/pow-ratchet.js:52`, the byte-exact tag-contract tests in
`test/pow-ratchet.test.mjs` (L739+, L797, L808), the `kind 1337` copy in `index.html`
(L92, L104), `notes/rsvp-signup.md`, and the collector's filter must cover **both** kinds
during the transition (the 47 existing events stay 1337 forever).
Prereq for the nips-README variant only: a public spec doc (`docs/KIND-<n>-SPEC.md`).

**C. Migrate to NIP-52 kind 31925 (Calendar Event RSVP) — no PR at all.**
Already registered → nothing to post, and it satisfies "one way of doing a thing". But it is
addressable (one RSVP per pubkey, `d`-based) with a rigid `status` vocabulary
(`accepted`/`declined`/`tentative`) and is specced against an org-published `31922`/`31923`
which must exist first. The design doc rejected it on exactly those grounds (§1).

**Never: register 1337.** C0 owns it, `in_use: true`, in both registries. A PR proposing a
second meaning would be closed.

---

## 4. Drafted entry (option B) — registry-of-kinds `schema.yaml`

Kind number: **1338** is the drafted default (verified free, §6). The number is the
operator's call: substituting another candidate is one line in this entry + one constant in
the page.

```yaml
  1338:
    description: Event Attendance Proof
    content:
      type: free
    required:
      - t
      - status
    tags:
      - name: t
        next:
          type: lowercase
          required: true
        description: event hashtag, e.g. "nostrhackday"
      - name: nhr
        next:
          type: free
          required: true
        description: per-event marker, e.g. "2026-09-29-berlin"; the organizer's collection filter
      - name: status
        next:
          type: constrained
          either:
            - accepted
            - tentative
            - interested
          required: true
      - name: client
        next:
          type: free
          required: true
        description: client identifier, e.g. "nostrhackday-signup"
      - name: nonce
        next:
          type: free
          required: true
          next:
            type: free
            required: true
        description: NIP-13 proof-of-work nonce, [value, declared bits]
```

Notes on the entry:

- `content: {type: free}` — the shipped shape is one human line then a JSON object
  `{v, proof, event, bits, nonce, npub}` (PROOF_VERSION 3). The registry models content as a
  single free field, so the JSON shape is a reference-implementation detail, not schema.
- `required: [t, status]` matches the minimum the shipped builder always emits
  (`buildTags()` → `t`, `nhr`, `status`, `client`, `+ nonce`).
- Tag order in the file is the emitted order; `client` and `nhr` are described exactly as the
  page writes them (`['client','nostrhackday-signup']`, `['nhr','2026-09-29-berlin']`).
- Types are restricted to the ones `schema.yaml` actually uses (`free`, `lowercase`,
  `constrained`, `url`, `pubkey`, `hex`, `json`, `timestamp`, … — there is no `number`
  type, hence `free` for the nonce bit count).

### Drafted entry — nips README variant (needs a spec doc first)

Table row (insert in numeric order, between L174 `1311` and L175 `1337`):

```
| `1338`        | Event Attendance Proof          | [nostrhackday][nostrhackday]           |
```

Link reference (in the external-ref block, L303–L308):

```
[nostrhackday]: https://github.com/felixfelix-bot/nostrhackday-site/blob/main/docs/KIND-1338-SPEC.md
```

Precedent for a registry row that points at a non-NIP external spec:
`` | `1971` | Problem Tracker | [nostrocket][nostrocket] | `` (README L182, link ref L303),
and `[joinstr]` (L304), `[NKBIP-01]`/`[NKBIP-02]` rows. That is the only legal shape here —
the table's pointer column is mandatory, so **`docs/KIND-1338-SPEC.md` must exist and be
public before that PR can be opened.** It does not exist yet (deliberately — see §7).

---

## 5. Exact PR text

### 5a. Target: `nostr-protocol/registry-of-kinds` (recommended target — accepts app kinds)

**Title:** `add kind 1338: event attendance proof`

**Body:**

```
Adds kind 1338 — Event Attendance Proof.

A regular (1000–9999) kind for a signed attendance/RSVP proof: one event per
attendee per event, carrying the event hashtag (t), a per-event marker, an RSVP
status, the client identifier, and an optional NIP-13 nonce tag carrying the
proof-of-work the client did.

Tag schema, content and required tags are modelled on the reference
implementation, which has been running in production:

  reference implementation:
  https://github.com/felixfelix-bot/nostrhackday-site
  (js/pow-ratchet.js — RSVP_KIND, buildTags/buildProofTags; verified by
   test/pow-ratchet.test.mjs, which asserts the exact tag array)

Why 1338 and not 1337: 1337 is already taken by NIP-C0 (Code Snippet) and is
in_use; this is a distinct concept and must not share the number.

The number is free in this registry, in the NIPs README table, and in the
`kind: N` mentions across the NIPs documents (checked 2026-09-20).

Diff: single `kinds:` hunk appended to schema.yaml (40 insertions(+), no other file touched, nothing removed).
```

**Diff** — generated, not hand-written: applying this hunk to
`schema.yaml@92df81b9` parses (`yaml.safe_load` → 267 kinds,
`kinds[1338]["description"] == "Event Attendance Proof"`) and `git diff --stat` reports
`schema.yaml | 40 ++++++++++++++++++++++++++++++++++++++++` — **1 file changed, 40
insertions(+)**, no deletions, no other file:

```diff
diff --git a/schema.yaml b/schema.yaml
index 0632d02..d492981 100644
--- a/schema.yaml
+++ b/schema.yaml
@@ -1095,6 +1095,46 @@ kinds:
             type: relay
         description: repository URL or NIP-34 address
 
+  1338:
+    description: Event Attendance Proof
+    content:
+      type: free
+    required:
+      - t
+      - status
+    tags:
+      - name: t
+        next:
+          type: lowercase
+          required: true
+        description: event hashtag, e.g. "nostrhackday"
+      - name: nhr
+        next:
+          type: free
+          required: true
+        description: per-event marker, e.g. "2026-09-29-berlin"; the organizer's collection filter
+      - name: status
+        next:
+          type: constrained
+          either:
+            - accepted
+            - tentative
+            - interested
+          required: true
+      - name: client
+        next:
+          type: free
+          required: true
+        description: client identifier, e.g. "nostrhackday-signup"
+      - name: nonce
+        next:
+          type: free
+          required: true
+          next:
+            type: free
+            required: true
+        description: NIP-13 proof-of-work nonce, [value, declared bits]
+
   1971:
     description: Problem Tracker
     content:
```

Reference for the expected PR shape (a previous merge of the same class):
`92df81b9` "add slash commands kind." — `schema.yaml +70/-0`, single file, single hunk.

### 5b. Target: `nostr-protocol/nips` (only if the operator wants the README table row too)

**Title:** `README: register kind 1338 (event attendance proof)`

**Body:**

```
Adds kind 1338 to the Event Kinds table.

1338 is a regular kind for a signed event-attendance / RSVP proof, defined
outside this repository (the table already links external specs, e.g. 1971
Problem Tracker → [nostrocket]).

Spec: https://github.com/felixfelix-bot/nostrhackday-site/blob/main/docs/KIND-1338-SPEC.md
(number free in this table and across the NIPs documents as of 2026-09-20;
 1337 itself is C0's Code Snippet kind and is left untouched)

Diff: one table row + one link reference, README.md only (2 insertions(+), nothing removed).
```

**Diff** — generated against `README.md@11cca8f` — **1 file changed, 2 insertions(+)**:

```diff
diff --git a/README.md b/README.md
index f0db2e0..b78aa4a 100644
--- a/README.md
+++ b/README.md
@@ -172,6 +172,7 @@ This table is not exhaustive. For a machine-readable registry of all known event
 | `1222`        | Voice Message                   | [A0](A0.md)                            |
 | `1244`        | Voice Message Comment           | [A0](A0.md)                            |
 | `1311`        | Live Chat Message               | [53](53.md)                            |
+| `1338`        | Event Attendance Proof          | [nostrhackday][nostrhackday]           |
 | `1337`        | Code Snippet                    | [C0](C0.md)                            |
 | `1617`        | Patches                         | [34](34.md)                            |
 | `1618`        | Pull Requests                   | [34](34.md)                            |
@@ -301,6 +302,7 @@ This table is not exhaustive. For a machine-readable registry of all known event
 | `39701`       | Web bookmarks                   | [B0](B0.md)                            |
 
 [nostrocket]: https://github.com/nostrocket/NIPS/blob/main/Problems.md
+[nostrhackday]: https://github.com/felixfelix-bot/nostrhackday-site/blob/main/docs/KIND-1338-SPEC.md
 [joinstr]: https://gitlab.com/1440000bytes/joinstr/-/blob/main/NIP.md
 [NKBIP-01]: https://wikistr.com/nkbip-01*fd208ee8c8f283780a9552896e4823cc9dc6bfd442063889577106940fd927c1
 [NKBIP-02]: https://wikistr.com/nkbip-02*fd208ee8c8f283780a9552896e4823cc9dc6bfd442063889577106940fd927c1
```

Caution on 5b: the row order in that table is *not* strictly ascending (L166 `1234` sits
above L167 `1040`), so insert next to `1311`/`1337` rather than assuming sortedness.

---

## 6. Numbers verified free on 2026-09-20

Method (reproducible): union of (a) registry-of-kinds `schema.yaml` `kinds:` keys — 266;
(b) every numeric row of the nips README table, ranges expanded — 171 rows; (c) every
`kind[:\s`=]*NNNN` mention in all `*.md` of the nips repo — 160 numbers. Union = **304
distinct numbers**; free in 1000–9999 = **8898**.

- **Free candidates:** 1338, 1212, 1414, 1515, 1717, 1776, 1300, 1400, 1500, 4711, …
- **Taken / confusable nearby:** 1337 (C0 Code Snippet), 1234 (Draft Checkpoint, NIP-37),
  1311 (Live Chat Message, NIP-53), 1984 (Reporting, NIP-56), 1985 (Label, NIP-32),
  1987 (NKBIP-02), 7516/7517 (Geocache, NIP-CC), 31925 (Calendar Event RSVP, NIP-52).
- Caveat: "free in the registries" ≠ "unused in the wild". A relay-side sample
  (`nak req -k N wss://nostr.mom`) is worth one minute before committing to a number; not
  done for the candidates above.

---

## 7. What was deliberately NOT done

- **No upstream PR opened, no upstream fork/branch created** in `registry-of-kinds` or
  `nostr-protocol/nips`. Posting is the operator's trigger.
- **No code or test change** — the RSVP flow, the relay write set and the published events
  are untouched (`RSVP_KIND` is still 1337 in `js/pow-ratchet.js:52`).
- **No `docs/KIND-1338-SPEC.md` written** — it is only needed if option B (and 5b) is
  chosen; writing it before the operator picks a path would be speculative.
- `~/repos/nostrhackday-site` is the fork working copy: remote **`fork` =
  felixfelix-bot/nostrhackday-site** (site of record, pushed); `origin` and `upstream` both
  point at `c03rad0r/nostrhackday-site` and were **not** pushed.

## 8. Operator trigger

Reply with one of:

- **A** — keep 1337, stop here (documentation only; nothing to post).
- **B `<number>`** — migrate the flow to that kind, then: write `docs/KIND-<n>-SPEC.md`,
  open the registry-of-kinds PR (§5a), and optionally the nips README PR (§5b).
- **C** — migrate to NIP-52 `31925` instead; no registry PR needed (publish a `31922`
  calendar event first).

Until then this document is the deliverable and no upstream action is taken.

---

## Appendix — raw evidence (2026-09-20)

```
$ curl -s https://raw.githubusercontent.com/nostr-protocol/nips/master/README.md | grep -n 1337
175:| `1337`        | Code Snippet                    | [C0](C0.md)                            |

$ sed -n '121,123p' README.md          # nostr-protocol/nips
## Event Kinds
This table is not exhaustive. For a machine-readable registry of all known event kinds
prefer <https://github.com/nostr-protocol/registry-of-kinds> ...

$ grep -n 1337 schema.yaml             # nostr-protocol/registry-of-kinds
1044:  1337:
# (L1045-1046: description: Code Snippet / in_use: true)

$ grep -n 1337 C0.md                   # nostr-protocol/nips
15:This NIP defines `kind:1337` as a code snippet event.

$ nak req -k 1337 wss://nostr.mom | head -500   # bucket counts
total 500 | ours (nhr tag) 47 | C0-shaped (extension tag) 440 | neither 13
newest ours: created_at 1789799911 (2026-09-19T20:38Z)

$ gh api repos/nostr-protocol/nips/commits?path=C0.md   # provenance
f90101406 2025-03-29  rename 95 to C0.
```

Pinned repo revisions used for the line numbers above: `registry-of-kinds@92df81b9`,
`nips@11cca8f`. If either has moved, re-run the four commands in this appendix before
acting — the README table and `schema.yaml` are both actively edited (the table's biggest
recent change is the registry pointer itself).
