/**
 * signup.js — Nostr Hackday RSVP page.
 *
 * Wallet-less, backend-less, build-step-less.
 *
 *  · Identity: an ephemeral key is mined in a Web Worker and never leaves the
 *    browser (it is released to the visitor the moment the key exists — losing
 *    it loses the seat). There is no second signer: the mined key signs both
 *    events.
 *  · Mining: `pow-ratchet.js` mined once — a visible leet npub prefix (proof of
 *    work a human can check at a glance) plus a NIP-13 nonce top-up that carries
 *    the exact ladder rung. Workers start at page load and only ever top up.
 *  · Counter: an applesauce `EventStore` fed from public relays over plain
 *    WebSockets, read through a reactive `store.timeline(...)` query, so the
 *    accepted-RSVP count and the current rung update live as events arrive.
 *  · Publish: straight from the browser to public relays. No server anywhere.
 *
 * QA surface: `window.__nhd` exposes the live state; `?selftest=1` switches to
 * test-scale mining parameters (1 leet char / base 5 / cap 8) and autopilots one
 * RSVP so a headless browser can exercise the whole path in seconds. The
 * verifier (`resolve`) is never weakened by that flag — it only changes how much
 * work the *client* does.
 */
import { EventStore } from '../vendor/esm/applesauce-core@6.2.0/es2022/applesauce-core.bundle.mjs';
import { RelayPool } from '../vendor/esm/applesauce-relay@6.2.1/es2022/applesauce-relay.bundle.mjs';
import {
  DEFAULT_PARAMS,
  PROOF_STATUS,
  buildTags,
  canStartMining,
  describeRsvp,
  lowEntropyLabel,
  requiredBits,
  resolve,
  scanLowEntropyWindows,
  secretKeyToNsec,
  shouldAutoPublishProof,
  vanityInfo,
  verifyRsvp,
} from './pow-ratchet.js?v=4e09c6cb0a';
import { createGrindViz, renderNpub } from './viz.js?v=4e09c6cb0a';

// ── configuration ────────────────────────────────────────────────────────────

const qs = new URLSearchParams(location.search);
const SELFTEST = qs.get('selftest') === '1';
const DRY_RUN = SELFTEST && !qs.has('relays');

/** Locked ladder parameters, optionally switched to test scale for the QA path. */
const PARAMS = SELFTEST
  ? { ...DEFAULT_PARAMS, base: 5, cap: 8, vanityChars: 1 }
  : DEFAULT_PARAMS;

const RELAYS = qs.has('relays') ? qs.get('relays').split(',').filter(Boolean) : DRY_RUN ? [] : PARAMS.publishRelays;
/**
 * REQ tag filter — INDEXED TAGS ONLY. `#nhr` is multi-letter and strfry relays
 * refuse such a REQ ("unindexed tag filter"), so the counter read 0 forever.
 * `t` is indexed; verifyRsvp + isHackdayEvent enforce the eventTag on read.
 */
const RSVP_FILTER = { kinds: [PARAMS.kind], '#t': [PARAMS.hashtag] };
/**
 * What we ask the store for. NOTE: applesauce's reactive `store.timeline()`
 * model does not match multi-letter tag filters (`#nhr`) even though
 * `store.getByFilters()` does — verified in Chrome 2026-09-16 — so the live
 * query narrows by kind only and the coordinate tag is enforced locally
 * (and again, redundantly, by resolve()).
 */
const STORE_FILTER = { kinds: [PARAMS.kind] };
const isHackdayEvent = (event) =>
  Array.isArray(event?.tags) && event.tags.some((t) => t[0] === PARAMS.tagName && t[1] === PARAMS.eventTag);
const MIN_DWELL_MS = SELFTEST ? 0 : 3000;
const MAX_WORKERS = 8;

const $ = (id) => document.getElementById(id);

// ── state ────────────────────────────────────────────────────────────────────

const state = {
  phase: 'loading',
  error: null,
  mined: null,
  /**
   * ADDENDUM 2 — the intent gate. Nothing grinds, and therefore nothing can be
   * auto-published, until the visitor presses RSVP: a proof event takes a seat on
   * the ladder and ratchets the difficulty, so a drive-by page load must not mine.
   * `started` latches on the first press, which is what stops a double press from
   * spawning a second worker set.
   */
  started: false,
  intent: false,
  progress: { vanityTries: 0, nonceTries: 0, keysPerSecond: 0, hashesPerSecond: 0, workers: {}, startedAt: Date.now() },
  accepted: [],
  acceptedUnvetted: [],
  rejected: [],
  nextRequiredBits: PARAMS.base,
  signed: null,
  published: [],
  /** flow v2: the unattended proof event — filled the moment publishing starts */
  proof: null,
  /** the details form + the nsec handover, revealed only after that publish */
  revealed: false,
  /** the (optional) second, personal event went out */
  detailsPublished: false,
  relayEvents: 0,
  eose: false,
  loadedAt: Date.now(),
};

