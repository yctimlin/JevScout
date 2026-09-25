import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, sourceAt, type Candidate } from './retrieve.ts';

export function select(candidates: Candidate[], budgetBytes: number) {
  const selected: Candidate[] = [];
  const omitted: Candidate[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    // Preserve whole excerpts. Never cut off a condition to hit a byte target.
    const size = Buffer.byteLength(JSON.stringify(candidate));
    if (bytes + size <= budgetBytes) { selected.push(candidate); bytes += size; }
    else omitted.push(candidate);
  }
  return { selected, omitted, evidenceBytes: bytes };
}

export function cacheRoot(): string {
  return process.env.JEVSCOUT_CACHE_DIR || join(homedir(), '.cache', 'jevscout');
}

export function savePack(root: string, candidates: Candidate[]): string {
  const id = randomUUID();
  mkdirSync(cacheRoot(), { recursive: true, mode: 0o700 });
  // Store references and hashes only; expansion always checks the current source.
  writeFileSync(join(cacheRoot(), `${id}.json`), JSON.stringify({ root: resolve(root), candidates: candidates.map(({ text, ...ref }) => ref) }), { mode: 0o600, flag: 'wx' });
  return id;
}

export function expand(packId: string, evidenceId: string): Candidate {
  return openEvidence(packId, evidenceId);
}

export function openEvidence(packId: string, evidenceId: string, before = 0, after = 0): Candidate {
  if (!/^[a-f0-9-]{36}$/.test(packId) || !/^[a-f0-9]{16}$/.test(evidenceId)) throw new Error('Invalid pack or evidence ID.');
  if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(after) || after < 0) throw new Error('Context lines must be nonnegative integers.');
  const stored = JSON.parse(readFileSync(join(cacheRoot(), `${packId}.json`), 'utf8'));
  const ref = stored.candidates.find((candidate: Candidate) => candidate.id === evidenceId);
  if (!ref) throw new Error('Evidence ID does not belong to this pack.');
  const content = sourceAt(stored.root, ref.file);
  if (digest(content) !== ref.hash) throw new Error('Source changed since this pack was created. Run search again.');
  const lines = content.split('\n');
  const start = Math.max(1, ref.start - before);
  const end = Math.min(lines.length, ref.end + after);
  return { ...ref, start, end, fileLines: lines.length, complete: start === 1 && end === lines.length,
    text: lines.slice(start - 1, end).join('\n') };
}

export function listPack(packId: string): Omit<Candidate, 'text'>[] {
  if (!/^[a-f0-9-]{36}$/.test(packId)) throw new Error('Invalid pack ID.');
  return JSON.parse(readFileSync(join(cacheRoot(), `${packId}.json`), 'utf8')).candidates;
}
