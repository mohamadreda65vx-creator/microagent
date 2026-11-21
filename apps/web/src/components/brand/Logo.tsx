import { useId } from 'react';
import clsx from 'clsx';

/**
 * MicroAgent mark: an "M" whose valley holds a glowing core.
 * The M reads as a person-shaped figure (shoulders + head) — an agent — and the rose dot is its "spark".
 */
export function LogoMark({ size = 40, className }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={`${id}-bg`} x1="6" y1="4" x2="42" y2="46" gradientUnits="userSpaceOnUse">
          <stop stopColor="#A3325A" />
          <stop offset="1" stopColor="#3E0F21" />
        </linearGradient>
        <radialGradient id={`${id}-glow`} cx="24" cy="15.5" r="9" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFD9E3" stopOpacity="0.55" />
          <stop offset="1" stopColor="#FFD9E3" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="48" height="48" rx="14" fill={`url(#${id}-bg)`} />
      <circle cx="24" cy="15.5" r="9" fill={`url(#${id}-glow)`} />
      <path d="M13 34V17L24 28L35 17V34" stroke="#fff" strokeWidth="3.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24" cy="15.5" r="3.2" fill="#FFD9E3" />
    </svg>
  );
}

export function Logo({ tone = 'dark', size = 36, className }: { tone?: 'dark' | 'light'; size?: number; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-2.5', className)}>
      <LogoMark size={size} />
      <span className={clsx('font-display text-[1.35rem] leading-none font-semibold tracking-tight', tone === 'light' ? 'text-white' : 'text-burgundy-950')}>
        Micro<span className={clsx('font-medium', tone === 'light' ? 'text-burgundy-200' : 'text-burgundy-600')}>Agent</span>
      </span>
    </span>
  );
}
