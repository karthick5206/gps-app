import type { AlertDto } from '@veetracer/shared';

/** Unread for the signed-in user (per-user read state from the API; acknowledged alerts are always read). */
export function isUnread(a: Pick<AlertDto, 'read' | 'status'>): boolean {
  return !a.read && a.status === 'NEW';
}

/** Marks `ids` (or every alert when `ids` is null) read; returns the same array when nothing changed. */
export function withRead<T extends Pick<AlertDto, 'id' | 'read'>>(list: T[], ids: ReadonlySet<string> | null): T[] {
  let changed = false;
  const next = list.map((a) => {
    if (a.read || (ids && !ids.has(a.id))) return a;
    changed = true;
    return { ...a, read: true };
  });
  return changed ? next : list;
}

/** Unread alerts among `list` (e.g. the bell's latest 20). */
export function unreadIds(list: Pick<AlertDto, 'id' | 'read' | 'status'>[]): string[] {
  return list.filter(isUnread).map((a) => a.id);
}
