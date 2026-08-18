// Whether two pieces of lesson code are the same lesson, since reindenting one
// does not make it another. Both the editor's answer match and the peer host's
// skip-the-security-review check compare on this rule.
export function normalizeLessonCode(source: string | null | undefined): string {
  if (typeof source !== 'string') return '';
  return source.replace(/\s+/g, ' ').trim();
}

/** True when both sides are the same lesson code, ignoring formatting. */
export function isSameLessonCode(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeLessonCode(a);
  return left.length > 0 && left === normalizeLessonCode(b);
}