const workers = [];
let winner = null;
let counterTopic = null;
let viz = null;
let store = null;
let pool = null;

// ── reactive RSVP counter (applesauce) ───────────────────────────────────────

function setupCounter() {
  store = new EventStore();
  pool = new RelayPool({ publishTimeout: 12000 });

  // Reactive query: re-runs on EVERY store change, so the count, the current
  // rung and the seat list all move live as relays deliver events.
  counterTopic = store.timeline(STORE_FILTER).subscribe((events) => {
    const list = (Array.isArray(events) ? events : []).filter(isHackdayEvent);
    const result = resolve(list, PARAMS);
    state.accepted = result.accepted;
    state.acceptedUnvetted = result.acceptedUnvetted;
    state.rejected = result.rejected;
    state.nextRequiredBits = result.nextRequiredBits;
    renderCounter(result, list.length);
    retarget(result.nextRequiredBits);
    // the rung can move under us: re-check the v2 auto-publish on every update
    maybeAutoPublishProof();
  });

  if (!RELAYS.length) {
    state.phase = state.phase === 'loading' ? 'mining' : state.phase;
    renderCounter(resolve([], PARAMS), 0);
    return;
  }

  for (const url of RELAYS) renderRelayChip(url, 'connecting');

  // RelayPool collapses per-relay EOSE markers, so "live" is decided by the
  // first event or by a short settle timer, whichever happens first.
  setTimeout(() => {
    state.eose = true;
    setLiveStatus(`live — watching ${RELAYS.length} relays`);
    // the rung is real now (the seat count is in): a key that clears it may publish
    maybeAutoPublishProof();
  }, 4000);

  pool
    .subscription(RELAYS, RSVP_FILTER, { reconnect: Infinity, resubscribe: true })
    .subscribe({
      next: (value) => {
        if (typeof value === 'string') return; // EOSE sentinel
        state.relayEvents += 1;
        if (!state.eose) {
          state.eose = true;
          setLiveStatus(`live — ${state.relayEvents} event(s) from ${RELAYS.length} relays`);
        }
        store.add(value); // verified by EventStore before it lands
      },
      error: (e) => console.warn('[nhd] relay subscription error', e),
    });

  pool.status$.subscribe((statuses) => {
    for (const [url, s] of Object.entries(statuses ?? {})) {
      renderRelayChip(url, s?.connected ? 'connected' : 'offline');
    }
  });
}

function renderCounter(result, total) {
  const acceptedEl = $('counter-accepted');
  if (!acceptedEl) return;
  acceptedEl.textContent = String(result.accepted.length);
  $('counter-total').textContent = String(total);
  $('counter-seats').textContent = String(result.seatsOpen);
  const next = result.nextRequiredBits;
  $('counter-next').textContent = next === null ? 'ladder full' : `${next} bits`;
  $('counter-floor').textContent = `${PARAMS.vanityChars} leet chars + raindrop + ${Math.max(0, (next ?? PARAMS.base) - PARAMS.vanityChars * 5)} nonce bits`;

  const list = $('counter-list');
  list.replaceChildren(
    ...result.accepted.slice(0, 40).map((entry) => {
      const li = document.createElement('li');
      li.className = 'rsvp-row';
      const who = describeRsvp(entry.event);
      const npub = document.createElement('span');
      npub.className = 'rsvp-npub npub';
      // green zone = mined leet prefix, orange = anti-phish zone, ring = raindrop
      const scan = entry.lowEntropy;
      const win = scan?.found
        ? { start: scan.start, length: scan.windowSize, label: lowEntropyLabel(scan) }
        : null;
      const parts = buildZoneSpans(entry.npub, entry.vanityChars, win);
      npub.append(...parts);
      const meta = document.createElement('span');
      meta.className = 'rsvp-meta';
      meta.textContent = `${entry.bits}b${entry.vetted ? ' · vetted' : ` · seat ${entry.seat}`}${who?.name ? ` · ${who.name}` : ''}`;
      li.append(npub, meta);
      return li;
    }),
  );
  $('counter-rejected').textContent = String(result.rejected.length);
}

