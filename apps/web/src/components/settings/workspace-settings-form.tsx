'use client';

import { Button, Field, Input, NativeSelect, useToast } from '@velyric/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import type { WorkspaceDetail } from '@/lib/types';

export function WorkspaceSettingsForm({
  workspace,
  timeZones,
  canUpdate,
}: {
  readonly workspace: WorkspaceDetail;
  readonly timeZones: readonly string[];
  readonly canUpdate: boolean;
}) {
  const t = useTranslations('settings.general');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [displayName, setDisplayName] = useState(workspace.display_name);
  const [locale, setLocale] = useState(workspace.default_locale);
  const [timezone, setTimezone] = useState(workspace.timezone);
  const [pending, setPending] = useState(false);
  const body = {
    ...(displayName.trim() !== workspace.display_name ? { display_name: displayName.trim() } : {}),
    ...(locale !== workspace.default_locale ? { default_locale: locale } : {}),
    ...(timezone !== workspace.timezone ? { timezone } : {}),
  };
  const dirty = Object.keys(body).length > 0;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        try {
          await api.patch(`/workspaces/${workspace.id}`, {
            workspace: workspace.id,
            ifMatch: workspace.version,
            body,
          });
          notify({ tone: 'success', title: t('saved') });
          router.refresh();
        } catch (error) {
          showError(error);
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field id="settings-display-name" label={t('displayName')} required>
          <Input
            id="settings-display-name"
            value={displayName}
            maxLength={120}
            disabled={!canUpdate}
            onChange={(event) => {
              setDisplayName(event.target.value);
            }}
          />
        </Field>
        <Field id="settings-legal-name" label={t('legalName')} hint={t('legalNameHint')}>
          <Input id="settings-legal-name" value={workspace.legal_name} disabled readOnly />
        </Field>
        <Field id="settings-locale" label={t('defaultLanguage')} hint={t('defaultLanguageHint')}>
          <NativeSelect
            id="settings-locale"
            value={locale}
            disabled={!canUpdate}
            onChange={(event) => {
              setLocale(event.target.value);
            }}
          >
            <option value="hu">Magyar</option>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </NativeSelect>
        </Field>
        <Field id="settings-timezone" label={t('timezone')} hint={t('timezoneHint')}>
          <NativeSelect
            id="settings-timezone"
            value={timezone}
            disabled={!canUpdate}
            onChange={(event) => {
              setTimezone(event.target.value);
            }}
          >
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {canUpdate ? (
        <div className="flex justify-end">
          <Button
            type="submit"
            loading={pending}
            disabled={pending || !dirty || displayName.trim() === ''}
          >
            {t('save')}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
