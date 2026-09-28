'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  Field,
  Input,
  NativeSelect,
  Textarea,
  useToast,
} from '@velyric/ui';
import { KeyRound, Link2, Unlink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useApiErrorToast, validationIssues } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import type { ConnectorType, CustomTool, Integration } from '@/lib/api/integrations';

const SIDE_EFFECTS = ['READ', 'WRITE', 'HIGH_RISK_WRITE', 'EXTERNAL_COMMUNICATION'] as const;
const CONFIRMATIONS = [
  'NONE',
  'CALLER_CONFIRMATION',
  'CALLER_CONFIRMATION_WITH_VERIFICATION',
  'HUMAN_APPROVAL',
] as const;
const SECRET_PATTERN = /^[\x21-\x7E]+$/;

export function ConnectButton({
  workspaceId,
  type,
  integration,
  label,
}: {
  readonly workspaceId: string;
  readonly type: ConnectorType;
  readonly integration: Integration | null;
  readonly label: string;
}) {
  const showError = useApiErrorToast();
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="sm"
      variant={integration === null ? 'primary' : 'secondary'}
      loading={pending}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const started = await api.post<{ authorization_url: string }>(
            '/integrations/oauth/authorizations',
            {
              workspace: workspaceId,
              body: {
                integration_type: type,
                ...(integration === null ? {} : { integration_id: integration.id }),
              },
            },
          );
          window.location.assign(started.authorization_url);
        } catch (error) {
          showError(error);
          setPending(false);
        }
      }}
    >
      <Link2 className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}

export function DisconnectButton({
  workspaceId,
  integration,
}: {
  readonly workspaceId: string;
  readonly integration: Integration;
}) {
  const t = useTranslations('integrations.connectors');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="ghost">
          <Unlink className="h-4 w-4" aria-hidden="true" />
          {t('disconnect')}
        </Button>
      }
      title={t('disconnectTitle')}
      description={t('disconnectDescription')}
      confirmLabel={t('disconnect')}
      destructive
      onConfirm={async () => {
        try {
          await api.post(`/integrations/${integration.id}/disconnect`, { workspace: workspaceId });
          notify({ tone: 'success', title: t('disconnected') });
          router.refresh();
          return true;
        } catch (error) {
          showError(error);
          return false;
        }
      }}
    />
  );
}

function jsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const createSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/, 'name'),
    description: z.string().min(10, 'description').max(1000, 'description'),
    http_method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    base_url: z
      .string()
      .min(10, 'base_url')
      .max(300, 'base_url')
      .regex(/^https:\/\//, 'base_url'),
    path_template: z.string().regex(/^\/[A-Za-z0-9._~{}/-]{0,300}$/, 'path_template'),
    input_schema: z.string().refine((value) => jsonObject(value) !== null, 'json'),
    output_schema: z.string().refine((value) => jsonObject(value) !== null, 'json'),
    side_effect_class: z.enum(SIDE_EFFECTS),
    confirmation_policy: z.enum(CONFIRMATIONS),
    idempotency_supported: z.boolean(),
    timeout_ms: z.number().int().min(500, 'timeout').max(10_000, 'timeout'),
    max_retries: z.number().int().min(0, 'retries').max(5, 'retries'),
    auth_type: z.enum(['NONE', 'BEARER', 'HMAC']),
    secret: z.string(),
  })
  .superRefine((value, context) => {
    if (
      value.auth_type === 'BEARER' &&
      (value.secret.length < 16 || value.secret.length > 4096 || !SECRET_PATTERN.test(value.secret))
    ) {
      context.addIssue({ code: 'custom', path: ['secret'], message: 'bearer_secret' });
    }
    if (
      value.auth_type === 'HMAC' &&
      (value.secret.length < 32 || value.secret.length > 512 || !SECRET_PATTERN.test(value.secret))
    ) {
      context.addIssue({ code: 'custom', path: ['secret'], message: 'hmac_secret' });
    }
  });

