/** v1.15.1 (pure, `node --test`): suggest-as-you-type address search rules (debounce, minimum length, keyboard). */

export const ADDRESS_SEARCH = { debounceMs: 350, minChars: 3, maxHits: 6 } as const;

/** The query to send for the typed text, or null when it is too short (the trimmed text, collapsed spaces). */
export function addressQuery(text: string): string | null {
  const q = text.trim().replace(/\s+/g, ' ');
  return q.length >= ADDRESS_SEARCH.minChars ? q : null;
}

/** The highlighted option after an arrow key (wraps around; -1 when there are no options). */
export function nextActive(key: 'ArrowDown' | 'ArrowUp', current: number, count: number): number {
  if (count <= 0) return -1;
  if (key === 'ArrowDown') return current < 0 || current >= count - 1 ? 0 : current + 1;
  return current <= 0 ? count - 1 : current - 1;
}
