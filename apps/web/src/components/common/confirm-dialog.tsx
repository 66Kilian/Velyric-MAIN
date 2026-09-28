'use client';

import { Button, Dialog, DialogContent, DialogTrigger } from '@velyric/ui';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

export interface ConfirmDialogProps {
  readonly trigger: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel: ReactNode;
  readonly destructive?: boolean;
  readonly children?: ReactNode;
  readonly confirmDisabled?: boolean;
  readonly onConfirm: () => unknown;
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  destructive = false,
  children,
  confirmDisabled = false,
  onConfirm,
}: ConfirmDialogProps) {
  const t = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setOpen(next);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        title={title}
        description={description}
        closeLabel={t('actions.close')}
        size="sm"
      >
        <div className="flex flex-col gap-5">
          {children ?? null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setOpen(false);
              }}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              type="button"
              variant={destructive ? 'danger' : 'primary'}
              disabled={pending || confirmDisabled}
              onClick={async () => {
                setPending(true);
                try {
                  const result = await onConfirm();
                  if (result !== false) {
                    setOpen(false);
                  }
                } finally {
                  setPending(false);
                }
              }}
            >
              {pending ? t('states.saving') : confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
