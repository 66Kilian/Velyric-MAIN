'use client';

import { Button, Field, Input, Textarea } from '@velyric/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

export interface FaqEntry {
  readonly question: string;
  readonly answer: string;
}

export function faqEntriesValid(entries: readonly FaqEntry[]): boolean {
  return (
    entries.length >= 1 &&
    entries.length <= 1000 &&
    entries.every(
      (entry) =>
        entry.question.trim().length >= 3 &&
        entry.question.length <= 1000 &&
        entry.answer.trim().length >= 1 &&
        entry.answer.length <= 8000,
    )
  );
}

export function FaqEntriesEditor({
  entries,
  onChange,
  idPrefix,
}: {
  readonly entries: readonly FaqEntry[];
  readonly onChange: (entries: FaqEntry[]) => void;
  readonly idPrefix: string;
}) {
  const t = useTranslations('knowledge.faq');
  const update = (index: number, patch: Partial<FaqEntry>) => {
    onChange(
      entries.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)),
    );
  };
  return (
    <div className="flex flex-col gap-3">
      {entries.map((entry, index) => (
        <div
          key={`${idPrefix}-${String(index)}`}
          className="flex flex-col gap-3 rounded-lg border border-border p-3"
        >
          <div className="flex items-start gap-2">
            <Field
              id={`${idPrefix}-q-${String(index)}`}
              label={t('question', { number: index + 1 })}
              className="flex-1"
              error={
                entry.question.length > 0 && entry.question.trim().length < 3
                  ? t('questionTooShort')
                  : undefined
              }
            >
              <Input
                id={`${idPrefix}-q-${String(index)}`}
                value={entry.question}
                maxLength={1000}
                onChange={(event) => {
                  update(index, { question: event.target.value });
                }}
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="mt-6"
              disabled={entries.length === 1}
              onClick={() => {
                onChange(entries.filter((_, position) => position !== index));
              }}
              aria-label={t('remove', { number: index + 1 })}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <Field id={`${idPrefix}-a-${String(index)}`} label={t('answer')}>
            <Textarea
              id={`${idPrefix}-a-${String(index)}`}
              value={entry.answer}
              maxLength={8000}
              rows={3}
              onChange={(event) => {
                update(index, { answer: event.target.value });
              }}
            />
          </Field>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="self-start"
        disabled={entries.length >= 1000}
        onClick={() => {
          onChange([...entries, { question: '', answer: '' }]);
        }}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t('add')}
      </Button>
    </div>
  );
}
