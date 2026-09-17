import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const js = readFileSync('js/signup.js', 'utf8');

test('the details form is locked until the proof is accepted', () => {
  assert.match(js, /state\.formUnlocked = ok > 0/);
  assert.match(js, /function lockDetailsForm\(\)/);
  assert.match(js, /if \(!state\.formUnlocked\) lockDetailsForm\(\)/);
});