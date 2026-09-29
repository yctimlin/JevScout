import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureIds, sameFailures, verificationBranch } from '../src/codex-verification.ts';
import { failedTestNames } from '../src/codex-decision.ts';

test('verification chooses an action only from decisive independent judgments', () => {
  assert.equal(verificationBranch([0.04, 0.06, 0.08]), 'baseline');
  assert.equal(verificationBranch([0.04, 0.91, 0.08]), 'focused');
  assert.equal(verificationBranch([0.04, 0.5, 0.08]), null);
  assert.equal(verificationBranch([0.04]), null);
});

test('baseline comparison uses complete test identities', () => {
  const current = ['tests/test_a.py::test_x - AssertionError', 'tests/test_b.py::test_y - ValueError'];
  assert.deepEqual(failureIds(current), ['tests/test_a.py::test_x', 'tests/test_b.py::test_y']);
  assert.equal(sameFailures(current, ['tests/test_b.py::test_y - RuntimeError', 'tests/test_a.py::test_x - assertion']), true);
  assert.equal(sameFailures(current, ['tests/test_a.py::test_x']), false);
  assert.equal(sameFailures(current, failedTestNames(`${current.map(name => `FAILED ${name}`).join('\n')}\n${'trailing diagnostics '.repeat(300)}`)), true);
});
