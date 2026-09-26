#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { search, termsFor } from './retrieve.ts';
import { rank } from './rank.ts';
import { expand, listPack, openEvidence, savePack, select } from './pack.ts';
import { renderEvidence, selectText } from './present.ts';
import { openGitHubIssue, searchGitHub } from './github.ts';
import { check, parseCheckInput, readBoundedInput } from './check.ts';
import { recoverOutput } from './condense.ts';
import { CLI_PATH, condenseStdin, execCondensed, hookSettings, installNotice, readStdin, runHook, settingsPath, updateSettings, withJevScout, withoutJevScout } from './hook.ts';
import { runProxy } from './mcp-proxy.ts';

const help = `JevScout — source evidence before it fills your context

jevscout search "task or question" [options]
jevscout expand <pack-id> <evidence-id>
jevscout open <pack-id> <evidence-id> [--before N] [--after N]
jevscout list <pack-id>
jevscout github search "task or question" --repo owner/name [options]
jevscout github open owner/name#123 [--budget-bytes N]
jevscout check [--format json] [--budget-bytes N] [--model NAME] [--timeout-ms N]
jevscout hook install | uninstall [--scope project|user] [--lexical-only] [--with-shell] [--dry-run]
jevscout hook settings [--with-shell]   (print the configuration instead of writing it)
jevscout mcp-proxy [--source NAME] -- MCP_SERVER_COMMAND [ARGS...]
jevscout condense --source NAME --query TEXT < large-output
jevscout exec --source NAME --query TEXT -- COMMAND [ARGS...]
jevscout output <id> [--segment N | --grep TEXT [--context N] | --all]

  --path DIR          Search root (default: current directory)
  --mode MODE         lexical | jev | auto (default: lexical)
  --terms WORDS       Comma-separated retrieval terms; otherwise derived from query
  --budget-bytes N    Total text output budget (default: 8000); JSON evidence budget
  --format FORMAT    text (default) | json (full diagnostics)
  --report FILE      Save full JSON diagnostics locally instead of loading them into context
  --version, -v      Print the installed package version
  --candidates N      Maximum candidate excerpts (default: 60; max: 120)
  --model NAME        TypeSafe model (default: jev-latest)
  --timeout-ms N      Total Jev ranking deadline (default: 8000)
  --before N          Lines before an evidence range for open (default: 30)
  --after N           Lines after an evidence range for open (default: 30)
  --repo OWNER/NAME    Public GitHub repository for github search
  --limit N            GitHub issue/PR candidate cap (default: 20; max: 30)
  --follow-links       Follow up to two explicit same-repository PR issue claims
  --evidence-sections  Select relevant verbatim sections from long GitHub bodies

Default output is compact source text. jev/auto may send source excerpts to api.typesafe.ai.
auto skips Jev when all evidence fits the budget or there is only one candidate.
github search fetches public issues/PRs before results enter agent context. github open fetches one full item.
check reads one JSON object from stdin and scores supplied spans without fetching sources.
Empty evidence leaves claims unresolved. Nonempty evidence requires TYPESAFE_API_KEY and fails closed on provider errors.
Failures retain lexical results. No automatic hooks or background services.
Requires rg and Node.js 24+. Set TYPESAFE_API_KEY for Jev.
`;

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Expected integer between ${min} and ${max}.`);
  return number;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, path: { type: 'string' }, mode: { type: 'string' }, terms: { type: 'string' },
    'budget-bytes': { type: 'string' }, candidates: { type: 'string' }, model: { type: 'string' }, 'timeout-ms': { type: 'string' },
    format: { type: 'string' }, report: { type: 'string' },
    before: { type: 'string' }, after: { type: 'string' },
    repo: { type: 'string' }, limit: { type: 'string' }, 'follow-links': { type: 'boolean' },
    'evidence-sections': { type: 'boolean' },
    source: { type: 'string' }, query: { type: 'string' }, segment: { type: 'string' }, grep: { type: 'string' },
    all: { type: 'boolean' }, context: { type: 'string' }, scope: { type: 'string' }, 'with-shell': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'lexical-only': { type: 'boolean' },
  } });
  if (values.version) {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(`${version}\n`);
    return;
  }
  if (values.help || !positionals.length) { console.log(help); return; }
  if (positionals[0] === 'hook' && positionals.length === 2) {
    const hookOptions = { shell: values['with-shell'], lexicalOnly: values['lexical-only'] };
    if (positionals[1] === 'settings') { process.stdout.write(JSON.stringify(hookSettings(CLI_PATH, hookOptions), null, 2) + '\n'); return; }
    if (positionals[1] === 'install' || positionals[1] === 'uninstall') {
      const scope = values.scope ?? 'project';
      if (scope !== 'project' && scope !== 'user') throw new Error('Scope must be project or user.');
      const result = updateSettings(settingsPath(scope), settings => positionals[1] === 'install'
        ? withJevScout(settings, CLI_PATH, hookOptions) : withoutJevScout(settings, CLI_PATH), values['dry-run']);
      if (values['dry-run']) process.stdout.write(JSON.stringify(result.settings, null, 2) + '\n');
      else process.stdout.write(`${positionals[1] === 'install' ? 'Installed JevScout hook in' : 'Removed JevScout hook from'} ${result.file}${result.backup ? ` (backup: ${result.backup})` : ''}\n`);
      if (positionals[1] === 'install') process.stdout.write('\n' + installNotice(hookOptions));
      return;
    }
    // Hook entry points fail open: any problem yields no output, which leaves the tool call unchanged.
    process.stdout.write(await runHook(positionals[1], readStdin()));
    return;
  }
  if (positionals[0] === 'exec' && positionals.length > 1) {
    process.exitCode = await execCondensed(positionals.slice(1), { source: values.source ?? 'command', query: values.query ?? '' });
    return;
  }
  if (positionals[0] === 'mcp-proxy' && positionals.length > 1) {
    process.exitCode = await runProxy(positionals.slice(1), { source: values.source });
    return;
  }
  if (positionals[0] === 'condense' && positionals.length === 1) {
    await condenseStdin({ source: values.source ?? 'stdin', query: values.query ?? '' });
    return;
  }
  if (positionals[0] === 'output' && positionals.length === 2) {
    process.stdout.write(recoverOutput(positionals[1], {
      segment: values.segment === undefined ? undefined : integer(values.segment, 0, 0, 100_000),
      grep: values.grep, all: values.all, context: integer(values.context, 2, 0, 50),
    }));
    return;
  }
  const format = values.format ?? 'text';
  if (!['text', 'json'].includes(format)) throw new Error('Format must be text or json.');
  if (positionals[0] === 'github' && positionals[1] === 'search' && positionals.length === 3) {
    if (!values.repo) throw new Error('GitHub search requires --repo owner/name.');
    const budgetBytes = integer(values['budget-bytes'], 5000, 256, 1_000_000);
    const limit = integer(values.limit, 20, 1, 30);
    const mode = values.mode ?? 'auto';
    if (!['auto', 'jev', 'github'].includes(mode)) throw new Error('GitHub mode must be auto, jev, or github.');
    const result = await searchGitHub({ repo: values.repo, query: positionals[2], limit, budgetBytes,
      mode: mode as 'auto' | 'jev' | 'github', typeSafeKey: process.env.TYPESAFE_API_KEY,
      followLinks: values['follow-links'],
      evidenceSections: values['evidence-sections'],
      model: values.model,
      timeoutMs: integer(values['timeout-ms'], 8000, 1, 60_000) });
    const output = format === 'json' ? JSON.stringify(result) + '\n' : result.text;
    if (values.report) writeFileSync(values.report, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    process.stdout.write(output);
    return;
  }
  if (positionals[0] === 'github' && positionals[1] === 'open' && positionals.length === 3) {
    const match = /^([^#]+)#([1-9][0-9]*)$/.exec(positionals[2]);
    if (!match) throw new Error('Use github open owner/name#123.');
    const number = Number(match[2]);
    const result = await openGitHubIssue(match[1], number,
      { timeoutMs: integer(values['timeout-ms'], 8000, 1, 60_000) });
    const output = format === 'json' ? JSON.stringify(result) + '\n' : [
      `${result.evidence.url} · ${result.evidence.title} · updated ${result.evidence.updatedAt}`,
      result.body,
      ...result.comments.map(comment => `\n${comment.author} · ${comment.createdAt}\n${comment.body}`),
      ...(result.commentsComplete ? [] : [`\n(partial comments: showing ${result.comments.length} of ${result.commentsTotal}; the rest are at ${result.evidence.url})`]),
      '',
    ].join('\n');
    const budgetBytes = integer(values['budget-bytes'], 8000, 256, 1_000_000);
    if (Buffer.byteLength(output) > budgetBytes) throw new Error('GitHub item exceeds output budget. Raise --budget-bytes to read the full item.');
    process.stdout.write(output);
    return;
  }
  if (positionals[0] === 'list' && positionals.length === 2) {
    const items = listPack(positionals[1]);
    console.log(format === 'json' ? JSON.stringify(items) : items.map(item => `[${item.id}] ${item.file}:${item.start}-${item.end}`).join('\n'));
    return;
  }
  if (positionals[0] === 'expand' && positionals.length === 3) {
    const item = expand(positionals[1], positionals[2]);
    process.stdout.write(format === 'json' ? JSON.stringify(item) + '\n' : renderEvidence(item)); return;
  }
  if (positionals[0] === 'open' && positionals.length === 3) {
    const before = integer(values.before, 30, 0, 500);
    const after = integer(values.after, 30, 0, 500);
    const item = openEvidence(positionals[1], positionals[2], before, after);
    const output = format === 'json' ? JSON.stringify(item) + '\n' : renderEvidence(item);
    const budget = integer(values['budget-bytes'], 8000, 256, 1_000_000);
    if (Buffer.byteLength(output) > budget) throw new Error('Expanded source exceeds output budget. Reduce --before/--after or raise --budget-bytes.');
    process.stdout.write(output);
    return;
  }
  if (positionals[0] === 'check' && positionals.length === 1) {
    const budgetBytes = integer(values['budget-bytes'], 8000, 256, 1_000_000);
    const timeoutMs = integer(values['timeout-ms'], 8000, 1, 60_000);
    const input = parseCheckInput(await readBoundedInput());
    const result = await check(input, {
      key: process.env.TYPESAFE_API_KEY, model: values.model, timeoutMs, budgetBytes,
    });
    const output = format === 'json' ? JSON.stringify(result) + '\n' : result.text;
    if (values.report) writeFileSync(values.report, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    process.stdout.write(output);
    return;
  }
  if (positionals[0] !== 'search' || positionals.length !== 2 || !positionals[1].trim()) throw new Error('Use search "query", check, or expand <pack-id> <evidence-id>.');
  const started = performance.now();
  const query = positionals[1];
  if (query.length > 2000) throw new Error('Query exceeds 2000 characters.');
  const root = realpathSync(values.path ?? process.cwd());
  const mode = values.mode ?? 'lexical';
  if (!['lexical', 'jev', 'auto'].includes(mode)) throw new Error('Mode must be lexical, jev, or auto.');
  const budget = integer(values['budget-bytes'], 8000, 256, 1_000_000);
  const limit = integer(values.candidates, 60, 1, 120);
  const timeoutMs = integer(values['timeout-ms'], 8000, 1, 60_000);
  const terms = values.terms ? [...new Set(values.terms.split(',').map(x => x.trim()).filter(Boolean))] : termsFor(query);
  if (terms.length > 12 || terms.some(term => term.length > 100)) throw new Error('Use at most 12 retrieval terms, at most 100 characters each.');
  const found = search(root, terms, limit);
  const searchMs = performance.now() - started;
  let candidates = found.candidates;
  let used = 'lexical';
  const maxItemBytes = candidates.length > 1 ? 2200 : Infinity;
  const preview = format === 'text'
    ? selectText(candidates, '00000000-0000-4000-8000-000000000000', 'lexical', budget, [], query, maxItemBytes)
    : null;
  const allFit = preview
    ? preview.omitted.length === 0 && preview.narrowed === 0
    : select(candidates, budget).omitted.length === 0;
  let reason = !candidates.length ? 'No lexical candidates; try different --terms or broaden --path.'
    : mode === 'auto' ? 'Single candidate or all evidence fits; Jev skipped.' : 'Lexical mode requested.';
  let usage: unknown = null;
  let model: string | null = null;
  const rankStarted = performance.now();
  if (candidates.length && (mode === 'jev' || mode === 'auto' && candidates.length > 1 && !allFit)) {
    if (!process.env.TYPESAFE_API_KEY) reason = 'No API key; lexical fallback.';
    else {
      try {
        const ranked = await rank(query, candidates, { key: process.env.TYPESAFE_API_KEY, model: values.model, timeoutMs });
        candidates = ranked.candidates; used = 'jev'; model = ranked.model;
        usage = { inputTokens: ranked.inputTokens, outputTokens: ranked.outputTokens, calls: ranked.calls };
        reason = 'Jev ranked candidates; no probability threshold removed evidence.';
      } catch {
        reason = 'Jev failed or timed out; lexical fallback. Partial API usage may have incurred charges and is not reported.';
      }
    }
  }
  const rankMs = performance.now() - rankStarted;
  const packId = savePack(root, candidates);
  const notices = [
    ...(found.capped ? ['Candidate limit reached; narrow terms/path or raise --candidates.'] : []),
    ...(reason.includes('fallback') ? ['Jev unavailable; lexical fallback. API usage may be incomplete.'] : []),
    ...(!candidates.length ? ['No lexical matches; broaden terms/path.'] : []),
  ];
  const textPack = format === 'text' ? selectText(candidates, packId, used, budget, notices, query, maxItemBytes) : null;
  const packed = textPack ? { ...textPack, evidenceBytes: textPack.outputBytes } : select(candidates, budget);
  const result = {
    version: 1, query, root, packId, requestedMode: mode, usedMode: used, reason, terms, model,
    evidence: packed.selected,
    warnings: [
      ...(found.capped ? ['Candidate limit reached. Narrow the search or raise --candidates.'] : []),
      ...(candidates.length && !packed.selected.length ? ['No whole excerpt fits the evidence budget. Increase --budget-bytes or expand an omitted reference.'] : []),
    ],
    omitted: packed.omitted.map(({ text, hash, ...ref }) => ref),
    expand: `jevscout expand ${packId} <evidence-id>`,
    limits: { candidateCapReached: found.capped, rgPrepassMatchesPerFile: 50, maxFileBytes: 262144,
      note: 'Files reaching the rg match cap are rescanned before window selection. Lexical retrieval can still miss synonyms and distant dependencies. Only shortlisted candidates can be expanded. Text mode budgets complete stdout; JSON mode budgets evidence records.' },
    metrics: { searchMs: Math.round(searchMs), rankMs: Math.round(rankMs), totalMs: Math.round(performance.now() - started),
      discovered: found.discovered, candidates: candidates.length, selected: packed.selected.length,
      rawSearchBytes: found.rawBytes, candidateTextBytes: candidates.reduce((sum, c) => sum + Buffer.byteLength(c.text), 0),
      evidenceBytes: packed.evidenceBytes, budgetBytes: budget, typeSafe: usage },
  };
  const output = textPack ? textPack.text : JSON.stringify(result) + '\n';
  if (values.report) writeFileSync(values.report, JSON.stringify({ ...result, outputBytes: Buffer.byteLength(output) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(output);
}

main().catch(error => {
  console.error(`JevScout: ${error instanceof Error ? error.message : 'Unknown error.'}`);
  process.exitCode = 1;
});
