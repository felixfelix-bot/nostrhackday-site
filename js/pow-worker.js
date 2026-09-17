/**
 * pow-worker.js — Web Worker that grinds the RSVP proof-of-work off the UI thread.
 *
 * Protocol (main → worker):
 *   {type:'grind', seed, workerIndex, params, targetBits}   start; mine vanity key + nonce top-up
 *   {type:'retarget', targetBits, workerIndex?}             ladder moved: top the nonce UP only
 *   {type:'sign', content, status}                          finish: (re-)mine nonce for the real
 *                                                           content, then sign with the worker-held key
 *   {type:'export'}                                         hand the ephemeral secret back (opt-in)
 *   {type:'stop'}                                           abandon all work
 *
 * Protocol (worker → main):
 *   {type:'progress', phase:'vanity'|'nonce', tries, elapsedMs, keysPerSecond, ...}
 *   {type:'mined', pubkey, npub, vanityChars, vanityBits, nonce, declaredBits, actualBits,
 *                  difficulty, targetBits, template, tries, elapsedMs}
 *   {type:'signed', event, signature}
 *   {type:'proof', event, nonce, declaredBits, actualBits, rung, content, tags, tries, elapsedMs}
 *   {type:'exported', secretKey, nsec}
 *   {type:'error', message, context}
 *
 * The ephemeral secret key never leaves this worker unless the visitor explicitly
 * asks for it: the main thread only ever receives the public npub and signed
 * events. Mining is signer-agnostic — the mined template (pubkey, created_at,
 * kind, tags incl. the NIP-13 nonce, content) is identical whichever signer
 * finishes the job; only the signature comes from the signer.
 */
import {
  DEFAULT_PARAMS,
  bytesToHex,
  buildEventTemplate,
  buildTags,
  mineNonce,
  mineProofEvent,
  mineVanityKey,
  randomSeed,
  scanLowEntropyWindows,
  secretKeyToNsec,
  signWithSecretKey,
  vanityInfo,
} from './pow-ratchet.js?v=c6338d4992';

const PLACEHOLDER_CONTENT = '{}';
/** how many keygens per progress tick — small enough to stay responsive */
const VANITY_BATCH = 32;
const NONCE_BATCH = 256;

const state = {
  gen: 0,
  params: DEFAULT_PARAMS,
  targetBits: DEFAULT_PARAMS.base,
  content: PLACEHOLDER_CONTENT,
  status: 'accepted',
  seed: null,
  workerIndex: 0,
  createdAt: Math.floor(Date.now() / 1000),
  key: null,
  top: null,
  template: null,
  startedAt: Date.now(),
  signer: 'ephemeral',
};

const post = (msg) => self.postMessage(msg);

function postProgress(evt, phase, gen) {
  if (gen !== state.gen) return;
  post({
    type: 'progress',
    phase,
    workerIndex: state.workerIndex,
    targetBits: state.targetBits,
    ...evt,
  });
}

function postMined(signer = state.signer) {
  const { key, top, template } = state;
  if (!key || !top) return;
  post({
    type: 'mined',
    signer,
    pubkey: key.pubkey,
    npub: key.npub,
    vanityChars: key.vanityChars,
    vanityBits: key.vanityBits,
    // the raindrop: scan returned with the key so the UI never re-scans
    scan: key.scan ?? scanLowEntropyWindows(key.npub, state.params),
    nonce: top.nonce,
    declaredBits: top.declaredBits,
    actualBits: top.actualBits,
    id: top.id,
    tags: top.tags,
    template,
    difficulty: key.vanityBits + top.declaredBits,
    targetBits: state.targetBits,
    tries: key.tries + top.tries,
    elapsedMs: Date.now() - state.startedAt,
  });
}

/** Vanity grind: the expensive, once-only half. Independent of the rung. */
async function mineKey(seed, workerIndex) {
  const mined = await mineVanityKey({
    seed,
    workerIndex,
    params: state.params,
    batch: VANITY_BATCH,
    onProgress: (p) => postProgress(p, 'vanity', state.gen),
    shouldStop: () => false,
  });
  if (!mined) throw new Error('vanity grind cancelled');
  return mined;
}

/** Nonce top-up for the current rung and content: the cheap, repeatable half. */
async function mineTop(content, targetBits, pubkey) {
  const key = state.key;
  if (!key) throw new Error('no mined key');
  const signerPubkey = pubkey ?? key.pubkey;
  const vanity = signerPubkey === key.pubkey ? key.vanityBits : vanityInfo(signerPubkey, state.params).bits;
  const needed = Math.max(0, targetBits - vanity);
  if (state.top && state.template && state.template.pubkey === signerPubkey
      && state.template.content === content && state.top.declaredBits >= needed) {
    return state.top; // already good enough — never re-grind downhill
  }
  const template = buildEventTemplate({
    pubkey: signerPubkey,
    content,
    params: state.params,
    status: state.status,
    createdAt: state.createdAt,
    tags: buildTags({ params: state.params, status: state.status }),
  });
  const top = await mineNonce({
    template,
    targetBits: needed,
    batch: NONCE_BATCH,
    onProgress: (p) => postProgress(p, 'nonce', state.gen),
    shouldStop: () => false,
  });
  if (!top) throw new Error('nonce grind cancelled');
  state.top = top;
  state.template = { ...template, tags: top.tags };
  return top;
}