function buildZoneSpans(npub, chars, window = null) {
  const parts = [];
  const mk = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };
  const body = npub.startsWith('npub1') ? npub.slice(5) : npub;
  parts.push(mk('npub-prefix', 'npub1'));
  // split the body at the raindrop window edges so the ring wraps exactly those
  // characters (and stays one continuous outline when it straddles a zone)
  const cuts = [0, chars, chars + 4, body.length];
  if (window && Number.isFinite(window.start) && window.length > 0) {
    cuts.push(
      Math.max(0, Math.min(window.start, body.length)),
      Math.max(0, Math.min(window.start + window.length, body.length)),
    );
  }
  const points = [...new Set(cuts)].sort((a, b) => a - b);
  let ring = null;
  let ringTo = -1;
  for (let i = 0; i < points.length - 1; i += 1) {
    const s = points[i];
    const e = points[i + 1];
    if (e <= s) continue;
    const inWindow = window && Number.isFinite(window.start) && s >= window.start && e <= window.start + window.length;
    let cls = 'npub-tail';
    if (e <= chars) cls = 'npub-vanity';
    else if (s < chars) cls = 'npub-vanity';
    else if (e <= chars + 4) cls = 'npub-antiphish';
    else if (s < chars + 4) cls = 'npub-antiphish';
    if (inWindow) {
      if (!ring || s !== ringTo) {
        ring = mk('npub-window', '');
        parts.push(ring);
      }
      ring.appendChild(mk(`${cls} npub-window-part`, body.slice(s, e)));
      ringTo = e;
      if (window.label) ring.title = window.label;
    } else {
      parts.push(mk(cls, body.slice(s, e)));
      ring = null;
    }
  }
  return parts;
}

function renderRelayChip(url, cls) {
  const host = $('relay-chips');
  if (!host) return;
  // applesauce normalises relay urls with a trailing slash, so key chips on the
  // normalised form or the status update creates a duplicate chip
  const key = url.endsWith('/') ? url : `${url}/`;
  let chip = host.querySelector(`[data-relay="${CSS.escape(key)}"]`);
  if (!chip) {
    chip = document.createElement('span');
    chip.dataset.relay = key;
    chip.className = 'relay-chip';
    chip.textContent = key.replace('wss://', '').replace(/\/$/, '');
    host.appendChild(chip);
  }
  chip.dataset.state = cls;
}

// ── mining ───────────────────────────────────────────────────────────────────

/**
 * ADDENDUM 2 — relay chatter may only take over the status line once the visitor
 * has pressed RSVP; until then the idle prompt owns it.
 */
function setLiveStatus(text) {
  if (!state.started) return;
  setStatus('live', text);
}

/**
 * THE INTENT GATE — the one and only way the grind starts.
 *
 * Called from the RSVP button's click handler (and, headlessly, from the
 * selftest), never from page load. `canStartMining()` is the pure predicate and
 * the latch lives here, so a second press returns false and cannot spawn a
 * second worker set.
 */
function startMiningFromIntent() {
  if (!canStartMining({ started: state.started, intent: state.intent })) return false;
  state.started = true;
  renderStartState();
  startWorkers();
  return true;
}

/**
 * The panel title is a state. Before the press it invites — "Mine your RSVP" —
 * and from the press on it narrates what the browser is doing — "Mining your
 * RSVP". Both places the title is written (the panel heading in index.html and
 * the grind head in js/viz.js) move together.
 */
function setPanelTitle(running) {
  const label = $('mine-title-text');
  if (label) label.textContent = running ? 'Mining your RSVP' : 'Mine your RSVP';
}

/**
 * The RSVP button: press => intent => grind, then show the mining panel. The
 * panel (not the button) is where the visitor watches and later hands over keys.
 */
function onRsvpPress(ev) {
  ev?.preventDefault?.();
  state.intent = true;
  const started = startMiningFromIntent();
  // the invite becomes the live state the instant the grind is ours to run
  if (started) setPanelTitle(true);
  // move the visitor to the panel they just started
  $('signup')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('mining')?.focus({ preventScroll: true });
  return started;
}

/**
 * After the press the CTA reflects state, so a second click cannot start a
 * second grind: the href is gone (no second navigation), the label says what is
 * happening and aria-disabled keeps the intent legible to ATs.
 */
