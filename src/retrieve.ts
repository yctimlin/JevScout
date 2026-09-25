import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface Candidate {
  id: string;
  file: string;
  start: number;
  end: number;
  hash: string;
  text: string;
  lexical: number;
  relevance?: number;
  fileLines?: number;
  complete?: boolean;
  matchLines?: number[];
}

const stop = new Set('a an the is are be been do does did how why what when where which can could should would will to of for from with without and or in on at by this that it its my our find code implementation function file please explain implement fix if then else also there any all not no as than into about happens happen has have had gets get'.split(' '));
// A positive --glob overrides .gitignore. Type filters narrow files without doing so.
export const SEARCH_FILTERS = [
  '--no-require-git', '--type-add', 'scout:*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,kt,swift,c,cpp,h,hpp,cs,rb,php,md,mdx,sql,toml,yaml,yml,json}', '--type', 'scout',
  '--glob', '!**/node_modules/**', '--glob', '!**/dist/**', '--glob', '!**/vendor/**',
  '--glob', '!**/package-lock.json', '--glob', '!**/pnpm-lock.yaml', '--glob', '!**/yarn.lock', '--glob', '!**/Cargo.lock',
  '--glob', '!**/.env*', '--glob', '!**/credentials*', '--glob', '!**/secrets*',
];
const COMPLETE_FILE_BYTES = 3000;
const COMPLETE_FILE_LINES = 100;
export function termsFor(query: string): string[] {
  const identifiers = (query.match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? [])
    .filter(word => /[a-z][A-Z]/.test(word)).map(word => word.toLowerCase());
  const words = query.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
  return [...new Set([...identifiers, ...words.filter(word => !stop.has(word))])].slice(0, 12);
}

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function sourceAt(root: string, file: string): string {
  const base = realpathSync(root);
  const path = realpathSync(resolve(base, file));
  const rel = relative(base, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Source path must stay inside the repository.');
  }
  return readFileSync(path, 'utf8');
}

export function search(root: string, terms: string[], limit = 60): {
  candidates: Candidate[]; discovered: number; rawBytes: number; capped: boolean;
} {
  if (!terms.length) throw new Error('No searchable terms. Pass --terms with comma-separated symbols or words.');
  const args = ['--json', '--ignore-case', '--fixed-strings', '--max-count', '50', '--max-filesize', '256K', ...SEARCH_FILTERS];
  for (const term of terms) args.push('-e', term);
  args.push('--', '.');
  let raw: string;
  try {
    raw = execFileSync('rg', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; code?: string };
    if (failure.status === 1) return { candidates: [], discovered: 0, rawBytes: 0, capped: false };
    if (failure.code === 'ENOENT') throw new Error('ripgrep is required on PATH. Install rg and retry; a shell alias or function named rg is not enough.');
    throw new Error('Search failed or exceeded its 8 MiB output limit. Narrow --path or --terms.');
  }
  const hits = new Map<string, number[]>();
  for (const line of raw.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type !== 'match' || typeof event.data?.path?.text !== 'string') continue;
    const file = event.data.path.text.replace(/^\.\//, '');
    const lines = hits.get(file) ?? [];
    lines.push(event.data.line_number);
    hits.set(file, lines);
  }
  const candidates: Candidate[] = [];
  const lowerTerms = terms.map(term => term.toLowerCase());
  for (const [file, matches] of hits) {
    const content = sourceAt(root, file);
    const lines = content.split('\n');
    const hash = digest(content);
    const matchedLines = matches.length < 50 ? matches : lines.flatMap((line, index) => {
      const lower = line.toLowerCase();
      return lowerTerms.some(term => lower.includes(term)) ? [index + 1] : [];
    });
    if (Buffer.byteLength(content) <= COMPLETE_FILE_BYTES && lines.length <= COMPLETE_FILE_LINES) {
      const lexical = terms.filter(term => content.toLowerCase().includes(term.toLowerCase())).length;
      candidates.push({
        id: digest(`${file}:1:${lines.length}:${hash}`).slice(0, 16),
        file, start: 1, end: lines.length, hash, text: content, lexical,
        fileLines: lines.length, complete: true, matchLines: matchedLines,
      });
      continue;
    }
    const windows: { start: number; end: number }[] = [];
    for (const line of matchedLines.sort((a, b) => a - b)) {
      const start = Math.max(1, line - 4);
      const end = Math.min(lines.length, line + 8);
      const previous = windows.at(-1);
      if (previous && start <= previous.end - 3 && end - previous.start + 1 <= 40) previous.end = Math.max(previous.end, end);
      else windows.push({ start, end });
    }
    for (const window of windows) {
      const text = lines.slice(window.start - 1, window.end).join('\n');
      if (Buffer.byteLength(text) > 12_000) continue;
      const lower = text.toLowerCase();
      const lexical = terms.filter(term => lower.includes(term.toLowerCase())).length;
      candidates.push({ id: digest(`${file}:${window.start}:${window.end}:${hash}`).slice(0, 16), file, ...window, hash, text, lexical, fileLines: lines.length, complete: false,
        matchLines: matchedLines.filter(line => line >= window.start && line <= window.end) });
    }
  }
  candidates.sort((a, b) => b.lexical - a.lexical || a.file.localeCompare(b.file) || a.start - b.start);
  const byFile = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = byFile.get(candidate.file) ?? [];
    group.push(candidate);
    byFile.set(candidate.file, group);
  }
  const groups = [...byFile.values()];
  const shortlisted: Candidate[] = [];
  const breadth = Math.min(groups.length, limit - Math.min(8, Math.floor(limit / 5)));
  for (const group of groups.slice(0, breadth)) shortlisted.push(group[0]);
  for (const group of groups.slice(0, Math.min(breadth, 8))) {
    const covered = new Set(lowerTerms.filter(term => group[0].text.toLowerCase().includes(term)));
    const later = group.slice(1).map(candidate => ({ candidate, novel: lowerTerms.filter(term =>
      !covered.has(term) && candidate.text.toLowerCase().includes(term)).length }))
      .sort((left, right) => right.novel - left.novel || right.candidate.lexical - left.candidate.lexical)[0];
    if (later?.novel && shortlisted.length < limit) shortlisted.push(later.candidate);
  }
  for (const group of groups.slice(breadth)) {
    if (shortlisted.length === limit) break;
    shortlisted.push(group[0]);
  }
  const used = new Set(shortlisted.map(candidate => candidate.id));
  for (let depth = 1; shortlisted.length < limit; depth++) {
    let added = false;
    for (const group of groups) {
      const candidate = group[depth];
      if (!candidate || used.has(candidate.id)) continue;
      shortlisted.push(candidate);
      used.add(candidate.id);
      added = true;
      if (shortlisted.length === limit) break;
    }
    if (!added) break;
  }
  shortlisted.sort((a, b) => b.lexical - a.lexical || a.file.localeCompare(b.file) || a.start - b.start);
  return { candidates: shortlisted, discovered: candidates.length, rawBytes: Buffer.byteLength(raw), capped: candidates.length > limit };
}
