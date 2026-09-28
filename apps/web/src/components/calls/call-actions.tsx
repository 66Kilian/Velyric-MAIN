'use client';

import { Button, Field, Input, NativeSelect, Textarea, useToast } from '@velyric/ui';
import { PhoneForwarded, PhoneOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';

export interface TransferDestination {
  readonly label: string;
  readonly description: string;
}

export function CallActions({
  workspaceId,
  callId,
  canTransfer,
  canTerminate,
  destinations,
  warmTransferAvailable,
}: {
  readonly workspaceId: string;
  readonly callId: string;
  readonly canTransfer: boolean;
  readonly canTerminate: boolean;
  readonly destinations: readonly TransferDestination[];
  readonly warmTransferAvailable: boolean;
}) {
  const t = useTranslations('calls.actions');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [destination, setDestination] = useState(destinations[0]?.label ?? '');
  const [transferType, setTransferType] = useState<'COLD' | 'WARM'>('COLD');
  const [transferReason, setTransferReason] = useState('');
  const [terminateReason, setTerminateReason] = useState('');

  return (
    <div className="flex flex-wrap gap-2">
      {canTransfer ? (
        <ConfirmDialog
          trigger={
            <Button variant="secondary" size="sm">
              <PhoneForwarded className="h-4 w-4" aria-hidden="true" />
              {t('transfer')}
            </Button>
          }
          title={t('transferTitle')}
          description={t('transferDescription')}
          confirmLabel={t('transferConfirm')}
          confirmDisabled={
            !/^[a-z0-9_-]{2,40}$/.test(destination) || transferReason.trim().length < 3
          }
          onConfirm={async () => {
            try {
              await api.post(`/calls/${callId}/transfer`, {
                workspace: workspaceId,
                body: {
                  destination_label: destination,
                  transfer_type: transferType,
                  reason: transferReason.trim(),
                },
              });
              notify({ tone: 'success', title: t('transferStarted') });
              router.refresh();
              return true;
            } catch (error) {
              showError(error);
              return false;
            }
          }}
        >
          <div className="flex flex-col gap-4">
            <Field id="transfer-destination" label={t('destination')} required>
              {destinations.length > 0 ? (
                <NativeSelect
                  id="transfer-destination"
                  value={destination}
                  onChange={(event) => {
                    setDestination(event.target.value);
                  }}
                >
                  {destinations.map((entry) => (
                    <option key={entry.label} value={entry.label}>
                      {entry.description} ({entry.label})
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  id="transfer-destination"
                  value={destination}
                  onChange={(event) => {
                    setDestination(event.target.value.toLowerCase());
                  }}
                  pattern="[a-z0-9_-]{2,40}"
                />
              )}
            </Field>
            <Field id="transfer-type" label={t('transferType')}>
              <NativeSelect
                id="transfer-type"
                value={transferType}
                onChange={(event) => {
                  setTransferType(event.target.value === 'WARM' ? 'WARM' : 'COLD');
                }}
              >
                <option value="COLD">{t('cold')}</option>
                {warmTransferAvailable ? <option value="WARM">{t('warm')}</option> : null}
              </NativeSelect>
            </Field>
            <Field id="transfer-reason" label={t('reason')} required>
              <Textarea
                id="transfer-reason"
                value={transferReason}
                maxLength={300}
                onChange={(event) => {
                  setTransferReason(event.target.value);
                }}
              />
            </Field>
          </div>
        </ConfirmDialog>
      ) : null}
      {canTerminate ? (
        <ConfirmDialog
          trigger={
            <Button variant="danger" size="sm">
              <PhoneOff className="h-4 w-4" aria-hidden="true" />
              {t('terminate')}
            </Button>
          }
          title={t('terminateTitle')}
          description={t('terminateDescription')}
          confirmLabel={t('terminateConfirm')}
          destructive
          confirmDisabled={terminateReason.trim().length < 3}
          onConfirm={async () => {
            try {
              await api.post(`/calls/${callId}/terminate`, {
                workspace: workspaceId,
                body: { reason: terminateReason.trim() },
              });
              notify({ tone: 'success', title: t('terminated') });
              router.refresh();
              return true;
            } catch (error) {
              showError(error);
              return false;
            }
          }}
        >
          <Field id="terminate-reason" label={t('reason')} required>
            <Textarea
              id="terminate-reason"
              value={terminateReason}
              maxLength={300}
              onChange={(event) => {
                setTerminateReason(event.target.value);
              }}
            />
          </Field>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