function err(message, context = {}) {
  post({ type: 'error', message, context });
}

self.onmessage = async (ev) => {
  const msg = ev.data ?? {};
  try {
    switch (msg.type) {
      case 'grind': {
        state.gen += 1;
        const gen = state.gen;
        state.params = { ...DEFAULT_PARAMS, ...(msg.params ?? {}) };
        state.targetBits = Number.isFinite(msg.targetBits) ? msg.targetBits : state.params.base;
        state.content = msg.content ?? PLACEHOLDER_CONTENT;
        state.status = msg.status ?? 'accepted';
        state.seed = msg.seed ? new Uint8Array(msg.seed) : randomSeed();
        state.workerIndex = msg.workerIndex ?? 0;
        state.createdAt = Math.floor(Date.now() / 1000);
        state.key = null;
        state.top = null;
        state.template = null;
        state.startedAt = Date.now();
        state.signer = 'ephemeral';

        const key = await mineKey(state.seed, state.workerIndex);
        if (gen !== state.gen) return;
        state.key = key;
        await mineTop(state.content, state.targetBits);
        if (gen !== state.gen) return;
        postMined();
        break;
      }

      case 'retarget': {
        // The ladder can only move up for us: mining more never invalidates work,
        // and the page tells us the new required bits after each accepted RSVP.
        const next = Number.isFinite(msg.targetBits) ? msg.targetBits : state.targetBits;
        if (!state.key) { state.targetBits = next; return; }
        if (next <= state.targetBits) { postMined(); return; }
        state.targetBits = next;
        await mineTop(state.content, state.targetBits);
        postMined();
        break;
      }

      case 'proof': {
        // Flow v2: the unattended MINIMAL PROOF event. Same mined key and the
        // same rung top-up as a real RSVP, but the content is machine-generated
        // (bits / nonce / npub prefix) and carries nothing personal. The id —
        // hence the nonce bits we have to find — depends on the content and the
        // pubkey, so content, tags and id are ground together here rather than
        // reusing the placeholder top-up.
        if (!state.key) throw new Error('nothing mined yet');
        if (!state.key.secretKey) throw new Error('the proof event needs the mined key');
        const rung = Number.isFinite(msg.targetBits) ? msg.targetBits : state.targetBits;
        state.targetBits = rung;
        state.status = msg.status ?? 'accepted';
        const info = vanityInfo(state.key.pubkey, state.params);
        const proof = await mineProofEvent({
          pubkey: state.key.pubkey,
          secretKey: state.key.secretKey,
          params: state.params,
          targetBits: Math.max(0, rung - info.bits),
          npubPrefix: `npub1${info.matched}`,
          status: state.status,
          createdAt: state.createdAt,
          batch: NONCE_BATCH,
          onProgress: (p) => postProgress(p, 'proof', state.gen),
          shouldStop: () => false,
        });
        if (!proof) throw new Error('proof grind cancelled');
        post({
          type: 'proof',
          event: proof.event,
          id: proof.event.id,
          nonce: proof.nonce,
          declaredBits: proof.declaredBits,
          actualBits: proof.actualBits,
          rung,
          targetBits: rung,
          content: proof.content,
          tags: proof.tags,
          tries: proof.tries,
          elapsedMs: proof.elapsedMs,
        });
        break;
      }

      case 'sign': {
        if (!state.key) throw new Error('nothing mined yet');
        state.content = typeof msg.content === 'string' ? msg.content : state.content;
        state.status = msg.status ?? state.status;
        if (Number.isFinite(msg.targetBits)) state.targetBits = msg.targetBits;
        const top = await mineTop(state.content, state.targetBits);
        const signed = signWithSecretKey({ ...state.template, tags: top.tags }, state.key.secretKey);
        post({ type: 'signed', event: signed, signature: signed.sig });
        break;
      }

      case 'export': {
        if (!state.key?.secretKey) throw new Error('no ephemeral key to export');
        const hex = bytesToHex(state.key.secretKey);
        post({ type: 'exported', secretKey: hex, nsec: secretKeyToNsec(state.key.secretKey) });
        break;
      }

      case 'stop': {
        state.gen += 1;
        state.key = null;
        state.top = null;
        state.template = null;
        self.close();
        break;
      }

      default:
        err(`unknown message type: ${String(msg.type)}`, { msg });
    }
  } catch (e) {
    err(e instanceof Error ? e.message : String(e), { type: msg.type });
  }
};
