import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideFailureRelevance, failedTestNames, testFailureExcerpt } from './codex-decision.ts';
import { failureIds, sameFailures, verificationBranch } from './codex-verification.ts';

interface ActionConfig {
  full: string[];
  focused: string[];
  baselineDir: string;
  python: string;
}

function runPython(args: string[], cwd: string, python: string) {
  const run = spawnSync(python, args, { cwd, encoding: 'utf8', timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONPATH: cwd } });
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  return { status: run.status, failures: failedTestNames(output),
    error: run.error ? run.error.name : null };
}

async function main() {
  const dir = process.env.JEVSCOUT_DECISION_STATE_DIR;
  if (!dir) return;
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw) as Record<string, any>;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (event.hook_event_name === 'UserPromptSubmit') {
    if (typeof event.prompt === 'string') writeFileSync(join(dir, 'prompt.txt'), event.prompt.slice(0, 1800), { mode: 0o600 });
    return;
  }
  if (event.hook_event_name !== 'PostToolUse' || event.tool_name !== 'Bash') return;
  let config: ActionConfig;
  try { config = JSON.parse(process.env.JEVSCOUT_ACTION_CONFIG ?? ''); } catch { return; }
  if (!Array.isArray(config.full) || !Array.isArray(config.focused) ||
      typeof config.baselineDir !== 'string' || typeof config.python !== 'string') return;
  const command = event.tool_input?.command;
  if (command !== `python ${config.full.join(' ')}`) return;
  const failure = testFailureExcerpt(command, event.tool_response);
  if (!failure) return;
  const failures = failedTestNames(failure);
  if (failures.length < 2) return;
  let task: string;
  try { task = readFileSync(join(dir, 'prompt.txt'), 'utf8'); } catch { return; }
  const hash = createHash('sha256').update(task).update(command).update(failure).digest('hex');
  const mode = process.env.JEVSCOUT_ACTION_MODE;
  let branches: Array<'baseline' | 'focused'> = [];
  let scores: number[] | null = null;
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  const started = performance.now();
  if (mode === 'both') branches = ['baseline', 'focused'];
  else if (mode === 'jev') {
    if (!process.env.TYPESAFE_API_KEY) return;
    try {
      const decision = await decideFailureRelevance(task, failures, { key: process.env.TYPESAFE_API_KEY });
      scores = decision.scores;
      usage = decision.usage;
      const branch = verificationBranch(scores);
      if (branch) branches = [branch];
    } catch (error) {
      appendFileSync(join(dir, 'decisions.ndjson'), JSON.stringify({ hash,
        error: error instanceof Error ? error.name : 'unknown', latencyMs: Math.round(performance.now() - started) }) + '\n');
      return;
    }
  } else return;
  const actions = branches.map(branch => {
    if (branch === 'focused') return { branch, ...runPython(config.focused, event.cwd, config.python) };
    const currentRerun = runPython(config.full, event.cwd, config.python);
    const baseline = runPython(config.full, config.baselineDir, config.python);
    return { branch, ...baseline, currentRerun,
      sameAsCurrent: sameFailures(currentRerun.failures, baseline.failures),
      originalMatchesRerun: sameFailures(failures, currentRerun.failures) };
  });
  appendFileSync(join(dir, 'decisions.ndjson'), JSON.stringify({ hash, scores, usage,
    branches, actions, latencyMs: Math.round(performance.now() - started) }) + '\n');
  if (!actions.length) return;
  const report = actions.map(action => {
    if (action.branch === 'focused') return `focused check exited ${action.status ?? 'unknown'}; ` +
      `failures: ${failureIds(action.failures).slice(0, 10).join(', ') || 'none'}`;
    return `current recheck exited ${action.currentRerun.status ?? 'unknown'}; ` +
      `failures: ${failureIds(action.currentRerun.failures).slice(0, 10).join(', ') || 'none'}; ` +
      `baseline check exited ${action.status ?? 'unknown'}; ` +
      `failures: ${failureIds(action.failures).slice(0, 10).join(', ') || 'none'}; ` +
      `baseline/current recheck match: ${action.sameAsCurrent}; ` +
      `original/current recheck match: ${action.originalMatchesRerun}`;
  }).join('\n');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse',
    additionalContext: `JevScout ran verification after the failed suite:\n${report}\nThe original suite result remains failed.` } }) + '\n');
}

await main().catch(() => {});
