import { termsFor, type Candidate } from './retrieve.ts';

type SourceKind = 'source' | 'test' | 'docs' | 'bench' | 'types';

function sourceKind(file: string): SourceKind {
  if (/\.d\.[cm]?ts$/i.test(file)) return 'types';
  if (/(^|\/)(test|tests|__tests__|spec|specs)(\/|\.)|\.(test|spec)\.[^/]+$/i.test(file)) return 'test';
  if (/(^|\/)(bench|benchmark|benchmarks)(\/|$)/i.test(file)) return 'bench';
  if (/(^|\/)(docs?|documentation)(\/|$)|(^|\/)(readme|changelog)(\.|$)|\.(md|mdx)$/i.test(file)) return 'docs';
  return 'source';
}

function preferredKind(query: string): SourceKind {
  const lead = query.split(/[?!]|\.(?=\s)/)[0] ?? query;
  if (/\b(TypeScript types?|type declarations?|declaration files?|type signatures?)\b/i.test(lead)) return 'types';
  if (/\b(tests?|specs?|coverage)\b/i.test(lead)) return 'test';
  if (/\b(benchmarks?|performance measurement|latency measurements?)\b/i.test(lead)) return 'bench';
  if (/\b(docs?|documentation|readme|guide)\b/i.test(lead)) return 'docs';
  return 'source';
}

function namedForQuery(candidate: Candidate, query: string): boolean {
  const base = candidate.file.split('/').at(-1)?.replace(/\.[^.]+$/, '').toLowerCase() ?? '';
  if (!base || ['index', 'utils', 'types', 'constants'].includes(base)) return false;
  const stem = (word: string) => word.length > 5 && word.endsWith('ing') ? word.slice(0, -3)
    : word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word;
  return termsFor(query).some(word => stem(word) === stem(base));
}

function fitExcerpt(candidate: Candidate, fits: (item: Candidate) => boolean): Candidate | null {
  const matches = candidate.matchLines?.filter(line => line >= candidate.start && line <= candidate.end) ?? [];
  if (!matches.length) return null;
  const focus = matches.reduce((best, line) => {
    const nearby = (center: number) => matches.filter(match => Math.abs(match - center) <= 7).length;
    return nearby(line) >= nearby(best) ? line : best;
  }, matches[0]);
  const lines = candidate.text.split('\n');
  for (const radius of [16, 12, 8, 5, 3]) {
    const start = Math.max(candidate.start, focus - radius);
    const end = Math.min(candidate.end, focus + radius);
    const excerpt = { ...candidate, start, end, complete: false,
      text: lines.slice(start - candidate.start, end - candidate.start + 1).join('\n') };
    if (fits(excerpt)) return excerpt;
  }
  return null;
}

export function renderEvidence(candidate: Candidate): string {
  const scope = candidate.complete ? 'complete file' : `excerpt of ${candidate.fileLines ?? '?'} lines`;
  const numbered = candidate.text.split('\n').map((line, index) => `${candidate.start + index}|${line}`).join('\n');
  return `[${candidate.id}] ${candidate.file}:${candidate.start}-${candidate.end} (${scope})\n${numbered}\n`;
}

