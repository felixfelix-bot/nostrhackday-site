/**
 * rsvp-copy.test.mjs — the operator's copy/layout asks on the RSVP panel
 * (2026-09-17), asserted against the shipped source files.
 *
 * Every assertion here is a direct quote of an operator request:
 *
 *  1. "Please remove this text"      → the two .mine-lead paragraphs are gone
 *                                      (the mining explainer is not on the page).
 *  2. "change MINING YOUR NPUB →
 *      Mining your RSVP"              → the panel title, in markup AND in JS.
 *  3. "Please make this shorter"     → the 4-part legend collapses to one short
 *                                      line (no "verified by eye", no
 *                                      "same char, same colour everywhere").
 *  4. "Please give the user the nsec
 *      that corresponds to their npub
 *      once its mined"                → the winning key is exported and shown
 *                                      without any click: no button between the
 *                                      visitor and the nsec.
 *  5. "Put the progress bar just
 *      under this:" (the target strip) → #mine-bar sits between #target-strip
 *                                      and the fingerprint grid.
 *  6. "make the font easier to read" → npubs/target word are NOT rendered in the
 *                                      display face (Manusquared), panel prose is
 *                                      set in the readable sans stack, and the
 *                                      muted greys are lifted.
 *  7. "Don't ask for name, ask for nym" → the label, the payload key and the
 *                                      validation message all say nym.
 *
 * Run: node --test test/rsvp-copy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const indexHtml = read('index.html');
const signupJs = read('js/signup.js');
const powRatchetJs = read('js/pow-ratchet.js');
const vizJs = read('js/viz.js');
const signupCss = read('js/signup.css');
const checkScript = read('scripts/check-onepage.sh');

/** count non-overlapping occurrences of a literal */
const count = (haystack, needle) => haystack.split(needle).length - 1;

// ── 1. the mining explainer comes off the page ───────────────────────────────

test('the .mine-lead mining explainer is removed from index.html', () => {
  assert.equal(count(indexHtml, 'mine-lead'), 0, 'mine-lead blocks still present');
  assert.equal(count(indexHtml, 'From the moment you press RSVP'), 0);
  assert.equal(count(indexHtml, 'The moment the grind clears the current rung'), 0);
});

// ── 2. the panel title ───────────────────────────────────────────────────────

test('the panel invites before the click and narrates after it', () => {
  assert.equal(count(indexHtml, 'MINING YOUR NPUB'), 0, 'index.html still ships the caps title');
  assert.equal(count(vizJs, 'MINING YOUR NPUB'), 0, 'js/viz.js still ships the caps title');
  // served markup: the invitation — nothing has been mined yet
  assert.equal(
    count(indexHtml, '<span id="mine-title-text">Mine your RSVP</span>'),
    1,
    'the served title must invite the click',
  );
  assert.equal(
    count(indexHtml, 'Mining your RSVP'),
    0,
    'the running title must not be the served default — it appears only after the click',
  );
  assert.equal(
    count(vizJs, 'grind-title'),
    0,
    'the panel must print its title ONCE — the served h2, not the grind head',
  );
  // the two states live in ONE place (setPanelTitle in js/signup.js): the viz
  // takes the text it is handed, so there is a single source for the pair.
  assert.equal(
    count(checkScript, 'MINING YOUR NPUB'),
    0,
    'scripts/check-onepage.sh still asserts the old string',
  );
  assert.equal(count(checkScript, 'Mine your RSVP'), 1, 'check-onepage.sh must assert the served title');
});

test('the redundant SIGN UP button is gone', () => {
  assert.equal(count(indexHtml, 'SIGN UP'), 0, 'index.html still ships a SIGN UP button');
  assert.equal(count(indexHtml, 'footer-signup-link'), 0, 'the footer signup link is still there');
  assert.equal(count(checkScript, 'SIGN UP'), 0, 'check-onepage.sh still asserts SIGN UP');
  assert.ok(count(indexHtml, 'id="cta-mine"') >= 1, 'the real gate (the RSVP button) stays');
  const css = read('js/signup.css');
  assert.equal(count(css, 'footer-signup-link'), 0, 'js/signup.css still styles the signup link');
});

test('the click is what flips the panel title', () => {
  assert.ok(count(vizJs, 'setTitle') === 0, 'the viz module no longer owns the title');
  assert.ok(
    count(signupJs, 'setPanelTitle(true)') >= 1,
    'the RSVP press must flip the panel into the running title',
  );
  assert.ok(
    count(signupJs, "running ? 'Mining your RSVP' : 'Mine your RSVP'") >= 1,
    'both title states must live in one function',
  );
  assert.ok(
    count(signupJs, "'Mining your RSVP'") >= 1 && count(signupJs, "'Mine your RSVP'") >= 1,
    'the running and inviting titles must both be defined',
  );
});

// ── 3. the legend, shorter ───────────────────────────────────────────────────