function renderStartState() {
  if (!state.started) return;
  const cta = $('cta-mine');
  if (!cta) return;
  const arrow = cta.querySelector('.cta-arrow');
  cta.replaceChildren('mining… ', ...(arrow ? [arrow] : []));
  cta.dataset.state = 'mining';
  cta.removeAttribute('href');
  cta.setAttribute('aria-disabled', 'true');
}

function startWorkers() {
  const hw = Math.max(1, Math.min(MAX_WORKERS, navigator.hardwareConcurrency || 2));
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const targetBits = Math.max(PARAMS.base, state.nextRequiredBits ?? PARAMS.base);
  let finished = 0;
  const tally = () => {
    const rows = Object.values(state.progress.workers);
    state.progress.vanityTries = rows.reduce((sum, r) => sum + r.tries, 0);
    state.progress.keysPerSecond = rows.reduce((sum, r) => sum + r.keysPerSecond, 0);
  };

  for (let index = 0; index < hw; index += 1) {
    const worker = new Worker('./js/pow-worker.js?v=4e09c6cb0a', { type: 'module' });
    workers.push(worker);
    state.progress.workers[index] = { tries: 0, keysPerSecond: 0 };
    worker.onmessage = (ev) => {
      const msg = ev.data ?? {};
      switch (msg.type) {
        case 'progress':
          if (msg.phase === 'vanity') {
            state.progress.workers[msg.workerIndex] = { tries: msg.tries, keysPerSecond: msg.keysPerSecond ?? 0 };
            tally();
            state.phase = 'mining-vanity';
            (msg.samples ?? []).forEach((s) => viz?.push(s, msg.best ?? null));
          } else {
            state.progress.nonceTries += 1;
            state.progress.hashesPerSecond = msg.hashesPerSecond ?? 0;
            // once the v2 proof is in flight the phase belongs to the proof, so a
            // progress tick must not flip the UI back to "topping up"
            if (!state.proof) state.phase = 'mining-nonce';
          }
          renderMining();
          break;
        case 'mined': {
          finished += 1;
          // a stray report from a worker we already retired is not our key
          if (winner && winner !== worker) break;
          const first = !winner;
          if (first) {
            winner = worker;
            // the other workers are redundant now: the expensive half is done
            for (const w of workers) if (w !== worker) w.terminate();
            // the nsec of that npub exists only inside this worker: ask for it
            // right away, so the key is on screen the moment the grind stops
            worker.postMessage({ type: 'export' });
          }
          // authoritative: a retarget top-up sends a refreshed report, so this
          // keeps declaredBits/template in step with the bare rung we can clear
          state.mined = msg;
          if (first) {
            state.phase = 'ready';
            viz.setFound({ npub: msg.npub, chars: msg.vanityChars, bits: msg.vanityBits, scan: msg.scan });
            viz.setState('key mined — publishing the proof at the current rung', 'found');
            document.dispatchEvent(new CustomEvent('nhd:ready', { detail: msg }));
          } else {
            viz.setState(`rung moved to ${msg.targetBits} bits`, 'topup');
          }
          renderMining();
          // flow v2: no click, no form — the moment we clear the rung we publish
          maybeAutoPublishProof();
          break;
        }
        case 'proof':
          onProof(msg);
          break;
        case 'signed':
          onSigned(msg.event);
          break;
        case 'exported': {
          const nsec = `${msg.nsec ?? msg.secretKey}`;
          $('nsec-out').value = nsec;
          $('nsec-out').hidden = false;
          // the handover opens by itself — the nsec IS the seat, no click needed
          $('key-panel').hidden = false;
          viz?.setSecret(nsec);
          break;
        }
        case 'error':
          console.warn('[nhd] worker error', msg.message, msg.context);
          if (msg.context?.type === 'sign') fail(msg.message);
          else setStatus('error', `worker: ${msg.message}`);
          break;
        default:
          break;
      }
    };
    worker.postMessage({
      type: 'grind',
      seed,
      workerIndex: index,
      params: PARAMS,
      targetBits,
    });
  }
  state.phase = 'mining-vanity';
  setStatus('mining', `mining — ${hw} worker${hw > 1 ? 's' : ''} grinding ${PARAMS.vanityChars} leet chars`);
}

/**
 * Ladder moved: raise the worker's target. Monotone by construction — the page
 * never asks for less work than the worker already did, and the worker itself
 * refuses to re-grind downhill.
 *
 * The target is `detailsTargetBits()`, which EXCLUDES our own published proof:
 * that event already took this seat, so topping up for it a second time would
 * be paying twice for one seat.
 */
