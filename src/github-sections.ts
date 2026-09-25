import { termsFor } from './retrieve.ts';

const DEFAULT_MAX_CHARS = 1000;
const GAP = '\n\n[...]\n\n';

export interface GitHubSectionSpan {
  start: number;
  end: number;
}

export interface GitHubSectionSelection {
  excerpt: string;
  spans: GitHubSectionSpan[];
  bodyChars: number;
  shownChars: number;
  complete: boolean;
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

function limitOf(maxChars: number | undefined): number {
  if (maxChars === undefined) return DEFAULT_MAX_CHARS;
  if (Number.isSafeInteger(maxChars) && maxChars > 0) return maxChars;
  return DEFAULT_MAX_CHARS;
}

function findHits(chars: string[], span: GitHubSectionSpan, terms: string[]): { start: number; end: number; term: string }[] {
  const hits: { start: number; end: number; term: string }[] = [];
  const slice = chars.slice(span.start, span.end);
  for (const term of terms) {
    const needle = codePoints(term);
    if (!needle.length || needle.length > slice.length) continue;
    for (let i = 0; i <= slice.length - needle.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (slice[i + j].toLowerCase() !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) hits.push({ start: span.start + i, end: span.start + i + needle.length, term });
    }
  }
  hits.sort((left, right) => left.start - right.start || left.end - right.end);
  return hits;
}

function bestCover(hits: { start: number; end: number; term: string }[], budget: number): GitHubSectionSpan | null {
  if (!hits.length || budget <= 0) return null;
  let bestTerms = -1;
  let bestCount = -1;
  let bestStart = -1;
  let cover = { start: hits[0].start, end: Math.min(hits[0].end, hits[0].start + budget) };
  let right = 0;
  for (let left = 0; left < hits.length; left++) {
    if (right < left) right = left;
    while (right + 1 < hits.length && hits[right + 1].end - hits[left].start <= budget) right++;
    const start = hits[left].start;
    const end = hits[left].end - start <= budget ? hits[right].end : start + budget;
    if (end - start > budget) continue;
    const cluster = hits.slice(left, right + 1).filter(hit => hit.end <= end);
    const terms = new Set(cluster.map(hit => hit.term)).size;
    const count = cluster.length;
    if (terms > bestTerms || terms === bestTerms && count > bestCount ||
      terms === bestTerms && count === bestCount && start >= bestStart) {
      bestTerms = terms;
      bestCount = count;
      bestStart = start;
      cover = { start, end };
    }
  }
  return cover;
}

function placeWindow(span: GitHubSectionSpan, cover: GitHubSectionSpan, budget: number): GitHubSectionSpan {
  let start = Math.max(span.start, Math.min(cover.start, span.end));
  let end = Math.max(start, Math.min(Math.max(cover.end, start), span.end));
  if (end - start > budget) end = start + budget;
  const extra = budget - (end - start);
  if (extra > 0) start -= Math.min(extra, start - span.start);
  end = Math.min(span.end, start + budget);
  start = Math.max(span.start, end - budget);
  return { start, end };
}

function clipSpan(chars: string[], span: GitHubSectionSpan, terms: string[], budget: number): GitHubSectionSpan {
  if (budget <= 0 || span.end <= span.start) return { start: span.start, end: span.start };
  if (span.end - span.start <= budget) return { start: span.start, end: span.end };
  const cover = bestCover(findHits(chars, span, terms), budget);
  if (!cover) return { start: span.start, end: span.start + budget };
  return placeWindow(span, cover, budget);
}

function lineContent(chars: string[], start: number, end: number): string {
  const stop = end > start && chars[end - 1] === '\n' ? end - 1 : end;
  return chars.slice(start, stop).join('');
}

function splitSections(chars: string[]): GitHubSectionSpan[] {
  const lines: GitHubSectionSpan[] = [];
  let start = 0;
  for (let i = 0; i <= chars.length; i++) {
    if (i === chars.length || chars[i] === '\n') {
      lines.push({ start, end: i === chars.length ? i : i + 1 });
      start = i + 1;
    }
  }
  const sections: GitHubSectionSpan[] = [];
  let secStart = -1;
  let secEnd = -1;
  const flush = () => {
    if (secStart >= 0 && secEnd > secStart) sections.push({ start: secStart, end: secEnd });
    secStart = -1;
    secEnd = -1;
  };
  for (const line of lines) {
    const text = lineContent(chars, line.start, line.end);
    if (text.trim() === '') {
      flush();
      continue;
    }
    if (/^#{1,6}([ \t]+|$)/.test(text)) flush();
    if (secStart < 0) secStart = line.start;
    secEnd = line.end;
  }
  flush();
  return sections;
}

function lexicalScore(text: string, terms: string[]): number {
  if (!terms.length) return 0;
  const lower = text.toLowerCase();
  return terms.filter(term => lower.includes(term)).length;
}

function selection(body: string, chars: string[], spans: GitHubSectionSpan[]): GitHubSectionSelection {
  const excerpt = spans.map(span => chars.slice(span.start, span.end).join('')).join(GAP);
  const shownChars = spans.reduce((sum, span) => sum + span.end - span.start, 0);
  const bodyChars = chars.length;
  return { excerpt, spans, bodyChars, shownChars, complete: shownChars === bodyChars && excerpt === body };
}

function chooseSpans(
  chars: string[],
  query: string,
  limit: number,
): GitHubSectionSpan[] {
  const terms = termsFor(query);
  const scored = splitSections(chars).map(span => ({
    ...span,
    score: lexicalScore(chars.slice(span.start, span.end).join(''), terms),
  }));
  const later = scored.filter(span => span.score > 0 && span.start >= DEFAULT_MAX_CHARS);
  if (!later.length) return [{ start: 0, end: limit }];
  later.sort((left, right) => right.score - left.score || left.start - right.start);
  const primary = later[0];
  const primaryClip = clipSpan(chars, primary, terms, limit);
  const rest = scored.filter(span => span.score > 0 && (span.start !== primary.start || span.end !== primary.end));
  rest.sort((left, right) => right.score - left.score || left.start - right.start);
  const secondary = rest.find(span => span.end <= primary.start || span.start >= primary.end);
  if (!secondary) return [primaryClip];
  const gapChars = codePoints(GAP).length;
  const remainder = limit - (primaryClip.end - primaryClip.start) - gapChars;
  if (remainder <= 0) return [primaryClip];
  const secondaryClip = clipSpan(chars, secondary, terms, remainder);
  if (secondaryClip.end <= secondaryClip.start) return [primaryClip];
  const spans = [primaryClip, secondaryClip].sort((left, right) => left.start - right.start);
  if (spans[1].start <= spans[0].end) return [{ start: spans[0].start, end: Math.max(spans[0].end, spans[1].end) }];
  return spans;
}

export function selectGitHubSections(body: string, query: string, maxChars?: number): GitHubSectionSelection {
  const chars = codePoints(body);
  const limit = limitOf(maxChars);
  if (chars.length <= limit) {
    return selection(body, chars, chars.length ? [{ start: 0, end: chars.length }] : []);
  }
  return selection(body, chars, chooseSpans(chars, query, limit));
}
