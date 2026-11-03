/**
 * Light variant of Workhub's web "Obsidian Orbit" design system (`src/styles/orbit.scss`
 * `.wh-orbit--light` in kobeumut/nextcloud_workhub): slate text on a near-white canvas, white
 * elevated cards, Nextcloud blue accent. Text colours keep ≥4.5:1 contrast on `bg`/`surface`;
 * colour never carries meaning alone (badges also carry text/icons).
 */
export const colors = {
  /** Cards, panes, inputs (web `--wh-surface`). */
  bg: '#ffffff',
  /** Page canvas behind cards (web `--wh-bg`). */
  surface: '#f8fafc',
  /** Hover / pressed / selected rows (web `--wh-elevated-hover`). */
  hover: '#f1f5f9',
  border: '#e2e8f0',
  borderStrong: '#cbd5e1',
  text: '#1e293b',
  textStrong: '#0f172a',
  muted: '#5b6b80', // 5.4:1 on #f8fafc
  faint: '#94a3b8', // decorative only (never body text)
  primary: '#0071b0', // Nextcloud blue, darkened for 5.3:1 text contrast on white
  primaryStrong: '#00679e',
  primarySoft: '#e0f0fa',
  primaryText: '#ffffff',
  danger: '#b3261e',
  dangerSoft: '#fdecea',
  ok: '#047857',
  okSoft: '#d1fae5',
  warning: '#92400e',
  warningSoft: '#fef3c7',
  violet: '#6d28d9',
  violetSoft: '#ede9fe',
  /** Side navigation (web Nextcloud app navigation). */
  nav: '#f1f5f9',
  bubbleMine: '#dcecf8',
  bubbleOther: '#f1f5f9',
};

/** Priority badge colours (web `PriorityBadge.vue`): text + soft background, always with a label. */
export const priorityColors: Record<string, { fg: string; bg: string }> = {
  urgent: { fg: '#b91c1c', bg: '#fee2e2' },
  high: { fg: '#9a3412', bg: '#ffedd5' },
  normal: { fg: '#1d4ed8', bg: '#dbeafe' },
  low: { fg: '#475569', bg: '#e2e8f0' },
};

export const radius = { sm: 6, md: 10, lg: 14 };
export const space = (n: number) => n * 4;
export const font = { small: 13, body: 15, title: 18, h1: 22 };

/** Card shadow (web `--wh-shadow` light): subtle elevation on iOS/web, `elevation` on Android. */
export const shadow = {
  shadowColor: '#0f172a',
  shadowOpacity: 0.06,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 2 },
  elevation: 1,
} as const;

/** Deck colours come as `rrggbb` without `#`; anything else falls back to the accent. */
export function hexColor(c: string | null | undefined, fallback = colors.primary): string {
  return c && /^[0-9a-f]{6}$/i.test(c) ? `#${c}` : c && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback;
}
