import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheRoot } from './pack.ts';

// A local record of what JevScout decided, so users can see it working. It holds sizes, reasons,
// timings and TypeSafe usage only: never source text, queries, prompts or keys.
export interface ActivityEvent {
  at: string;
  host: 'claude' | 'codex-proxy';
  tool: string;
  action: 'condensed' | 'passed';
  // Why a result passed through: inline, small, below-floor, no-key, low-confidence, provider, not-smaller, duplicate, error.
  reason?: string;
  inputBytes: number;
  outputBytes?: number;
  segments?: number;
  shown?: number;
  ms: number;
  typeSafe?: { calls: number; inputTokens: number; outputTokens: number; model?: string } | null;
  id?: string;
  // Claude Code saved only the start of the result, so the packet covers only that part.
  partial?: boolean;
}

const MAX_BYTES = 2_000_000;

export function activityPath(): string {
  return join(cacheRoot(), 'activity.jsonl');
}

// Never throws: recording activity must not affect a tool call. JEVSCOUT_ACTIVITY=off disables it.
export function recordActivity(event: Omit<ActivityEvent, 'at'>, env: NodeJS.ProcessEnv = process.env): void {
  if (env.JEVSCOUT_ACTIVITY === 'off') return;
  try {
    mkdirSync(cacheRoot(), { recursive: true, mode: 0o700 });
    const path = activityPath();
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
    // Keep the newest half once the log grows past its cap.
    if (statSync(path).size > MAX_BYTES) {
      const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
      writeFileSync(path, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', { mode: 0o600 });
    }
  } catch { /* activity is best effort */ }
}

export function readActivity(sinceMs = 0): ActivityEvent[] {
  let text: string;
  try { text = readFileSync(activityPath(), 'utf8'); } catch { return []; }
  const events: ActivityEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as ActivityEvent;
      if (Date.parse(event.at) >= sinceMs) events.push(event);
    } catch { /* skip a torn line */ }
  }
  return events;
}

export interface ActivitySummary {
  events: number;
  byHost: Record<string, { condensed: number; passed: number; reasons: Record<string, number> }>;
  condensedInputBytes: number;
  condensedOutputBytes: number;
  medianCondenseMs: number | null;
  typeSafe: { calls: number; inputTokens: number; outputTokens: number };
  models: string[];
  last: ActivityEvent | null;
}

export function summarizeActivity(events: ActivityEvent[]): ActivitySummary {
  const byHost: ActivitySummary['byHost'] = {};
  const typeSafe = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const models = new Set<string>();
  const times: number[] = [];
  let condensedInputBytes = 0, condensedOutputBytes = 0;
  let last: ActivityEvent | null = null;
  for (const event of events) {
    const host = byHost[event.host] ??= { condensed: 0, passed: 0, reasons: {} };
    if (event.action === 'condensed') {
      host.condensed++;
      condensedInputBytes += event.inputBytes;
      condensedOutputBytes += event.outputBytes ?? 0;
      times.push(event.ms);
      last = event;
    } else {
      host.passed++;
      const reason = event.reason ?? 'unknown';
      host.reasons[reason] = (host.reasons[reason] ?? 0) + 1;
    }
    if (event.typeSafe) {
      typeSafe.calls += event.typeSafe.calls;
      typeSafe.inputTokens += event.typeSafe.inputTokens;
      typeSafe.outputTokens += event.typeSafe.outputTokens;
      if (event.typeSafe.model) models.add(event.typeSafe.model);
    }
  }
  times.sort((a, b) => a - b);
  const medianCondenseMs = times.length ? times[Math.floor((times.length - 1) / 2)] : null;
  return { events: events.length, byHost, condensedInputBytes, condensedOutputBytes, medianCondenseMs, typeSafe, models: [...models].sort(), last };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(bytes >= 100_000 ? 0 : 1)} KB`;
  return `${bytes} B`;
}

const REASONS: Record<string, string> = {
  inline: 'inline (small enough for the agent to read directly)',
  small: 'under the size threshold',
  'below-floor': 'oversized but below the 100 KB floor',
  'no-key': 'no TYPESAFE_API_KEY',
  'low-confidence': 'Jev found no likely relevant part',
  provider: 'Jev unavailable (error or timeout)',
  'not-smaller': 'packet would not be smaller',
  'no-query': 'no request to rank against',
  duplicate: 'already handled by another JevScout hook (plugin and settings both installed)',
  error: 'unexpected error',
};

export function formatActivity(summary: ActivitySummary, days: number): string {
  const lines = [`JevScout activity, last ${days} day${days === 1 ? '' : 's'}`];
  if (!summary.events) {
    lines.push('', 'No activity recorded yet. JevScout records a line each time a Claude Code MCP result or Codex proxy result is checked.');
    return lines.join('\n') + '\n';
  }
  const names: Record<string, string> = { claude: 'Claude Code hook', 'codex-proxy': 'Codex MCP proxy' };
  for (const [host, stats] of Object.entries(summary.byHost)) {
    lines.push('', `${names[host] ?? host}: ${stats.condensed} condensed, ${stats.passed} passed through unchanged`);
    for (const [reason, count] of Object.entries(stats.reasons).sort((a, b) => b[1] - a[1])) lines.push(`  passed: ${count} × ${REASONS[reason] ?? reason}`);
  }
  if (summary.condensedInputBytes) {
    const saved = 1 - summary.condensedOutputBytes / summary.condensedInputBytes;
    lines.push('', `Condensed ${formatBytes(summary.condensedInputBytes)} of tool output into ${formatBytes(summary.condensedOutputBytes)} of packets (${Math.round(saved * 100)}% kept out of context).`);
  }
  if (summary.medianCondenseMs !== null) lines.push(`Median JevScout time when condensing: ${(summary.medianCondenseMs / 1000).toFixed(1)} s.`);
  if (summary.typeSafe.calls) lines.push(`TypeSafe usage: ${summary.typeSafe.calls} calls, ${summary.typeSafe.inputTokens.toLocaleString('en-US')} input and ${summary.typeSafe.outputTokens.toLocaleString('en-US')} output tokens${summary.models.length ? ` (${summary.models.join(', ')})` : ''}.`);
  if (summary.last) lines.push(`Last condensed: ${summary.last.at.replace('T', ' ').slice(0, 16)} UTC · ${summary.last.tool} · ${formatBytes(summary.last.inputBytes)} → ${formatBytes(summary.last.outputBytes ?? 0)}.`);
  return lines.join('\n') + '\n';
}
