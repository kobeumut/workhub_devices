import { intlTag } from './core';

/** Clock time for today's timestamps, short date otherwise, in the active language. */
export function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(intlTag(), { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(intlTag(), { day: '2-digit', month: 'short' });
}

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(intlTag(), { day: '2-digit', month: 'short', year: 'numeric' });
}
