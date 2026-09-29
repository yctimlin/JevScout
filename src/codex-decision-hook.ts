import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decideFailureRelevance, decideTaskRoute, decideTestFailure, decisionAdvisory, failedTestNames,
  routeAdvisory, testFailureExcerpt, unrelatedFailureAdvisory } from './codex-decision.ts';

async function main() {
  const dir = process.env.JEVSCOUT_DECISION_STATE_DIR;
  if (!dir) return;
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw) as Record<string, any>;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (event.hook_event_name === 'UserPromptSubmit') {
    if (typeof event.prompt !== 'string') return;
    const task = event.prompt.slice(0, 1800);
    writeFileSync(join(dir, 'prompt.txt'), task, { mode: 0o600 });
    if (process.env.JEVSCOUT_DECISION_MODE === 'initial-route' && process.env.TYPESAFE_API_KEY) {
      const hash = createHash('sha256').update(task).digest('hex');
      const started = performance.now();
      try {
        const result = await decideTaskRoute(task, { key: process.env.TYPESAFE_API_KEY });
        const advisory = routeAdvisory(result);
        appendFileSync(join(dir, 'decisions.ndjson'), JSON.stringify({ hash, choice: result.choice,
          confidence: result.confidence, latencyMs: Math.round(performance.now() - started),
          usage: result.usage, advisory: Boolean(advisory) }) + '\n');
        if (advisory) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit', additionalContext: `JevScout task route: ${advisory}`,
        } }) + '\n');
      } catch (error) {
        appendFileSync(join(dir, 'decisions.ndjson'), JSON.stringify({ hash,
          error: error instanceof Error ? error.name : 'unknown', latencyMs: Math.round(performance.now() - started) }) + '\n');
      }
    }
    return;
  }
  if (process.env.JEVSCOUT_DECISION_MODE === 'initial-route') return;
  if (event.hook_event_name !== 'PostToolUse' || event.tool_name !== 'Bash') return;
  const command = event.tool_input?.command;
  const failure = testFailureExcerpt(command, event.tool_response);
  if (!failure) return;
  let task: string;
  try { task = readFileSync(join(dir, 'prompt.txt'), 'utf8'); } catch { return; }
  const hash = createHash('sha256').update(task).update(String(command)).update(failure).digest('hex');
  if (process.env.JEVSCOUT_DECISION_MODE === 'placebo') {
    appendFileSync(join(dir, 'decisions.ndjson'), JSON.stringify({ hash, placebo: true,
      latencyMs: 0, advisory: false }) + '\n');
    return;
  }
  if (!process.env.TYPESAFE_API_KEY) return;
  const started = performance.now();
  if (process.env.JEVSCOUT_DECISION_MODE === 'failure-relevance') {
    const failures = failedTestNames(failure);
    if (failures.length < 2) return;
    try {
      const result = await decideFailureRelevance(task, failures, { key: process.env.TYPESAFE_API_KEY });
      const advisory = unrelatedFailureAdvisory(result.scores);
      appendFileSync(join(dir, 'decisions.ndjson'), JSON.stringify({ hash, scores: result.scores,
        confidence: null, latencyMs: Math.round(performance.now() - started),
        usage: result.usage, advisory: Boolean(advisory) }) + '\n');
      if (advisory) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PostToolUse', additionalContext: `JevScout failure relevance: ${advisory}`,
      } }) + '\n');
    } catch (error) {
      appendFileSync(join(dir, 'decisions.ndjson'), JSON.stringify({ hash,
        error: error instanceof Error ? error.name : 'unknown', latencyMs: Math.round(performance.now() - started) }) + '\n');
    }
    return;
  }
  try {
    const result = await decideTestFailure({ task, command, failure }, { key: process.env.TYPESAFE_API_KEY });
    const advisory = decisionAdvisory(result);
    appendFileSync(join(dir, 'decisions.ndjson'), JSON.stringify({ hash, choice: result.choice,
      confidence: result.confidence, latencyMs: Math.round(performance.now() - started),
      usage: result.usage, advisory: Boolean(advisory) }) + '\n');
    if (advisory) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PostToolUse', additionalContext: `JevScout test-failure triage: ${advisory}`,
    } }) + '\n');
  } catch (error) {
    appendFileSync(join(dir, 'decisions.ndjson'), JSON.stringify({ hash,
      error: error instanceof Error ? error.name : 'unknown', latencyMs: Math.round(performance.now() - started) }) + '\n');
  }
}

await main().catch(() => {});
