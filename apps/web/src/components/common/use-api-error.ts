'use client';

import { useToast } from '@velyric/ui';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { ApiRequestError } from '@/lib/api-types';

export interface FieldIssue {
  readonly path: string;
  readonly rule: string;
}

export function validationIssues(error: unknown): readonly FieldIssue[] {
  if (!(error instanceof ApiRequestError) || error.code !== 'VALIDATION_FAILED') {
    return [];
  }
  const issues = error.details?.['issues'];
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.flatMap((issue: unknown) => {
    if (
      typeof issue === 'object' &&
      issue !== null &&
      typeof (issue as { path?: unknown }).path === 'string'
    ) {
      const candidate = issue as { path: string; rule?: unknown };
      return [
        {
          path: candidate.path,
          rule: typeof candidate.rule === 'string' ? candidate.rule : 'invalid',
        },
      ];
    }
    return [];
  });
}

export function issueFor(issues: readonly FieldIssue[], field: string): FieldIssue | undefined {
  return issues.find(
    (issue) =>
      issue.path === `/body/${field}` ||
      issue.path === `/${field}` ||
      issue.path.startsWith(`/body/${field}/`),
  );
}

export function useApiErrorMessage(): (error: unknown) => {
  readonly title: string;
  readonly description?: string;
} {
  const t = useTranslations('errors');
  return useCallback(
    (error: unknown) => {
      if (error instanceof ApiRequestError) {
        const key = `codes.${error.code}`;
        const title = t.has(key) ? t(key) : t('generic.title');
        return error.traceId === null
          ? { title }
          : { title, description: t('generic.reference', { traceId: error.traceId }) };
      }
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        return { title: t('generic.offline') };
      }
      return { title: t('generic.title'), description: t('generic.description') };
    },
    [t],
  );
}

export function useApiErrorToast(): (error: unknown) => void {
  const { notify } = useToast();
  const message = useApiErrorMessage();
  return useCallback(
    (error: unknown) => {
      const { title, description } = message(error);
      notify(
        description === undefined
          ? { tone: 'error', title }
          : { tone: 'error', title, description },
      );
    },
    [message, notify],
  );
}
