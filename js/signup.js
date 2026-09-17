/**
 * signup.js — Nostr Hackday RSVP page.
 *
 * Wallet-less, backend-less, build-step-less.
 *
 *  · Identity: an ephemeral key is mined in a Web Worker and never leaves the
 *    browser (it is released to the visitor only if they explicitly ask for it).
 *    If a NIP-07 extension is present AND its npub already clears the visible
 *    leet floor, the visitor may instead sign the identical mined template with
 *    that extension — mining itself is signer-agnostic and happens once either way.
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
  buildTags,
  describeRsvp,
  lowEntropyLabel,
  requiredBits,
  resolve,
  scanLowEntropyWindows,
  secretKeyToNsec,
  vanityInfo,
  verifyRsvp,
} from './pow-ratchet.js';
import { createGrindViz, renderNpub } from './viz.js';

// ── configuration ────────────────────────────────────────────────────────────

const qs = new URLSearchParams(location.search);
const SELFTEST = qs.get('selftest') === '1';
const DRY_RUN = SELFTEST && !qs.has('relays');

/** Locked ladder parameters, optionally switched to test scale for the QA path. */
const PARAMS = SELFTEST
  ? { ...DEFAULT_PARAMS, base: 5, cap: 8, vanityChars: 1 }
  : DEFAULT_PARAMS;