type CreateForm = z.infer<typeof createSchema>;

const DEFAULT_INPUT = JSON.stringify(
  {
    type: 'object',
    properties: { order_id: { type: 'string', minLength: 1 } },
    required: ['order_id'],
    additionalProperties: false,
  },
  null,
  2,
);
const DEFAULT_OUTPUT = JSON.stringify(
  { type: 'object', properties: { status: { type: 'string' } }, additionalProperties: true },
  null,
  2,
);

export function CustomToolForm({ workspaceId }: { readonly workspaceId: string }) {
  const t = useTranslations('integrations.tools.form');
  const te = useTranslations('enums');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [serverIssues, setServerIssues] = useState<readonly string[]>([]);
  const { register, handleSubmit, control, watch, formState, setError } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    mode: 'onBlur',
    defaultValues: {
      name: '',
      description: '',
      http_method: 'POST',
      base_url: 'https://',
      path_template: '/',
      input_schema: DEFAULT_INPUT,
      output_schema: DEFAULT_OUTPUT,
      side_effect_class: 'READ',
      confirmation_policy: 'NONE',
      idempotency_supported: false,
      timeout_ms: 4000,
      max_retries: 1,
      auth_type: 'BEARER',
      secret: '',
    },
  });
  const authType = watch('auth_type');
  const error = (field: keyof CreateForm) => {
    const message = formState.errors[field]?.message;
    return message === undefined
      ? undefined
      : t.has(`errors.${message}`)
        ? t(`errors.${message}`)
        : t('errors.invalid');
  };

  const submit = handleSubmit(async (values) => {
    setServerIssues([]);
    try {
      const created = await api.post<CustomTool>('/integrations/custom-tools', {
        workspace: workspaceId,
        body: {
          name: values.name,
          description: values.description.trim(),
          http_method: values.http_method,
          base_url: values.base_url.trim(),
          path_template: values.path_template,
          input_schema: jsonObject(values.input_schema),
          output_schema: jsonObject(values.output_schema),
          side_effect_class: values.side_effect_class,
          confirmation_policy: values.confirmation_policy,
          idempotency_supported: values.idempotency_supported,
          timeout_ms: values.timeout_ms,
          max_retries: values.max_retries,
          auth:
            values.auth_type === 'NONE'
              ? { type: 'NONE' }
              : { type: values.auth_type, secret: values.secret },
        },
      });
      notify({ tone: 'success', title: t('created', { name: created.name }) });
      router.push(`/app/${workspaceId}/integrations/custom-tools/${created.id}`);
    } catch (caught) {
      const issues = validationIssues(caught);
      for (const issue of issues) {
        const field = issue.path.replace(/^\/body\//, '').split('/')[0];
        if (field !== undefined && field in values) {
          setError(field as keyof CreateForm, { type: 'server', message: issue.rule });
        }
      }
      setServerIssues(
        issues.map((issue) => `${issue.path.replace(/^\/body\//, '')}: ${issue.rule}`),
      );
      showError(caught);
    }
  });

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {serverIssues.length > 0 ? (
        <div
          role="alert"
          className="rounded-md border border-danger/40 bg-surface px-4 py-3 text-sm text-danger-text"
        >
          <p className="font-semibold">{t('serverIssues')}</p>
          <ul className="mt-1 list-disc pl-5 font-mono text-xs">
            {serverIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Card>
        <CardContent className="grid gap-4 pt-5 md:grid-cols-2">
          <Field
            id="tool-name"
            label={t('name')}
            hint={t('nameHint')}
            required
            error={error('name')}
          >
            <Input id="tool-name" {...register('name')} autoComplete="off" spellCheck={false} />
          </Field>
          <Field id="tool-method" label={t('method')}>
            <NativeSelect id="tool-method" {...register('http_method')}>
              {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            id="tool-description"
            label={t('description')}
            hint={t('descriptionHint')}
            required
            error={error('description')}
            className="md:col-span-2"
          >
            <Textarea id="tool-description" rows={3} {...register('description')} />
          </Field>
          <Field
            id="tool-base-url"
            label={t('baseUrl')}
            hint={t('baseUrlHint')}
            required
            error={error('base_url')}
          >
            <Input
              id="tool-base-url"
              type="url"
              inputMode="url"
              {...register('base_url')}
              spellCheck={false}
            />
          </Field>
          <Field
            id="tool-path"
            label={t('path')}
            hint={t('pathHint')}
            required
            error={error('path_template')}
          >
            <Input id="tool-path" {...register('path_template')} spellCheck={false} />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="grid gap-4 pt-5 md:grid-cols-2">
          <Field
            id="tool-input-schema"
            label={t('inputSchema')}
            hint={t('schemaHint')}
            error={error('input_schema')}
          >
            <Textarea
              id="tool-input-schema"
              rows={10}
              className="font-mono text-xs"
              spellCheck={false}
              {...register('input_schema')}
            />
          </Field>
          <Field
            id="tool-output-schema"
            label={t('outputSchema')}
            hint={t('schemaHint')}
            error={error('output_schema')}
          >
            <Textarea
              id="tool-output-schema"
              rows={10}
              className="font-mono text-xs"
              spellCheck={false}
              {...register('output_schema')}
            />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="grid gap-4 pt-5 md:grid-cols-2">
          <Field id="tool-side-effect" label={t('sideEffect')} hint={t('sideEffectHint')}>
            <NativeSelect id="tool-side-effect" {...register('side_effect_class')}>
              {SIDE_EFFECTS.map((value) => (
                <option key={value} value={value}>
                  {te(`toolSideEffectClass.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field
            id="tool-confirmation"
            label={t('confirmation')}
            error={error('confirmation_policy')}
          >
            <NativeSelect id="tool-confirmation" {...register('confirmation_policy')}>
              {CONFIRMATIONS.map((value) => (
                <option key={value} value={value}>
                  {te(`toolConfirmationPolicy.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="tool-timeout" label={t('timeout')} error={error('timeout_ms')}>
            <Input
              id="tool-timeout"
              type="number"
              min={500}
              max={10000}
              step={100}
              {...register('timeout_ms', { valueAsNumber: true })}
            />
          </Field>
          <Field id="tool-retries" label={t('retries')} error={error('max_retries')}>
            <Input
              id="tool-retries"
              type="number"
              min={0}
              max={5}
              {...register('max_retries', { valueAsNumber: true })}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <Controller
              control={control}
              name="idempotency_supported"
              render={({ field }) => (
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(value) => {
                    field.onChange(value === true);
                  }}
                />
              )}
            />
            {t('idempotency')}
          </label>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="grid gap-4 pt-5 md:grid-cols-2">
          <Field id="tool-auth" label={t('auth')}>
            <NativeSelect id="tool-auth" {...register('auth_type')}>
              {(['NONE', 'BEARER', 'HMAC'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`authTypes.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {authType === 'NONE' ? null : (
            <Field
              id="tool-secret"
              label={t('secret')}
              hint={t('secretHint')}
              required
              error={error('secret')}
            >
              <Input
                id="tool-secret"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                {...register('secret')}
              />
            </Field>
          )}
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button type="submit" loading={formState.isSubmitting} disabled={formState.isSubmitting}>
          {t('submit')}
        </Button>
      </div>
    </form>
  );
}

export function CustomToolSettings({
  workspaceId,
  tool,
  canManage,
}: {
  readonly workspaceId: string;
  readonly tool: CustomTool;
  readonly canManage: boolean;
}) {
  const t = useTranslations('integrations.tools.settings');
  const te = useTranslations('enums');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [description, setDescription] = useState(tool.description);
  const [confirmation, setConfirmation] = useState(tool.confirmation_policy);
  const [timeout, setTimeoutMs] = useState(tool.timeout_ms);
  const [retries, setRetries] = useState(tool.max_retries);
  const [secret, setSecret] = useState('');
  const [pending, setPending] = useState(false);
  const minSecret = tool.auth_type === 'HMAC' ? 32 : 16;

  const patch = async (body: Record<string, unknown>, success: string) => {
    setPending(true);
    try {
      await api.patch(`/integrations/custom-tools/${tool.id}`, {
        workspace: workspaceId,
        body,
        ifMatch: tool.version,
      });
      notify({ tone: 'success', title: success });
      router.refresh();
    } catch (error) {
      showError(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="grid gap-4 pt-5 md:grid-cols-2">
          <Field id="settings-description" label={t('description')} className="md:col-span-2">
            <Textarea
              id="settings-description"
              rows={3}
              value={description}
              maxLength={1000}
              disabled={!canManage}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </Field>
          <Field id="settings-confirmation" label={t('confirmation')}>
            <NativeSelect
              id="settings-confirmation"
              value={confirmation}
              disabled={!canManage}
              onChange={(event) => {
                setConfirmation(event.target.value as typeof confirmation);
              }}
            >
              {CONFIRMATIONS.map((value) => (
                <option key={value} value={value}>
                  {te(`toolConfirmationPolicy.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="settings-timeout" label={t('timeout')}>
            <Input
              id="settings-timeout"
              type="number"
              min={500}
              max={10000}
              step={100}
              value={timeout}
              disabled={!canManage}
              onChange={(event) => {
                setTimeoutMs(Number(event.target.value));
              }}
            />
          </Field>
          <Field id="settings-retries" label={t('retries')}>
            <Input
              id="settings-retries"
              type="number"
              min={0}
              max={5}
              value={retries}
              disabled={!canManage}
              onChange={(event) => {
                setRetries(Number(event.target.value));
              }}
            />
          </Field>
          {canManage ? (
            <div className="flex flex-wrap items-end justify-end gap-2 md:col-span-2">
              {tool.status !== 'KILLED' ? (
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    void patch(
                      { status: tool.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' },
                      tool.status === 'ACTIVE' ? t('disabled') : t('enabled'),
                    )
                  }
                >
                  {tool.status === 'ACTIVE' ? t('disable') : t('enable')}
                </Button>
              ) : null}
              <Button
                disabled={
                  pending ||
                  description.trim().length < 10 ||
                  timeout < 500 ||
                  timeout > 10000 ||
                  retries < 0 ||
                  retries > 5
                }
                onClick={() => {
                  const body: Record<string, unknown> = {};
                  if (description.trim() !== tool.description)
                    body['description'] = description.trim();
                  if (confirmation !== tool.confirmation_policy)
                    body['confirmation_policy'] = confirmation;
                  if (timeout !== tool.timeout_ms) body['timeout_ms'] = timeout;
                  if (retries !== tool.max_retries) body['max_retries'] = retries;
                  if (Object.keys(body).length > 0) {
                    void patch(body, t('saved'));
                  }
                }}
              >
                {t('save')}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
      {canManage && tool.auth_type !== 'NONE' ? (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-5 md:flex-row md:items-end">
            <Field
              id="settings-secret"
              label={t('rotateSecret')}
              hint={t('rotateHint')}
              className="flex-1"
            >
              <Input
                id="settings-secret"
                type="password"
                autoComplete="new-password"
                value={secret}
                spellCheck={false}
                onChange={(event) => {
                  setSecret(event.target.value);
                }}
              />
            </Field>
            <Button
              variant="secondary"
              disabled={pending || secret.length < minSecret || !SECRET_PATTERN.test(secret)}
              onClick={async () => {
                setPending(true);
                try {
                  await api.post(`/integrations/custom-tools/${tool.id}/credentials`, {
                    workspace: workspaceId,
                    body: { secret },
                  });
                  setSecret('');
                  notify({ tone: 'success', title: t('rotated') });
                  router.refresh();
                } catch (error) {
                  showError(error);
                } finally {
                  setPending(false);
                }
              }}
            >
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              {t('rotate')}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