export function selectText(candidates: Candidate[], packId: string, mode: string, budget: number, notices: string[] = [], query = '', maxItemBytes = Infinity) {
  const selected: Candidate[] = [];
  const omitted: Candidate[] = [];
  const render = (items: Candidate[]) => [
    `JevScout ${mode}: ${items.length}/${candidates.length} excerpts`,
    ...notices,
    ...items.map(renderEvidence),
    ...(items.length < candidates.length ? [`Unshown references, if needed: jevscout list ${packId}`] : []),
    ...(items.some(item => !item.complete) ? [`Adjacent lines, if needed: jevscout open ${packId} <id>`] : []),
    '',
  ].join('\n');
  const minimum = Buffer.byteLength(render([]));
  if (minimum > budget) throw new Error(`Budget too small for search notices and recovery commands. Use at least ${minimum} bytes.`);
  const preferred = preferredKind(query);
  const firstByFile: Candidate[] = [];
  const repeated: Candidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.file)) repeated.push(candidate);
    else { seen.add(candidate.file); firstByFile.push(candidate); }
  }
  const primary = firstByFile.filter(candidate => sourceKind(candidate.file) === preferred);
  const bestRelevance = Math.max(...primary.map(candidate => candidate.relevance ?? 0));
  const named = (candidate: Candidate) => namedForQuery(candidate, query) &&
    (candidate.relevance === undefined || candidate.relevance >= Math.max(0.5, bestRelevance - 0.25));
  primary.sort((left, right) => Number(named(right)) - Number(named(left)) ||
    (right.relevance ?? 0) - (left.relevance ?? 0));
  const queryTerms = termsFor(query);
  if (primary.length > 2) {
    const firstTerms = new Set(queryTerms.filter(term => primary[0].text.toLowerCase().includes(term)));
    const rest = primary.slice(1).sort((left, right) => {
      const novel = (candidate: Candidate) => queryTerms.filter(term =>
        !firstTerms.has(term) && candidate.text.toLowerCase().includes(term)).length;
      return novel(right) - novel(left) || (right.relevance ?? 0) - (left.relevance ?? 0);
    });
    primary.splice(1, primary.length - 1, ...rest);
  }
  const companionKind = preferred === 'source' ? 'test' : 'source';
  const companion = firstByFile.filter(candidate => sourceKind(candidate.file) === companionKind);
  const others = firstByFile.filter(candidate => ![preferred, companionKind].includes(sourceKind(candidate.file)));
  const priorityFiles = new Set(primary.slice(0, 2).map(candidate => candidate.file));
  const priorityWindows = repeated.filter(candidate => priorityFiles.has(candidate.file));
  const remainingWindows = repeated.filter(candidate => !priorityFiles.has(candidate.file));
  const windowTerms = /\b(fail(?:s|ed|ure|ures|ing)?|errors?|exceptions?|partial)\b/i.test(query)
    ? [...queryTerms, 'catch', 'throw', 'abort', 'finally'] : queryTerms;
  const covered = new Set(queryTerms.filter(term =>
    [...primary.slice(0, 2), ...companion.slice(0, 1)].some(candidate => candidate.text.toLowerCase().includes(term))));
  const diverseWindows: Candidate[] = [];
  const pending = [...priorityWindows];
  while (pending.length) {
    let best = 0;
    let mostNew = -1;
    for (let index = 0; index < pending.length; index++) {
      const text = pending[index].text.toLowerCase();
      const newTerms = windowTerms.filter(term => !covered.has(term) && text.includes(term)).length;
      if (newTerms > mostNew) { best = index; mostNew = newTerms; }
    }
    const [candidate] = pending.splice(best, 1);
    diverseWindows.push(candidate);
    for (const term of windowTerms) if (candidate.text.toLowerCase().includes(term)) covered.add(term);
  }
  const ordered = query
    ? [...primary.slice(0, 2), ...diverseWindows, ...companion.slice(0, 1), ...primary.slice(2), ...companion.slice(1), ...others, ...remainingWindows]
    : [...firstByFile, ...repeated];
  for (const candidate of ordered) {
    const compact = Buffer.byteLength(renderEvidence(candidate)) > maxItemBytes
      ? fitExcerpt(candidate, item => Buffer.byteLength(renderEvidence(item)) <= maxItemBytes)
      : candidate;
    if (compact && Buffer.byteLength(render([...selected, compact])) <= budget) selected.push(compact);
    else {
      const excerpt = fitExcerpt(candidate, item => Buffer.byteLength(renderEvidence(item)) <= maxItemBytes &&
        Buffer.byteLength(render([...selected, item])) <= budget);
      if (excerpt) selected.push(excerpt);
      else omitted.push(candidate);
    }
  }
  const text = render(selected);
  const original = new Map(candidates.map(candidate => [candidate.id, candidate]));
  // A candidate shown as a narrowed excerpt did not fit, even though it is not omitted.
  const narrowed = selected.filter(item => {
    const source = original.get(item.id);
    return !source || item.start !== source.start || item.end !== source.end;
  }).length;
  return { selected, omitted, narrowed, text, outputBytes: Buffer.byteLength(text) };
}
