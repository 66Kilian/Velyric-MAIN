'use client';

import { X } from 'lucide-react';
import {
  Checkbox as CheckboxPrimitive,
  Dialog as DialogPrimitive,
  DropdownMenu as DropdownPrimitive,
  Popover as PopoverPrimitive,
  Switch as SwitchPrimitive,
  Tabs as TabsPrimitive,
  Tooltip as TooltipPrimitive,
} from 'radix-ui';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { cn } from './primitives.js';

export const Tabs = TabsPrimitive.Root;

export function TabsList({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-border bg-surface-muted p-1',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex h-8 items-center rounded-sm px-3 text-[13px] font-medium text-text-muted transition-colors duration-150 hover:text-text data-[state=active]:bg-surface data-[state=active]:text-pink-text data-[state=active]:shadow-soft',
        className,
      )}
      {...props}
    />
  );
}

export const TabsContent = TabsPrimitive.Content;

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  title,
  description,
  closeLabel,
  size = 'md',
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly closeLabel: string;
  readonly size?: 'sm' | 'md' | 'lg';
}) {
  const width = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-3xl' : 'max-w-xl';
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[90dvh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-surface shadow-float focus:outline-none',
          width,
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div className="flex flex-col gap-1">
            <DialogPrimitive.Title className="text-lg font-semibold tracking-[-0.01em] text-text">
              {title}
            </DialogPrimitive.Title>
            {description === undefined ? null : (
              <DialogPrimitive.Description className="text-sm text-text-muted">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            className="rounded-sm p-1 text-text-muted hover:bg-pink-tint hover:text-text"
            aria-label={closeLabel}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        </div>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetContent({
  className,
  children,
  title,
  description,
  closeLabel,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly closeLabel: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-border bg-surface shadow-float focus:outline-none',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div className="flex flex-col gap-1">
            <DialogPrimitive.Title className="text-lg font-semibold text-text">
              {title}
            </DialogPrimitive.Title>
            {description === undefined ? null : (
              <DialogPrimitive.Description className="text-sm text-text-muted">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            className="rounded-sm p-1 text-text-muted hover:bg-pink-tint hover:text-text"
            aria-label={closeLabel}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;

export function DropdownMenuContent({
  className,
  align = 'end',
  ...props
}: ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        align={align}
        sideOffset={6}
        className={cn(
          'z-50 min-w-48 rounded-md border border-border bg-surface p-1 shadow-float',
          className,
        )}
        {...props}
      />
    </DropdownPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownPrimitive.Item>) {
  return (
    <DropdownPrimitive.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-2 text-sm text-text outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-pink-tint data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownPrimitive.Label>) {
  return (
    <DropdownPrimitive.Label
      className={cn('px-2.5 py-1.5 text-xs font-medium text-text-muted', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownPrimitive.Separator>) {
  return (
    <DropdownPrimitive.Separator className={cn('my-1 h-px bg-border', className)} {...props} />
  );
}

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={6}
        className={cn(
          'z-50 rounded-md border border-border bg-surface p-3 shadow-float',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export function Tooltip({
  content,
  children,
}: {
  readonly content: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={6}
            className="z-50 max-w-xs rounded-sm bg-text px-2 py-1 text-xs text-bg shadow-float"
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export function Switch({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border bg-surface-muted transition-colors duration-150 data-[state=checked]:border-transparent data-[state=checked]:bg-pink disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-surface shadow-soft transition-transform duration-150 data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  );
}

export function Checkbox({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border border-border bg-surface data-[state=checked]:border-pink data-[state=checked]:bg-pink',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <svg viewBox="0 0 12 12" className="h-3 w-3 text-on-accent" aria-hidden="true">
          <path
            d="M2.5 6.5 5 9l4.5-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  readonly id: number;
  readonly tone: ToastTone;
  readonly title: ReactNode;
  readonly description?: ReactNode;
}

interface ToastContextValue {
  readonly notify: (toast: Omit<ToastItem, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({
  children,
  closeLabel,
}: {
  readonly children: ReactNode;
  readonly closeLabel: string;
}) {
  const [items, setItems] = useState<readonly ToastItem[]>([]);
  const counter = useRef(0);
  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);
  const notify = useCallback(
    (toast: Omit<ToastItem, 'id'>) => {
      counter.current += 1;
      const id = counter.current;
      setItems((current) => [...current.slice(-3), { ...toast, id }]);
      window.setTimeout(
        () => {
          dismiss(id);
        },
        toast.tone === 'error' ? 8000 : 4500,
      );
    },
    [dismiss],
  );
  const value = useMemo(() => ({ notify }), [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
        aria-live="polite"
      >
        {items.map((item) => (
          <div
            key={item.id}
            role={item.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex items-start gap-3 rounded-md border bg-surface p-3 shadow-float',
              item.tone === 'error'
                ? 'border-danger/40'
                : item.tone === 'success'
                  ? 'border-success/40'
                  : 'border-border',
            )}
          >
            <span
              className={cn(
                'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                item.tone === 'error'
                  ? 'bg-danger'
                  : item.tone === 'success'
                    ? 'bg-success'
                    : 'bg-pink',
              )}
              aria-hidden="true"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="text-sm font-semibold text-text">{item.title}</p>
              {item.description === undefined ? null : (
                <p className="break-words text-[13px] text-text-muted">{item.description}</p>
              )}
            </div>
            <button
              type="button"
              className="rounded-xs p-0.5 text-text-muted hover:text-text"
              onClick={() => {
                dismiss(item.id);
              }}
              aria-label={closeLabel}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}