function retarget(nextRequiredBits) {
  if (!winner || nextRequiredBits === null) return;
  const target = detailsTargetBits();
  const current = state.mined?.targetBits ?? PARAMS.base;
  if (target <= current) return;
  state.mined = { ...state.mined, targetBits: target };
  winner.postMessage({ type: 'retarget', targetBits: target });
  viz.setState(`rung moved to ${target} bits — topping up nonce`, 'topup');
  setStatus('mining', `topping up proof of work to ${target} bits`);
}

// ── flow v2: the unattended proof event, then the reveal ─────────────────────
//
// Nothing personal is published until the visitor fills the form. The moment the
// mined key clears the CURRENT rung, the page publishes a kind-1337 proof event
// carrying only machine-generated proof text and the programmatic tags — no
// click, no form, no consent checkbox, because there is nothing personal in it.
// The details form and the nsec handover are revealed only after that.

const njumpUrl = (id) => `https://njump.me/${id}`;

/** Difficulty of the key the workers mined: vanity bits + declared nonce bits. */
const minedDifficulty = () =>
  state.mined ? state.mined.vanityBits + (state.mined.declaredBits ?? 0) : PARAMS.base;

/**
 * The rung the details event has to clear: the rung the proof cleared (same
 * seat, identical verification), lifted only if other RSVPs have moved the
 * ladder since. Our OWN proof is excluded from the seat count — resolve()
 * dedupes by pubkey through betterOf(), so the follow-up must not pay for a
 * second seat.
 */
function detailsTargetBits() {
  const mine = state.proof?.event?.id;
  const others = state.acceptedUnvetted.filter((e) => e.id !== mine).length;
  const othersRung = requiredBits(others, PARAMS);
  return Math.max(PARAMS.base, state.proof?.rung ?? PARAMS.base, othersRung ?? PARAMS.base);
}

/**
 * The auto-publish guard + trigger, called from every input that can change the
 * answer (key mined, rung moved, relay picture settled). Exact-once per page
 * load and monotone: see shouldAutoPublishProof() for the rules it enforces.
 */
function maybeAutoPublishProof() {
  if (!winner || !state.mined) return;
  const rung = state.nextRequiredBits;
  const go = shouldAutoPublishProof({
    published: !!state.proof,
    difficulty: minedDifficulty(),
    rung,
    settled: RELAYS.length === 0 || state.eose,
  });
  if (!go) return;
  state.proof = { status: 'publishing', rung, targetBits: rung, at: Date.now() };
  state.phase = 'proof-publishing';
  setStatus('working', `rung ${rung} reached — publishing the proof event…`);
  winner.postMessage({ type: 'proof', targetBits: rung, status: PROOF_STATUS });
}

/**
 * The proof came back ground and signed. Check it with our own verifier first —
 * we do not publish what we cannot verify — then publish it once and reveal the
 * rest of the flow.
 */
async function onProof(msg) {
  const proof = state.proof ?? (state.proof = { status: 'publishing', rung: msg.rung ?? PARAMS.base });
  const event = msg.event ?? null;
  proof.event = event;
  proof.nonce = msg.nonce;
  proof.declaredBits = msg.declaredBits;
  proof.rung = msg.rung ?? proof.rung;

  const verdict = event ? verifyRsvp(event, PARAMS) : { ok: false, reason: 'no event' };
  if (!verdict.ok) {
    proof.status = 'failed';
    proof.published = [];
    proof.error = `our own verifier rejected the proof (${verdict.reason}) — nothing was published`;
    revealFlow();
    fail(proof.error);
    document.dispatchEvent(new CustomEvent('nhd:proof', { detail: { ok: false, error: proof.error } }));
    return;
  }
  proof.bits = verdict.bits;

  if (!RELAYS.length) {
    // dry run: nothing is published on purpose, so the local record is the point
    proof.published = [{ from: 'dry-run', ok: true, message: 'no relays in this run' }];
  } else {
    try {
      const results = await pool.publish(RELAYS, event);
      const list = Array.isArray(results) ? results : [results];
      proof.published = list.map((r) => ({ from: r?.from ?? r?.url ?? 'relay', ok: !!r?.ok, message: r?.message ?? '' }));
    } catch (e) {
      proof.published = [{ from: 'publish', ok: false, message: String(e?.message ?? e) }];
    }
  }

  // count it only once a relay holds it: the counter must never show a seat that
  // no relay has — that is what made "accepted 1" become 0 on reload (2026-09-17).
  // (A dry run's entry is `ok: true`, so that path still records locally.)
  if (proof.published.some((p) => p.ok)) store.add(event);

  const ok = proof.published.filter((p) => p.ok).length;
  state.formUnlocked = ok > 0;
  proof.status = ok ? 'published' : 'failed';
  state.phase = ok ? 'proof-published' : 'proof-failed';
  renderProof();
  revealFlow();
  if (!state.formUnlocked) lockDetailsForm();
  setStatus(
    ok ? 'ok' : 'error',
    ok
      ? `proof of work published (${ok}/${proof.published.length} relays) — rung ${proof.rung}, ${verdict.bits} bits`
      : 'the proof event did not reach any relay — no seat was taken, so the details form stays locked. Your key is below; reload to grind and publish again.',
    ok ? { href: njumpUrl(event.id), text: `${event.id.slice(0, 16)}…` } : null,
  );
  document.dispatchEvent(new CustomEvent('nhd:proof', { detail: { ok: !!ok, event, published: proof.published, rung: proof.rung } }));
}

