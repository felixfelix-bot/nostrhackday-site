/**
 * idle-and-cache.test.mjs — two operator observations of 2026-09-17:
 *
 *   "why does it say starting even though I haven't clicked on RSVP yet?"
 *   "why is the 2D grid back again?"
 *
 * The first is copy: nothing has started before the press, so nothing may say it
 * has. The second is caching: the servers hand out `max-age=3600` and every
 * local asset URL was unversioned, so a browser could keep hour-old modules —
 * the pulled grid included — and run them against the freshly served HTML. Every
 * local JS/CSS URL now carries a build token, and scripts/stamp-assets.sh keeps
 * them in step (with a --check mode for the release step).
 *
 * Run: node --test test/idle-and-cache.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const indexHtml = read('index.html');
const signupJs = read('js/signup.js');
const vizJs = read('js/viz.js');
const workerJs = read('js/pow-worker.js');
const notes = read('notes/rsvp-signup.md');

const count = (haystack, needle) => haystack.split(needle).length - 1;

// ── 1. nothing claims to have started before the press ──────────────────────

test('the idle panel does not say "starting"', () => {
  assert.equal(count(indexHtml, 'starting…'), 0, 'index.html ships a "starting…" idle label');
  assert.ok(
    /id="mine-label"[^>]*>nothing mined yet</.test(indexHtml),
    'the counter label must state the idle truth',
  );
  assert.equal(count(vizJs, "'starting…'"), 0, 'the grind head still greets with "starting…"');
  assert.ok(
    /el\('span', 'grind-state', 'idle'\)/.test(vizJs),
    'the grind head must greet with an idle state',
  );
});

test('the idle stats do not claim a phase either', () => {
  const start = signupJs.indexOf('function initViz()');
  const block = signupJs.slice(start, signupJs.indexOf('function initForm()', start));
  assert.ok(/phase: 'idle'/.test(block), 'the initial stats must report the idle phase');
  assert.equal(count(block, "'vanity grind'"), 0, 'the initial stats must not claim a running phase');
});

// ── 2. every local asset URL is versioned ───────────────────────────────────

const TOKEN = /^[A-Za-z0-9._-]+$/;

function tokensIn(src) {
  return [...src.matchAll(/\?v=([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
}

test('the served HTML references its assets with a build token', () => {
  const refs = [...indexHtml.matchAll(/(?:href|src)="((?:js\/|style)[^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 3, `expected at least 3 local asset refs, saw ${refs.length}`);
  for (const ref of refs) {
    assert.ok(/\?v=[A-Za-z0-9._-]+$/.test(ref), `unversioned asset reference: ${ref}`);
    assert.ok(TOKEN.test(ref.split('?v=')[1]), `bad build token in ${ref}`);
  }
});

test('the module graph is versioned too — imports are cached by URL', () => {
  for (const [file, src] of [['js/signup.js', signupJs], ['js/pow-worker.js', workerJs]]) {
    const local = [...src.matchAll(/from '(\.\/[^']+)'/g)].map((m) => m[1]);
    assert.ok(local.length >= 1, `${file} has no local imports to check`);
    for (const spec of local) {
      assert.ok(/\?v=[A-Za-z0-9._-]+$/.test(spec), `${file} imports ${spec} unversioned`);
    }
  }
  assert.ok(
    /new Worker\('\.\/js\/pow-worker\.js\?v=[A-Za-z0-9._-]+'/.test(signupJs),
    'the worker URL must carry the build token',
  );
});

test('one token for the whole build', () => {
  const all = [...tokensIn(indexHtml), ...tokensIn(signupJs), ...tokensIn(workerJs)];
  assert.ok(all.length >= 6, `expected the token on every asset, saw ${all.length}`);
  assert.equal(new Set(all).size, 1, `mixed build tokens: ${[...new Set(all)].join(', ')}`);
});

test('scripts/stamp-assets.sh exists, is executable and can check freshness', () => {
  const p = new URL('../scripts/stamp-assets.sh', import.meta.url);
  const src = readFileSync(p, 'utf8');
  assert.ok(src.startsWith('#!/usr/bin/env bash'), 'stamp-assets.sh must be a bash script');
  assert.ok(/--check/.test(src), 'it must support --check for the release step');
  assert.ok((statSync(p).mode & 0o111) !== 0, 'stamp-assets.sh must be executable');
  assert.ok(/stamp-assets\.sh/.test(notes), 'the release notes must document the release step');
});
