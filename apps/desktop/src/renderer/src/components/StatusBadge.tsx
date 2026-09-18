import type { ReactNode } from 'react';

export type Tone = 'success' | 'warning' | 'alert' | 'info' | 'neutral';

export function StatusBadge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}