/** Fill the proof panel: the bare event id + a njump link. No personal fields. */
function renderProof() {
  const panel = $('proof-panel');
  if (!panel) return;
  const proof = state.proof;
  const event = proof?.event;
  panel.hidden = !event;
  if (!event) return;
  const idLink = $('proof-id');
  if (idLink) {
    idLink.href = njumpUrl(event.id);
    idLink.textContent = event.id;
  }
  const bitsEl = $('proof-bits');
  if (bitsEl) bitsEl.textContent = `kind ${event.kind} · rung ${proof.rung} · ${proof.bits} bits · nonce ${proof.nonce}`;
  const log = $('proof-log');
  if (log) {
    log.replaceChildren(
      ...(proof.published ?? []).map((p) => {
        const line = document.createElement('li');
        line.className = p.ok ? 'pub-ok' : 'pub-fail';
        line.textContent = `${p.ok ? '✓' : '✗'} ${p.from}${p.message ? ` — ${p.message}` : ''}`;
        return line;
      }),
    );
  }
}

/**
 * The reveal: called only once the proof event is out (or once it failed — then
 * the form is the visitor's only way to publish, and it is still the event that
 * carries the consent checkbox). The nsec handover is part of the reveal, so a
 * visitor who never fills the form still walks away with their key.
 */
function lockDetailsForm() {
  const panel = $('details-panel');
  if (!panel) return;
  panel.hidden = true;
  for (const f of panel.querySelectorAll('input, textarea, button')) f.disabled = true;
}
function revealFlow() {
  if (state.revealed) return;
  state.revealed = true;
  for (const id of ['details-panel', 'key-panel']) {
    const el = $(id);
    if (el) el.hidden = false;
  }
}

function renderMining() {
  const p = state.progress;
  const expected = 32 ** PARAMS.vanityChars;
  const pct = Math.min(99.9, (p.vanityTries / expected) * 100);
  viz?.setStats({
    tries: p.vanityTries,
    keysPerSecond: p.keysPerSecond,
    phase: state.proof ? 'proof grind' : state.phase === 'mining-nonce' ? 'nonce top-up' : 'vanity grind',
    target: state.mined?.targetBits ?? PARAMS.base,
    elapsedMs: Date.now() - p.startedAt,
  });
  const bar = $('mine-bar');
  if (bar) bar.style.width = `${state.mined ? 100 : pct}%`;
  const label = $('mine-label');
  if (label) {
    label.textContent = state.mined
      ? `mined ${state.mined.vanityChars} chars (${state.mined.vanityBits} bits)`
      : `${p.vanityTries.toLocaleString('en-US')} tries · ${Math.round(p.keysPerSecond)} keys/s · ~${pct.toFixed(1)}% of the expected 1/${expected}`;
  }
}

// ── submit ───────────────────────────────────────────────────────────────────

function formContent() {
  const val = (id) => $(id)?.value?.trim() ?? '';
  return JSON.stringify({
    v: 1,
    nym: val('f-name').slice(0, 80),
    alias: val('f-alias').slice(0, 80),
    intent: val('f-intent'),
    skill: val('f-skill').slice(0, 200),
    idea: val('f-idea').slice(0, 600),
    diet: val('f-diet').slice(0, 120),
    contact: val('f-contact').slice(0, 160),
    event: PARAMS.eventTag,
  });
}

