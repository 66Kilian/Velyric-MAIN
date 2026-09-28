'use client';

import { curveMonotoneX } from '@visx/curve';
import { LinearGradient } from '@visx/gradient';
import { scaleLinear } from '@visx/scale';
import { AreaClosed, Bar, LinePath } from '@visx/shape';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import {
  useId,
  type HTMLAttributes,
  type ReactNode,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from 'react';
import { Card, cn } from './primitives.js';

export type ChartColor = 'pink' | 'violet' | 'magenta' | 'coral';

const CHART_COLORS: Readonly<Record<ChartColor, string>> = {
  pink: 'var(--pink)',
  violet: 'var(--violet)',
  magenta: 'var(--magenta)',
  coral: 'var(--coral)',
};

export interface SparklineProps {
  readonly values: readonly number[];
  readonly color?: ChartColor;
  readonly width?: number;
  readonly height?: number;
  readonly className?: string;
  readonly label?: string;
}

export function Sparkline({
  values,
  color = 'pink',
  width = 180,
  height = 44,
  className,
  label,
}: SparklineProps) {
  const gradientId = useId().replaceAll(':', '');
  const points =
    values.length === 0 ? [0, 0] : values.length === 1 ? [values[0] ?? 0, values[0] ?? 0] : values;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const x = scaleLinear<number>({ domain: [0, points.length - 1], range: [2, width - 2] });
  const y = scaleLinear<number>({
    domain: [min === max ? min - 1 : min, max === min ? max + 1 : max],
    range: [height - 3, 4],
  });
  const stroke = CHART_COLORS[color];
  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      className={cn('h-11 w-full', className)}
      preserveAspectRatio="none"
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    >
      <LinearGradient
        id={gradientId}
        from={stroke}
        to={stroke}
        fromOpacity={0.18}
        toOpacity={0}
        vertical
      />
      <AreaClosed<number>
        data={[...points]}
        x={(_, index) => x(index)}
        y={(value) => y(value)}
        yScale={y}
        curve={curveMonotoneX}
        fill={`url(#${gradientId})`}
      />
      <LinePath<number>
        data={[...points]}
        x={(_, index) => x(index)}
        y={(value) => y(value)}
        curve={curveMonotoneX}
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface KpiCardProps {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly suffix?: ReactNode;
  readonly delta?: number | null;
  readonly deltaLabel?: string;
  readonly trend?: readonly number[];
  readonly color?: ChartColor;
  readonly className?: string;
}

export function KpiCard({
  label,
  value,
  suffix,
  delta,
  deltaLabel,
  trend,
  color = 'pink',
  className,
}: KpiCardProps) {
  const positive = delta !== undefined && delta !== null && delta >= 0;
  return (
    <Card className={cn('flex flex-col gap-1 overflow-hidden px-5 pb-3 pt-5', className)}>
      <div className="flex items-baseline gap-0.5">
        <span className="text-[28px] font-[650] leading-[1.1] tracking-[-0.02em] text-text tabular-nums">
          {value}
        </span>
        {suffix === undefined ? null : (
          <span className="text-lg font-semibold text-text-muted">{suffix}</span>
        )}
      </div>
      <span className="text-sm text-text-muted">{label}</span>
      {delta === undefined || delta === null ? (
        <span className="h-6" />
      ) : (
        <span
          className={cn(
            'mt-1 inline-flex w-fit items-center gap-0.5 rounded-xs px-1.5 py-0.5 text-xs font-semibold',
            positive
              ? 'bg-[var(--tag-mint-bg)] text-success-text'
              : 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger-text',
          )}
          aria-label={deltaLabel}
        >
          {positive ? (
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          ) : (
            <ArrowDownRight className="h-3 w-3" aria-hidden="true" />
          )}
          {Math.abs(delta).toFixed(0)}%
        </span>
      )}
      {trend === undefined ? null : (
        <Sparkline values={trend} color={color} className="-mx-1 mt-1" />
      )}
    </Card>
  );
}

export interface BarSeriesPoint {
  readonly label: string;
  readonly value: number;
  readonly secondary?: number;
}

export function BarChart({
  data,
  height = 180,
  color = 'pink',
  secondaryColor = 'violet',
  formatLabel,
  className,
  ariaLabel,
}: {
  readonly data: readonly BarSeriesPoint[];
  readonly height?: number;
  readonly color?: ChartColor;
  readonly secondaryColor?: ChartColor;
  readonly formatLabel?: (label: string) => string;
  readonly className?: string;
  readonly ariaLabel: string;
}) {
  const width = Math.max(240, data.length * 28);
  const max = Math.max(1, ...data.map((point) => Math.max(point.value, point.secondary ?? 0)));
  const y = scaleLinear<number>({ domain: [0, max], range: [height - 22, 6] });
  const band = (width - 8) / Math.max(1, data.length);
  const barWidth = Math.max(4, Math.min(22, band * 0.56));
  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        className="w-full"
        style={{ minWidth: width / 2, height }}
        role="img"
        aria-label={ariaLabel}
      >
        {data.map((point, index) => {
          const left = 4 + index * band + (band - barWidth) / 2;
          const top = y(point.value);
          const secondaryTop = point.secondary === undefined ? null : y(point.secondary);
          return (
            <g key={`${point.label}-${String(index)}`}>
              <Bar
                x={left}
                y={top}
                width={barWidth}
                height={Math.max(0, height - 22 - top)}
                rx={4}
                fill={CHART_COLORS[color]}
                opacity={0.9}
              />
              {secondaryTop === null ? null : (
                <Bar
                  x={left + barWidth * 0.25}
                  y={secondaryTop}
                  width={barWidth * 0.5}
                  height={Math.max(0, height - 22 - secondaryTop)}
                  rx={3}
                  fill={CHART_COLORS[secondaryColor]}
                />
              )}
              {data.length <= 16 || index % Math.ceil(data.length / 12) === 0 ? (
                <text
                  x={left + barWidth / 2}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-[var(--text-muted)] text-[10px]"
                >
                  {formatLabel === undefined ? point.label : formatLabel(point.label)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function ProgressBar({
  value,
  max = 1,
  tone = 'pink',
  label,
}: {
  readonly value: number;
  readonly max?: number;
  readonly tone?: 'pink' | 'success' | 'warning' | 'danger';
  readonly label: string;
}) {
  const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const fill =
    tone === 'success'
      ? 'bg-success'
      : tone === 'warning'
        ? 'bg-warning'
        : tone === 'danger'
          ? 'bg-danger'
          : 'vly-gradient-cta';
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-300', fill)}
        style={{ width: `${String(ratio * 100)}%` }}
      />
    </div>
  );
}

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-left text-sm', className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('border-b border-border', className)} {...props} />;
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-border', className)} {...props} />;
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('transition-colors hover:bg-surface-muted/60', className)} {...props} />;
}

export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap px-4 py-2.5 text-xs font-medium uppercase tracking-[0.04em] text-text-muted',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-4 py-3 align-middle text-text', className)} {...props} />;
}

export function DescriptionList({
  items,
  className,
}: {
  readonly items: readonly { readonly term: ReactNode; readonly description: ReactNode }[];
  readonly className?: string;
}) {
  return (
    <dl
      className={cn('grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-6 gap-y-2.5 text-sm', className)}
    >
      {items.map((item, index) => (
        <div key={index} className="contents">
          <dt className="text-text-muted">{item.term}</dt>
          <dd className="min-w-0 break-words text-text">{item.description}</dd>
        </div>
      ))}
    </dl>
  );
}
