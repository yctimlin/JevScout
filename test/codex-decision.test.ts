import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideFailureRelevance, decideTaskRoute, decideTestFailure, decisionAdvisory, failedTestNames,
  routeAdvisory, testFailureExcerpt, unrelatedFailureAdvisory } from '../src/codex-decision.ts';

test('only recognized failing test output enters the decision path', () => {
  assert.equal(testFailureExcerpt('ls', 'FAILED test'), null);
  assert.equal(testFailureExcerpt('python -m pytest tests', '12 passed'), null);
  assert.ok(testFailureExcerpt('python -m pytest tests', 'AssertionError: expected new behavior'));
  assert.ok(testFailureExcerpt('npx vitest --run', 'Tests  2 failed | 49 passed'));
});

test('one structured Choice yields an advisory only above the confidence gate', async () => {
  let request: any;
  const fetcher = (async (_url: string, init: RequestInit) => {
    request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ answers: { next_action: {
      type: 'choice', choice: 'update_test_expectation', confidence: 0.93,
    } }, usage: { input_tokens: 101, output_tokens: 12 } }));
  }) as typeof fetch;
  const result = await decideTestFailure({ task: 'The new behavior hides locals.',
    command: 'python -m pytest tests', failure: "AssertionError: expected name = 'morty' in traceback" },
    { key: 'test', fetcher });
  assert.equal(request.questions.next_action.type, 'choice');
  assert.equal(request.state.task, 'The new behavior hides locals.');
  assert.ok(request.questions.next_action.criteria.undetermined);
  assert.equal(result.usage.inputTokens, 101);
  assert.ok(decisionAdvisory(result)?.includes('test expectations'));
  assert.equal(decisionAdvisory({ ...result, confidence: 0.79 }), null);
  assert.equal(decisionAdvisory({ ...result, choice: 'undetermined' }), null);
});

test('task routing uses a bounded Choice and fails open on uncertainty', async () => {
  let request: any;
  const fetcher = (async (_url: string, init: RequestInit) => {
    request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ answers: { route: {
      type: 'choice', choice: 'implementation_fix', confidence: 0.91,
    } }, usage: { input_tokens: 90, output_tokens: 10 } }));
  }) as typeof fetch;
  const result = await decideTaskRoute('Fix the empty query parameter bug.', { key: 'test', fetcher });
  assert.equal(request.questions.route.type, 'choice');
  assert.ok(request.questions.route.criteria.undetermined);
  assert.ok(routeAdvisory(result)?.includes('implementation'));
  assert.equal(routeAdvisory({ ...result, confidence: 0.4 }), null);
});

test('failure relevance requires all independent judgments to be clearly unrelated', async () => {
  const names = failedTestNames('FAILED tests/test_color.py::test_diff - AssertionError\nFAILED tests/test_schema.py::test_entrypoint - ValueError\n');
  assert.equal(names.length, 2);
  let request: any;
  const fetcher = (async (_url: string, init: RequestInit) => {
    request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ answers: {
      0: { type: 'noul', noul: 0.04 }, 1: { type: 'noul', noul: 0.06 },
    }, usage: { input_tokens: 120, output_tokens: 18 } }));
  }) as typeof fetch;
  const result = await decideFailureRelevance('Normalize t-string prefixes in preview mode.', names, { key: 'test', fetcher });
  assert.equal(Object.keys(request.questions).length, 2);
  assert.ok(unrelatedFailureAdvisory(result.scores)?.includes('unrelated'));
  assert.equal(unrelatedFailureAdvisory([0.04, 0.96]), null);
  assert.equal(unrelatedFailureAdvisory([0.3, 0.05]), null);
});
