import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runAll } from './golden/scenarios.ts';

// Every TypeSafe request body, header, and caller-visible result must stay identical to the
// pre-refactor capture in golden/jev-golden.json.
test('TypeSafe requests and results match the golden capture', async () => {
  const expected = JSON.parse(readFileSync(new URL('./golden/jev-golden.json', import.meta.url), 'utf8'));
  const actual = JSON.parse(JSON.stringify(await runAll()));
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const name of Object.keys(expected)) assert.deepEqual(actual[name], expected[name], name);
});
