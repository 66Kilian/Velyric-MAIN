'use client';

import { useId } from 'react';
import { cn } from './primitives.js';

export function VelyricMark({
  className,
  title,
}: {
  readonly className?: string;
  readonly title?: string;
}) {
  const id = useId().replaceAll(':', '');
  return (
    <svg
      viewBox="0 0 64 56"
      className={cn('h-8 w-auto', className)}
      role={title === undefined ? undefined : 'img'}
      aria-label={title}
      aria-hidden={title === undefined ? true : undefined}
    >
      <defs>
        <linearGradient id={`${id}-main`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#E600FF" />
          <stop offset="0.55" stopColor="#D1005E" />
          <stop offset="1" stopColor="#FF1740" />
        </linearGradient>
        <linearGradient id={`${id}-wing`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#E0005F" />
          <stop offset="0.6" stopColor="#FF3D5E" />
          <stop offset="1" stopColor="#FF9A5C" />
        </linearGradient>
      </defs>
      <path
        d="M2 9.5c7.6-.9 14.6-.4 18.4 3.2 4.5 4.3 7.2 13.5 12.4 21.8 3.6 5.8 7.2 8.8 12.6 11.4-7.4 5-16.6 7.2-22.2 1.6C17.6 41.9 14.8 28.7 10.3 20.1 8 15.7 5.6 12.6 2 9.5Z"
        fill={`url(#${id}-main)`}
      />
      <path
        d="M31.3 26.8c4.9-8.1 11.6-15.7 21.6-16.7 3.4-.3 6.7.1 9.1.8-3.8 1.7-7 4.8-10 8.9-4.8 6.6-11.8 8.9-20.7 7Z"
        fill={`url(#${id}-wing)`}
      />
      <path
        d="M36.6 38.4c5.1-8.1 12-15.2 21.8-15.9 2.4-.2 4.5.1 5.6.4-3.4 1.8-6.1 4.8-8.8 8.7-4.6 6.7-11 8.7-18.6 6.8Z"
        fill={`url(#${id}-wing)`}
      />
    </svg>
  );
}

export function VelyricLogo({
  className,
  wordmarkClassName,
}: {
  readonly className?: string;
  readonly wordmarkClassName?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <VelyricMark className="h-7" />
      <span className={cn('text-[21px] font-bold tracking-[-0.03em] text-text', wordmarkClassName)}>
        Velyric
      </span>
    </span>
  );
}