const RELAYS = qs.has('relays') ? qs.get('relays').split(',').filter(Boolean) : DRY_RUN ? [] : PARAMS.publishRelays;
/** What we ask relays for (relays index multi-letter tags, so this narrows on the wire). */
const RSVP_FILTER = { kinds: [PARAMS.kind], '#nhr': [PARAMS.eventTag] };
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
  progress: { vanityTries: 0, nonceTries: 0, keysPerSecond: 0, hashesPerSecond: 0, workers: {}, startedAt: Date.now() },
  accepted: [],
  rejected: [],
  nextRequiredBits: PARAMS.base,
  signed: null,
  published: [],
  relayEvents: 0,
  eose: false,
  nip07: null,
  useNip07: false,
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
    state.rejected = result.rejected;
    state.nextRequiredBits = result.nextRequiredBits;
    renderCounter(result, list.length);
    retarget(result.nextRequiredBits);
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
    setStatus('live', `live — watching ${RELAYS.length} relays`);
  }, 4000);

  pool
    .subscription(RELAYS, RSVP_FILTER, { reconnect: Infinity, resubscribe: true })
    .subscribe({
      next: (value) => {
        if (typeof value === 'string') return; // EOSE sentinel
        state.relayEvents += 1;
        if (!state.eose) {
          state.eose = true;
          setStatus('live', `live — ${state.relayEvents} event(s) from ${RELAYS.length} relays`);
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
    const worker = new Worker('./js/pow-worker.js', { type: 'module' });
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
            (msg.samples ?? []).forEach((s) => viz?.push(s));
          } else {
            state.progress.nonceTries += 1;
            state.progress.hashesPerSecond = msg.hashesPerSecond ?? 0;
            state.phase = 'mining-nonce';
          }
          renderMining();
          break;
        case 'mined':
          finished += 1;
          if (!winner) {
            winner = worker;
            state.mined = msg;
            state.phase = 'ready';
            viz.setFound({ npub: msg.npub, chars: msg.vanityChars, bits: msg.vanityBits, scan: msg.scan });
            viz.setState('key mined — submitting is instant', 'found');
            // the other workers are redundant now: the expensive half is done
            for (const w of workers) if (w !== worker) w.terminate();
            renderMining();
            document.dispatchEvent(new CustomEvent('nhd:ready', { detail: msg }));
          }
          break;
        case 'signed':
          onSigned(msg.event);
          break;
        case 'exported':
          $('nsec-out').value = `${msg.nsec ?? msg.secretKey}`;
          $('nsec-out').hidden = false;
          break;
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
 */
function retarget(nextRequiredBits) {
  if (!winner || nextRequiredBits === null) return;
  const current = state.mined?.targetBits ?? PARAMS.base;
  if (nextRequiredBits <= current) return;
  state.mined = { ...state.mined, targetBits: nextRequiredBits };
  winner.postMessage({ type: 'retarget', targetBits: nextRequiredBits });
  viz.setState(`rung moved to ${nextRequiredBits} bits — topping up nonce`, 'topup');
  setStatus('mining', `topping up proof of work to ${nextRequiredBits} bits`);
}

function renderMining() {
  const p = state.progress;
  const expected = 32 ** PARAMS.vanityChars;
  const pct = Math.min(99.9, (p.vanityTries / expected) * 100);
  viz?.setStats({
    tries: p.vanityTries,
    keysPerSecond: p.keysPerSecond,
    phase: state.phase === 'mining-nonce' ? 'nonce top-up' : 'vanity grind',
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
    name: val('f-name').slice(0, 80),
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
  if (state.phase === 'done') return 'Already submitted.';
  if (!state.mined) return 'Proof of work is still being mined — hang on a moment.';
  if ($('f-name').value.trim().length < 2) return 'Please give a name (2+ characters).';
  if ($('f-intent').value === '') return 'Please pick what you want to do at the hackday.';
  if (!$('f-consent').checked) return 'Please confirm the RSVP is published publicly to relays.';
  if (!SELFTEST) {
    if ($('hp-field').value.trim() !== '') return 'Rejected (spam trap).';
    if (Date.now() - state.loadedAt < MIN_DWELL_MS) return 'Please take a moment to read the page first.';
  }
  return null;
}

/**
 * NIP-07 path helper: ask the surviving worker to grind the nonce top-up for the
 * extension's pubkey and hand back the mined template (tags included).
 */
function mineForExtensionKey(content) {
  return new Promise((resolvePromise) => {
    if (!winner || !state.nip07) {
      fail('no mining worker is ready');
      resolvePromise(null);
      return;
    }
    const onMsg = (ev) => {
      const msg = ev.data ?? {};
      if (msg.type === 'mined' && msg.signer === 'nip07') {
        cleanup();
        resolvePromise(msg);
      } else if (msg.type === 'error' && msg.context?.type === 'mineForPubkey') {
        cleanup();
        fail(msg.message);
        resolvePromise(null);
      }
    };
    const cleanup = () => winner.removeEventListener('message', onMsg);
    winner.addEventListener('message', onMsg);
    winner.postMessage({
      type: 'mineForPubkey',
      pubkey: state.nip07.pubkey,
      targetBits: state.nextRequiredBits ?? PARAMS.base,
      content,
    });
  });
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

  if (state.useNip07 && state.nip07?.clears) {
    // Extension path: mine the nonce for THEIR pubkey, then let the extension
    // sign the identical template. Same mined id + tags, different signer.
    const mined = await mineForExtensionKey(content);
    if (!mined) return false;
    state.signed = null;
    const signed = await window.nostr.signEvent({
      kind: mined.template.kind,
      created_at: mined.template.created_at,
      tags: mined.tags,
      content: mined.template.content,
    });
    await onSigned(signed);
    return true;
  }

  winner.postMessage({ type: 'sign', content, targetBits: state.nextRequiredBits ?? PARAMS.base });
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
  store.add(event); // instant local update through the reactive query

  if (!RELAYS.length) {
    state.published = [{ from: 'dry-run', ok: true, message: 'no relays in this run' }];
    finish();
    return;
  }
  try {
    const results = await pool.publish(RELAYS, event);
    const list = Array.isArray(results) ? results : [results];
    state.published = list.map((r) => ({ from: r?.from ?? r?.url ?? 'relay', ok: !!r?.ok, message: r?.message ?? '' }));
  } catch (e) {
    state.published = [{ from: 'publish', ok: false, message: String(e?.message ?? e) }];
  }
  finish();
}

function finish() {
  state.phase = 'done';
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

function setStatus(kind, text) {
  const el = $('status-line');
  if (!el) return;
  el.textContent = text;
  el.dataset.state = kind;
}

// ── NIP-07 detection ─────────────────────────────────────────────────────────

async function detectNip07() {
  const note = $('nip07-note');
  if (!window.nostr?.getPublicKey) {
    note.textContent = 'No NIP-07 extension detected — your ephemeral browser key is used (it never leaves this tab).';
    return;
  }
  try {
    const pubkey = await window.nostr.getPublicKey();
    const info = vanityInfo(pubkey, PARAMS);
    const scan = scanLowEntropyWindows(info.npub, PARAMS);
    // both halves of the floor: the mined leet prefix AND the raindrop window
    const clears = info.chars >= PARAMS.vanityChars && scan.found;
    state.nip07 = { pubkey, npub: info.npub, chars: info.chars, clears, scan };
    const toggle = $('nip07-toggle');
    toggle.hidden = false;
    if (clears) {
      $('nip07-label').textContent = `Use my NIP-07 key (${info.npub.slice(0, 5 + info.chars)}… clears the floor)`;
      note.textContent = 'NIP-07 found: your extension key clears the visible floor and carries a raindrop, so you can sign with it.';
    } else {
      toggle.disabled = true;
      $('nip07-label').textContent = 'Use my NIP-07 key (unavailable)';
      const missing = scan.found
        ? `matches ${info.chars} of ${PARAMS.vanityChars} leet chars`
        : `has no ${PARAMS.windowSize}-char window with ≤${PARAMS.maxUnique} distinct chars`;
      note.textContent =
        `NIP-07 found, but its npub ${missing} — the floor is a verifiable property, so this RSVP would be ` +
        'rejected no matter who signs it. Your mined browser key will be used instead.';
    }
  } catch (e) {
    note.textContent = `NIP-07 present but refused getPublicKey (${e?.message ?? e}) — using your ephemeral browser key.`;
  }
}

// ── wiring ───────────────────────────────────────────────────────────────────

function initViz() {
  viz = createGrindViz($('grind'), { floor: PARAMS.vanityChars });
  viz.setStats({ target: PARAMS.base, elapsedMs: 0, tries: 0, keysPerSecond: 0, phase: 'vanity grind' });
  state.progress.startedAt = Date.now();
}

function initForm() {
  $('rsvp-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit();
  });
  $('nip07-toggle').addEventListener('change', (ev) => {
    state.useNip07 = ev.target.checked;
  });
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
  detectNip07();
  startWorkers();

  if (SELFTEST) {
    document.addEventListener('nhd:ready', () => {
      $('f-name').value = 'Selftest Bot';
      $('f-intent').value = 'build';
      $('f-consent').checked = true;
      setTimeout(() => submit(), 50);
    });
  }
});

// ── QA surface ───────────────────────────────────────────────────────────────

window.__nhd = {
  get phase() { return state.phase; },
  get error() { return state.error; },
  get npub() { return state.mined?.npub ?? null; },
  get bits() { return state.mined ? state.mined.vanityBits + state.mined.declaredBits : null; },
  get targetBits() { return state.mined?.targetBits ?? null; },
  get vanityChars() { return state.mined?.vanityChars ?? null; },
  get accepted() { return state.accepted.length; },
  get rejected() { return state.rejected.length; },
  get nextRequiredBits() { return state.nextRequiredBits; },
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
