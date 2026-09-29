export type VerificationBranch = 'baseline' | 'focused' | null;

export function verificationBranch(scores: number[]): VerificationBranch {
  if (scores.length < 2) return null;
  if (scores.every(score => score <= 0.1)) return 'baseline';
  if (scores.some(score => score >= 0.8)) return 'focused';
  return null;
}

export function failureIds(names: string[]): string[] {
  return [...new Set(names.map(name => name.split(' - ')[0].trim()))].sort();
}

export function sameFailures(current: string[], baseline: string[]): boolean {
  const left = failureIds(current);
  const right = failureIds(baseline);
  return left.length > 0 && left.length === right.length && left.every((id, index) => id === right[index]);
}