function validate() {
  if (state.detailsPublished) return 'Already submitted.';
  if (!state.mined) return 'Proof of work is still being mined — hang on a moment.';
  if (state.proof?.status === 'publishing') return 'Just finishing the proof event — one moment.';
  if ($('f-name').value.trim().length < 2) return 'Please give a nym (2+ characters).';
  if ($('f-intent').value === '') return 'Please pick what you want to do at the hackday.';
  if (!$('f-consent').checked) return 'Please confirm the RSVP is published publicly to relays.';
  if (!SELFTEST) {
    if ($('hp-field').value.trim() !== '') return 'Rejected (spam trap).';
    if (Date.now() - state.loadedAt < MIN_DWELL_MS) return 'Please take a moment to read the page first.';
  }
  return null;
}

async function submit() {
  const problem = validate();
  if (problem) {
    setStatus('error', problem);
    state.error = problem;
    return false;
  }
  state.error = null;
  state.phase = 'signing';
  setStatus('working', 'submitting proof of work…');
  const content = formContent();

  // the details event reuses the rung the proof cleared (never a fresh seat)
  winner.postMessage({ type: 'sign', content, targetBits: detailsTargetBits() });
  return true;
}

async function onSigned(event) {
  const verdict = verifyRsvp(event, PARAMS);
  if (!verdict.ok) {
    fail(`our own verifier rejected the submission (${verdict.reason}) — nothing was published`);
    return;
  }
  state.signed = event;
  state.phase = 'publishing';
  setStatus('working', 'published to relays…');

  if (!RELAYS.length) {
    state.published = [{ from: 'dry-run', ok: true, message: 'no relays in this run' }];
  } else {
    try {
      const results = await pool.publish(RELAYS, event);
      const list = Array.isArray(results) ? results : [results];
      state.published = list.map((r) => ({ from: r?.from ?? r?.url ?? 'relay', ok: !!r?.ok, message: r?.message ?? '' }));
    } catch (e) {
      state.published = [{ from: 'publish', ok: false, message: String(e?.message ?? e) }];
    }
  }
  // same rule as the proof: counted only after a relay has it (a dry run's entry
  // is `ok: true`, so that path still records locally)
  if (state.published.some((p) => p.ok)) store.add(event);
  else setStatus('error', 'the RSVP did not reach any relay — it is not a seat for anyone else. Your key is below.');
  finish();
}

function finish() {
  state.phase = 'done';
  state.detailsPublished = true;
  revealFlow(); // the key handover must be visible whenever an event of ours went out
  const ok = state.published.filter((p) => p.ok).length;
  setStatus(ok ? 'ok' : 'error', ok ? `RSVP published (${ok}/${state.published.length} relays accepted)` : 'relays did not accept the RSVP');
  const box = $('publish-log');
  box.replaceChildren(
    ...state.published.map((p) => {
      const line = document.createElement('li');
      line.className = p.ok ? 'pub-ok' : 'pub-fail';
      line.textContent = `${p.ok ? '✓' : '✗'} ${p.from}${p.message ? ` — ${p.message}` : ''}`;
      return line;
    }),
  );
  $('result').hidden = false;
  // the raindrop window travels with the event, so show it here too
  const scan = state.mined?.scan ?? scanLowEntropyWindows(state.mined.npub, PARAMS);
  const win = scan?.found ? { start: scan.start, length: scan.windowSize, label: lowEntropyLabel(scan) } : null;
  $('result-npub').replaceChildren(
    ...renderNpub(state.mined.npub, {
      chars: state.mined.vanityChars,
      floor: state.mined.vanityChars,
      antiPhish: 4,
      window: win,
    }).childNodes,
  );
  const badge = $('result-raindrop');
  if (badge) {
    badge.hidden = !win;
    badge.textContent = win ? `raindrop · ${win.label}` : '';
  }
  $('result-id').textContent = state.signed?.id ?? '';
  $('result-bits').textContent = `${state.mined.vanityBits} vanity + ${state.mined.declaredBits} nonce = ${state.mined.vanityBits + state.mined.declaredBits} bits (rung ${state.mined.targetBits})`;
  document.dispatchEvent(new CustomEvent('nhd:done', { detail: { event: state.signed, published: state.published } }));
}

function fail(message) {
  state.phase = 'error';
  state.error = message;
  setStatus('error', message);
}

function setStatus(kind, text, link = null) {
  const el = $('status-line');
  if (!el) return;
  el.replaceChildren(document.createTextNode(text));
  el.dataset.state = kind;
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.text;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    el.append(' ', a);
  }
}