test('the legend is one short line, not four long clauses', () => {
  const start = vizJs.indexOf('const legend = el(');
  assert.notEqual(start, -1, 'legend block not found in js/viz.js');
  const block = vizJs.slice(start, vizJs.indexOf('root.appendChild(legend)', start));

  assert.equal(count(block, 'verified by eye'), 0, 'legend still carries "verified by eye"');
  assert.equal(
    count(block, 'same char, same colour everywhere'),
    0,
    'legend still carries the grid-colour clause',
  );
  assert.ok(count(block, 'green = mined') > 0, 'legend must keep the green = mined swatch');
  assert.ok(count(block, 'orange = anti-phish') > 0, 'legend must keep the anti-phish swatch');

  // measure the text a visitor actually reads: the string literals in the block
  // with the swatch markup (and its title= tooltips) taken back out
  const visible = [...block.matchAll(/'([^']*)'|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2])
    .join(' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = visible.split(' ').filter(Boolean).length;
  assert.ok(words <= 20, `legend is too long: ${words} words — "${visible}"`);
  assert.ok(visible.length <= 110, `legend is too long: ${visible.length} chars — "${visible}"`);
});

test('the result npub caption is short too', () => {
  assert.equal(count(indexHtml, 'orange = anti-phish zone'), 0);
  assert.ok(count(indexHtml, 'your npub') > 0);
});

// ── 4. the nsec is handed over the moment the key is mined ───────────────────

test('the mined key is exported automatically — no click between visitor and nsec', () => {
  const exportCalls = signupJs.match(/postMessage\(\{\s*type:\s*'export'/g) ?? [];
  assert.ok(
    exportCalls.length >= 1,
    'nothing posts { type: "export" } — the nsec is never requested',
  );
  const first = signupJs.indexOf("state.phase = 'ready'");
  const exportIdx = signupJs.indexOf("postMessage({ type: 'export' })");
  assert.notEqual(exportIdx, -1, 'the auto-export call must be written literally');
  assert.ok(first !== -1 && exportIdx < first, 'auto-export must run on the mined path, before publishing');
  assert.ok(
    count(signupJs, 'setSecret(') >= 1,
    'the viz must be handed the nsec so it is shown next to the npub',
  );
});

test('the key panel opens by itself once the nsec exists', () => {
  const start = signupJs.indexOf("case 'exported':");
  assert.notEqual(start, -1, "no 'exported' handler in js/signup.js");
  const block = signupJs.slice(start, start + 700);
  assert.ok(count(block, 'nsec-out') >= 1, 'the exported nsec must land in #nsec-out');
  assert.ok(
    /key-panel'\)\.hidden = false|\$\('key-panel'\)\.hidden/.test(block),
    'the key panel must be un-hidden in the exported handler',
  );
});

test('viz exposes setSecret and renders it under the mined npub', () => {
  assert.ok(count(vizJs, 'function setSecret') >= 1, 'js/viz.js has no setSecret()');
  assert.ok(count(vizJs, 'grind-headline-nsec') >= 1, 'no nsec line in the grind headline');
  assert.ok(count(vizJs, 'setSecret,') >= 1, 'setSecret is not exported from the viz module');
});

// ── 5. the progress bar sits directly under the target strip ─────────────────

test('#mine-bar sits between the target strip and the fingerprint grid', () => {
  const strip = indexHtml.indexOf('id="target-strip"');
  const bar = indexHtml.indexOf('id="mine-bar"');
  const grid = indexHtml.indexOf('fingerprint-grid-host');
  assert.notEqual(strip, -1);
  assert.notEqual(bar, -1);
  assert.ok(strip < bar, 'the progress bar is above the target strip');
  assert.ok(grid === -1 || bar < grid, 'the progress bar must come before the fingerprint grid');
});

// ── 6. readability ───────────────────────────────────────────────────────────

test('npubs and the target word are not set in the display face', () => {
  const mono = signupCss.match(/--nhd-mono:\s*([^;]+);/);
  assert.ok(mono, '--nhd-mono is not defined in js/signup.css');
  assert.ok(
    !/^\s*'Manusquared'/.test(mono[1]),
    `--nhd-mono still starts with Manusquared: ${mono[1].trim()}`,
  );
  assert.ok(/ui-monospace|monospace/.test(mono[1]), 'a monospace fallback must remain');
});

test('panel prose is set in a readable face with lifted greys', () => {
  assert.ok(
    /--nhd-read:\s*[^;]*(-apple-system|system-ui|Segoe UI)/.test(signupCss),
    'js/signup.css defines no readable sans stack (--nhd-read)',
  );
  assert.ok(
    /\.signup-body\s*\{[^}]*font-family:\s*var\(--nhd-read\)/.test(signupCss),
    '.signup-body does not switch to the readable stack',
  );
  const muted = signupCss.match(/\.muted\s*\{\s*color:\s*(#[0-9a-fA-F]{6})/);
  assert.ok(muted, '.muted colour not found');
  const lum = parseInt(muted[1].slice(1, 3), 16);
  assert.ok(lum >= 0xa8, `.muted is still too dark: ${muted[1]}`);
});

// ── 7. nym, not name ─────────────────────────────────────────────────────────

test('the form asks for a nym, in the label, the payload and the message', () => {
  assert.equal(count(indexHtml, 'for="f-name">Name<'), 0, 'the label still reads "Name"');
  assert.ok(count(indexHtml, 'for="f-name">Nym<') === 1, 'label must read "Nym"');
  assert.ok(count(signupJs, "nym: val('f-name')") >= 1, 'the payload key must be nym');
  assert.ok(count(signupJs, 'Please give a nym') >= 1, 'the validation message must say nym');
  assert.ok(
    count(powRatchetJs, 'data.nym') >= 1,
    'describeRsvp must read the nym field (with a legacy name fallback)',
  );
});
