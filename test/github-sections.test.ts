import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { selectGitHubSections } from '../src/github-sections.ts';

const query = 'webhook Retry-After 429';
const answer = 'Honor Retry-After on 429. The webhook retry loop now waits.';
const GAP = '\n\n[...]\n\n';

function charsOf(text: string): string[] {
  return Array.from(text);
}

function sliceChars(text: string, start: number, end: number): string {
  return charsOf(text).slice(start, end).join('');
}

describe('selectGitHubSections', () => {
  test('selects an answer section after 1,000 characters', () => {
    const filler = `Background only. ${'z'.repeat(1100)}`;
    const body = `${filler}\n\n## Fix\n${answer}`;
    assert.ok(charsOf(filler).length > 1000);
    const result = selectGitHubSections(body, query);
    assert.equal(result.complete, false);
    assert.ok(result.excerpt.includes(answer));
    assert.equal(result.excerpt.includes('z'.repeat(20)), false);
    assert.equal(result.spans.length, 1);
    assert.ok(result.spans[0].start >= 1000);
    assert.equal(sliceChars(body, result.spans[0].start, result.spans[0].end), result.excerpt);
    assert.equal(result.bodyChars, charsOf(body).length);
    assert.equal(result.shownChars, result.spans[0].end - result.spans[0].start);
    assert.ok(result.shownChars < result.bodyChars);
    assert.ok(charsOf(result.excerpt).length <= 1000);
  });

  test('falls back to the source prefix when no later section matches', () => {
    const body = `# Notes\n${'x'.repeat(1500)}\n\n## Other\nUnrelated changelog date.`;
    const result = selectGitHubSections(body, query);
    const expected = sliceChars(body, 0, 1000);
    assert.equal(result.excerpt, expected);
    assert.deepEqual(result.spans, [{ start: 0, end: 1000 }]);
    assert.equal(result.complete, false);
    assert.equal(result.shownChars, 1000);
    assert.equal(result.bodyChars, charsOf(body).length);
    assert.equal(result.excerpt.includes('Unrelated changelog'), false);
  });

  test('preserves exact span provenance and an explicit gap marker', () => {
    const intro = 'Retry-After must be honored for webhook 429s.';
    const filler = 'x'.repeat(1100);
    const body = `${intro}\n\n${filler}\n\n## Fix\n${answer}`;
    const result = selectGitHubSections(body, query);
    assert.equal(result.spans.length, 2);
    assert.ok(result.excerpt.includes(GAP));
    assert.ok(result.spans[0].end < result.spans[1].start);
    const rebuilt = result.spans.map(span => sliceChars(body, span.start, span.end)).join(GAP);
    assert.equal(result.excerpt, rebuilt);
    assert.equal(result.shownChars, result.spans.reduce((sum, span) => sum + span.end - span.start, 0));
    assert.equal(result.shownChars, charsOf(result.excerpt).length - charsOf(GAP).length);
    for (const span of result.spans) {
      assert.ok(span.start >= 0);
      assert.ok(span.end > span.start);
      assert.ok(span.end <= result.bodyChars);
      assert.equal(result.excerpt.includes(sliceChars(body, span.start, span.end)), true);
    }
    assert.ok(result.excerpt.includes(intro));
    assert.ok(result.excerpt.includes(answer));
    assert.equal(result.excerpt.includes('x'.repeat(20)), false);
    assert.equal(result.complete, false);
  });

  test('returns short and empty bodies unchanged and complete', () => {
    const short = 'Honor Retry-After on 429.';
    const shortResult = selectGitHubSections(short, query);
    assert.equal(shortResult.excerpt, short);
    assert.equal(shortResult.complete, true);
    assert.equal(shortResult.bodyChars, charsOf(short).length);
    assert.equal(shortResult.shownChars, shortResult.bodyChars);
    assert.deepEqual(shortResult.spans, [{ start: 0, end: shortResult.bodyChars }]);

    const empty = selectGitHubSections('', query);
    assert.equal(empty.excerpt, '');
    assert.equal(empty.complete, true);
    assert.equal(empty.bodyChars, 0);
    assert.equal(empty.shownChars, 0);
    assert.deepEqual(empty.spans, []);
  });

  test('counts Unicode surrogate pairs as single code points', () => {
    const emoji = '😀';
    assert.equal(emoji.length, 2);
    assert.equal(charsOf(emoji).length, 1);

    const laterBody = `${emoji.repeat(1200)}\n\n## Fix\nHonor Retry-After ${emoji} webhook 429.`;
    const later = selectGitHubSections(laterBody, query);
    assert.ok(later.excerpt.includes('Honor Retry-After'));
    assert.ok(later.spans[0].start >= 1000);
    assert.equal(sliceChars(laterBody, later.spans[0].start, later.spans[0].end), later.excerpt);
    assert.equal(charsOf(later.excerpt).join(''), later.excerpt);
    assert.equal(later.excerpt.includes('\uFFFD'), false);
    assert.equal(later.bodyChars, charsOf(laterBody).length);
    assert.ok(later.bodyChars < laterBody.length);

    const prefix = selectGitHubSections(emoji.repeat(1500), query);
    assert.equal(prefix.excerpt, emoji.repeat(1000));
    assert.equal(prefix.shownChars, 1000);
    assert.equal(charsOf(prefix.excerpt).length, 1000);
    assert.equal(prefix.excerpt.length, 2000);
    assert.equal(prefix.complete, false);
    assert.equal(prefix.excerpt.includes('\uFFFD'), false);
  });

  test('keeps lexical hits when a long later paragraph exceeds the output window', () => {
    const lead = `${'z'.repeat(1000)}\n\n`;
    const paraPrefix = 'q'.repeat(1200);
    const body = `${lead}${paraPrefix} ${answer}`;
    const paraStart = charsOf(lead).length;
    const hitAt = charsOf(`${lead}${paraPrefix} `).length;
    assert.ok(paraStart >= 1000);
    assert.ok(hitAt - paraStart > 1000);
    const result = selectGitHubSections(body, query);
    assert.equal(result.complete, false);
    assert.equal(result.spans.length, 1);
    assert.ok(result.spans[0].start >= paraStart);
    assert.ok(result.spans[0].start > paraStart);
    assert.ok(result.excerpt.includes('Honor Retry-After on 429'));
    assert.ok(result.excerpt.includes('webhook'));
    assert.equal(result.excerpt.startsWith('q'.repeat(1000)), false);
    assert.equal(sliceChars(body, result.spans[0].start, result.spans[0].end), result.excerpt);
    assert.ok(charsOf(result.excerpt).length <= 1000);
    assert.ok(result.shownChars <= 1000);
    assert.ok(result.shownChars < result.bodyChars);
  });

  test('caps excerpts at 1,000 characters and honors a smaller limit', () => {
    const long = `Intro notes.\n${'x'.repeat(2000)}`;
    const capped = selectGitHubSections(long, query);
    assert.equal(charsOf(capped.excerpt).length, 1000);
    assert.ok(charsOf(capped.excerpt).length <= 1000);
    assert.equal(capped.shownChars, 1000);
    assert.equal(capped.complete, false);
    assert.deepEqual(capped.spans, [{ start: 0, end: 1000 }]);

    const filler = `Background only. ${'z'.repeat(1100)}`;
    const body = `${filler}\n\n## Fix\n${answer}`;
    const small = selectGitHubSections(body, query, 40);
    assert.ok(charsOf(small.excerpt).length <= 40);
    assert.ok(small.shownChars <= 40);
    assert.ok(small.spans[0].start >= 1000);
    assert.equal(small.excerpt.includes('z'.repeat(20)), false);
    assert.ok(small.excerpt.includes('Retry-After') || small.excerpt.includes('429') || small.excerpt.includes('webhook'));
    assert.equal(small.complete, false);
  });
});