// ── wiring ───────────────────────────────────────────────────────────────────

function initViz() {
  viz = createGrindViz($('grind'), { floor: PARAMS.vanityChars });
  viz.setStats({ target: PARAMS.base, elapsedMs: 0, tries: 0, keysPerSecond: 0, phase: 'idle' });
  state.progress.startedAt = Date.now();
}

function initForm() {
  $('rsvp-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit();
  });
  // ADDENDUM 2: the RSVP button is the gate — the ONLY thing that starts the grind.
  $('cta-mine')?.addEventListener('click', onRsvpPress);
  $('keep-key').addEventListener('click', () => winner?.postMessage({ type: 'export' }));
  $('download-key').addEventListener('click', () => {
    const nsec = $('nsec-out').value;
    if (!nsec) return;
    const blob = new Blob([`nostr hackday rsvp key\nnsec: ${nsec}\nnpub: ${state.mined?.npub}\n\n`], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nostrhackday-rsvp-key.txt';
    a.click();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  state.loadedAt = Date.now();
  initViz();
  initForm();
  setupCounter();
  // ADDENDUM 2: NO worker start at load any more. A page load is not an RSVP —
  // the grind (and therefore the auto-published proof) waits for the RSVP button.
  setStatus('idle', 'press RSVP to start mining your npub');

  if (SELFTEST) {
    // ADDENDUM 2: the gate applies to the selftest too, so it walks the visitor's
    // path exactly — it PRESSES the button rather than starting the grind itself.
    $('cta-mine')?.click();
    // Flow v2 order: the page publishes the unattended PROOF event by itself and
    // only then do we autofill + submit the details event, so the selftest walks
    // exactly the path a visitor walks.
    const autofill = () => {
      $('f-name').value = 'Selftest Bot';
      $('f-intent').value = 'build';
      $('f-consent').checked = true;
      setTimeout(() => submit(), 50);
    };
    document.addEventListener('nhd:proof', (e) => {
      if (e.detail?.ok) autofill();
    });
    // safety net: if the proof never lands (e.g. the rung cannot be read at all)
    // the details path still gets driven once the key exists
    document.addEventListener('nhd:ready', () => {
      setTimeout(() => {
        if (!state.proof?.event) autofill();
      }, 5000);
    });
  }
});

// ── QA surface ───────────────────────────────────────────────────────────────

window.__nhd = {
  get phase() { return state.phase; },
  /** ADDENDUM 2 — the intent gate: false until the RSVP button is pressed */
  get started() { return state.started; },
  get intent() { return state.intent; },
  /** drive the gate the way the button does (idempotent: a second call is a no-op) */
  start: () => {
    state.intent = true;
    return startMiningFromIntent();
  },
  pressRsvp: () => $('cta-mine')?.click() ?? false,
  get error() { return state.error; },
  get npub() { return state.mined?.npub ?? null; },
  get bits() { return state.mined ? state.mined.vanityBits + state.mined.declaredBits : null; },
  get targetBits() { return state.mined?.targetBits ?? null; },
  get vanityChars() { return state.mined?.vanityChars ?? null; },
  get accepted() { return state.accepted.length; },
  get rejected() { return state.rejected.length; },
  get nextRequiredBits() { return state.nextRequiredBits; },
  /** flow v2: the unattended proof event's state, and the details seat */
  get proof() { return state.proof; },
  get proofEvent() { return state.proof?.event ?? null; },
  get proofStatus() { return state.proof?.status ?? null; },
  get revealed() { return state.revealed; },
  get detailsPublished() { return state.detailsPublished; },
  get detailsTargetBits() { return detailsTargetBits(); },
  get signed() { return state.signed; },
  get published() { return state.published; },
  get relayEvents() { return state.relayEvents; },
  get eose() { return state.eose; },
  get filter() { return RSVP_FILTER; },
  get params() { return PARAMS; },
  get relays() { return RELAYS; },
  get selftest() { return SELFTEST; },
  get store() { return store; },
  get pool() { return pool; },
  get counterTopic() { return counterTopic; },
  /** re-read the store through the same reactive query the UI uses */
  snapshot: () => resolve(store.getByFilters(STORE_FILTER).filter(isHackdayEvent), PARAMS),
  get storeFilter() { return STORE_FILTER; },
  get relayFilter() { return RSVP_FILTER; },
  storeByKind: () => store.getByFilters({ kinds: [PARAMS.kind] }).length,
  submit,
  vanityInfo,
  secretKeyToNsec,
  buildTags,
};
