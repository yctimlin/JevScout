const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';

export const DECISIONS = ['update_test_expectation', 'fix_implementation', 'investigate_environment', 'undetermined'] as const;
export type TestDecision = typeof DECISIONS[number];
export const ROUTES = ['test_repair', 'implementation_fix', 'source_question', 'undetermined'] as const;
export type TaskRoute = typeof ROUTES[number];

export interface DecisionResult {
  choice: TestDecision;
  confidence: number;
  usage: { inputTokens: number; outputTokens: number };
}

export function testFailureExcerpt(command: unknown, response: unknown): string | null {
  if (typeof command !== 'string' || !/\b(?:pytest|vitest|jest|node\s+--test)\b/i.test(command)) return null;
  const output = typeof response === 'string' ? response : null;
  if (!output || !/(?:\bFAILED\b|\bAssertionError\b|\b[1-9]\d* failed\b|\bFAIL\s+\S|\u2716)/i.test(output)) return null;
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  return clean.slice(-4000);
}

export async function decideTestFailure(input: { task: string; command: string; failure: string }, options: {
  key: string; model?: string; timeoutMs?: number; fetcher?: typeof fetch;
}): Promise<DecisionResult> {
  const state = {
    task: input.task.slice(0, 1800),
    test: { command: input.command.slice(0, 500), failure: input.failure.slice(-4000) },
  };
  const response = await (options.fetcher ?? fetch)(TYPESAFE_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
    headers: { Authorization: `Bearer ${options.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: options.model ?? 'jev-1.13.0', state, questions: { next_action: {
      type: 'choice',
      instructions: 'Given state.task and state.test.failure, which next engineering action does this failed test support? Treat the stated intended behavior as authoritative. Classify this failure only; do not infer unseen code.',
      criteria: {
        update_test_expectation: 'The intended new behavior is already present and the assertion still expects superseded behavior. Update the test while retaining valid assertions.',
        fix_implementation: 'The assertion reflects the requested behavior and the implementation still produces the wrong result.',
        investigate_environment: 'Setup, dependency, command availability, or environment caused the failure rather than a behavior assertion.',
        undetermined: 'The supplied task and failure do not establish any of the other actions.',
      },
    } } }),
  });
  if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status}`);
  const data = await response.json() as Record<string, any>;
  const answer = data.answers?.next_action;
  if (answer?.type !== 'choice' || !DECISIONS.includes(answer.choice) ||
      !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 ||
      !Number.isSafeInteger(data.usage?.input_tokens) || !Number.isSafeInteger(data.usage?.output_tokens)) {
    throw new Error('Invalid TypeSafe decision response');
  }
  return { choice: answer.choice, confidence: answer.confidence,
    usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } };
}

export function decisionAdvisory(result: DecisionResult): string | null {
  if (result.confidence < 0.8) return null;
  switch (result.choice) {
    case 'update_test_expectation': return 'The failed assertion appears to expect superseded behavior. Check which test expectations need updating while retaining assertions that still hold.';
    case 'fix_implementation': return 'The failed assertion appears to match the requested behavior. Inspect the implementation before changing this test expectation.';
    case 'investigate_environment': return 'The failure appears related to test setup or environment. Check that cause before changing product behavior.';
    default: return null;
  }
}

export async function decideTaskRoute(task: string, options: {
  key: string; model?: string; timeoutMs?: number; fetcher?: typeof fetch;
}): Promise<{ choice: TaskRoute; confidence: number; usage: DecisionResult['usage'] }> {
  const response = await (options.fetcher ?? fetch)(TYPESAFE_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
    headers: { Authorization: `Bearer ${options.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: options.model ?? 'jev-1.13.0', state: { task: task.slice(0, 1800) },
      questions: { route: { type: 'choice',
        instructions: 'Which bounded work path does state.task require first? Classify the requested work, not a solution. If several paths are equally central, choose undetermined.',
        criteria: {
          test_repair: 'Update existing tests to match an intentional behavior change. Implementation changes are not requested.',
          implementation_fix: 'Change product implementation to fix a bug or add behavior, with tests as verification.',
          source_question: 'Answer questions from source code or history without changing product behavior.',
          undetermined: 'The task does not clearly fit one path, or multiple paths are equally central.',
        },
      } } }),
  });
  if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status}`);
  const data = await response.json() as Record<string, any>;
  const answer = data.answers?.route;
  if (answer?.type !== 'choice' || !ROUTES.includes(answer.choice) ||
      !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 ||
      !Number.isSafeInteger(data.usage?.input_tokens) || !Number.isSafeInteger(data.usage?.output_tokens)) {
    throw new Error('Invalid TypeSafe routing response');
  }
  return { choice: answer.choice, confidence: answer.confidence,
    usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } };
}

export function routeAdvisory(result: { choice: TaskRoute; confidence: number }): string | null {
  if (result.confidence < 0.8) return null;
  switch (result.choice) {
    case 'test_repair': return 'Start with the failing tests and the stated new behavior. Repair obsolete expectations while retaining assertions that still apply; follow any task limits on source edits.';
    case 'implementation_fix': return 'Start with the named implementation path and its existing tests. Make the behavior change, add focused regression coverage, then run the requested test command.';
    case 'source_question': return 'Trace the named behavior through its source and cite the relevant locations. Keep source unchanged unless the task explicitly asks for an edit.';
    default: return null;
  }
}

export function failedTestNames(output: string): string[] {
  return [...new Set([...output.matchAll(/^FAILED\s+([^\n]+)$/gm)].map(match => match[1].trim()))].slice(0, 10);
}

export async function decideFailureRelevance(task: string, failures: string[], options: {
  key: string; model?: string; timeoutMs?: number; fetcher?: typeof fetch;
}): Promise<{ scores: number[]; usage: DecisionResult['usage'] }> {
  if (failures.length < 2 || failures.length > 10) throw new Error('Expected 2-10 failed tests');
  const response = await (options.fetcher ?? fetch)(TYPESAFE_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
    headers: { Authorization: `Bearer ${options.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: options.model ?? 'jev-1.13.0',
      state: { task: task.slice(0, 1800), failures: failures.map(text => text.slice(0, 350)) },
      questions: Object.fromEntries(failures.map((_, index) => [String(index), {
        type: 'noul',
        instructions: `Does state.failures[${index}] directly test or expose the behavior requested by state.task? A related project or topic alone is insufficient. Decide only from the supplied state.`,
        criteria: { true: 'The failed assertion directly tests the requested behavior.',
          false: 'It tests another behavior or an environment condition.' },
      }])),
    }),
  });
  if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status}`);
  const data = await response.json() as Record<string, any>;
  const scores = failures.map((_, index) => {
    const answer = data.answers?.[index];
    if (answer?.type !== 'noul' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      throw new Error('Invalid TypeSafe relevance response');
    }
    return answer.noul as number;
  });
  if (!Number.isSafeInteger(data.usage?.input_tokens) || !Number.isSafeInteger(data.usage?.output_tokens)) {
    throw new Error('Invalid TypeSafe usage');
  }
  return { scores, usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } };
}

export function unrelatedFailureAdvisory(scores: number[]): string | null {
  return scores.length >= 2 && scores.every(score => score <= 0.1)
    ? 'The listed failures appear unrelated to the requested behavior. Verify the focused feature tests, preserve the original failure details, and avoid changing unrelated behavior solely to silence this suite.'
    : null;
}
