'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogTrigger,
  Field,
  Input,
  NativeSelect,
  ProgressBar,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@velyric/ui';
import { Archive, FileUp, Plus, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useApiErrorToast } from '@/components/common/use-api-error';
import { api } from '@/lib/api-client';
import type { KnowledgeSource, KnowledgeSourceWithUpload } from '@/lib/api/knowledge';
import { FaqEntriesEditor, faqEntriesValid, type FaqEntry } from './faq-editor';
import {
  ACCEPTED_FILE_TYPES,
  fileSourceType,
  MAX_KNOWLEDGE_FILE_BYTES,
  sha256Hex,
  uploadToPresignedUrl,
} from './upload';

type Mode = 'FILE' | 'URL' | 'FAQ';

function useFileUpload(workspaceId: string) {
  const [progress, setProgress] = useState<number | null>(null);
  const run = async (source: KnowledgeSourceWithUpload, file: File) => {
    if (source.upload === undefined) {
      throw new Error('missing_upload');
    }
    setProgress(0);
    try {
      await uploadToPresignedUrl(source.upload, file, setProgress);
      await api.post(`/knowledge-sources/${source.id}/upload-complete`, { workspace: workspaceId });
    } finally {
      setProgress(null);
    }
  };
  return { progress, run };
}

export function CreateKnowledgeSourceDialog({
  workspaceId,
  locations,
}: {
  readonly workspaceId: string;
  readonly locations: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useTranslations('knowledge.create');
  const tc = useTranslations('common.actions');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const upload = useFileUpload(workspaceId);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('FILE');
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState('');
  const [locationId, setLocationId] = useState('');
  const [uri, setUri] = useState('');
  const [ttl, setTtl] = useState('24');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  const [entries, setEntries] = useState<FaqEntry[]>([{ question: '', answer: '' }]);
  const [pending, setPending] = useState(false);

  const reset = () => {
    setTitle('');
    setUri('');
    setFile(null);
    setFileError(undefined);
    setEntries([{ question: '', answer: '' }]);
  };

  const selectFile = (selected: File | null) => {
    setFile(null);
    setFileError(undefined);
    if (selected === null) {
      return;
    }
    if (fileSourceType(selected) === null) {
      setFileError(t('unsupportedType'));
    } else if (selected.size === 0 || selected.size > MAX_KNOWLEDGE_FILE_BYTES) {
      setFileError(t('tooLarge'));
    } else {
      setFile(selected);
      if (title === '') {
        setTitle(selected.name.replace(/\.[^.]+$/, '').slice(0, 300));
      }
    }
  };

  const valid =
    title.trim() !== '' &&
    (mode === 'FILE'
      ? file !== null
      : mode === 'URL'
        ? /^https:\/\/.{5,}/.test(uri.trim())
        : faqEntriesValid(entries));

  const submit = async () => {
    setPending(true);
    const common = {
      title: title.trim(),
      ...(language === '' ? {} : { language }),
      ...(locationId === '' ? {} : { location_id: locationId }),
    };
    try {
      if (mode === 'FILE' && file !== null) {
        const sourceType = fileSourceType(file);
        if (sourceType === null) {
          return;
        }
        const created = await api.post<KnowledgeSourceWithUpload>('/knowledge-sources', {
          workspace: workspaceId,
          body: {
            ...common,
            source_type: sourceType,
            size_bytes: file.size,
            sha256: await sha256Hex(file),
          },
        });
        await upload.run(created, file);
        router.push(`/app/${workspaceId}/knowledge/${created.id}`);
      } else if (mode === 'URL') {
        const created = await api.post<KnowledgeSource>('/knowledge-sources', {
          workspace: workspaceId,
          body: {
            ...common,
            source_type: 'URL',
            uri: uri.trim(),
            freshness_ttl_hours: Math.min(8760, Math.max(1, Number(ttl) || 24)),
          },
        });
        router.push(`/app/${workspaceId}/knowledge/${created.id}`);
      } else {
        const created = await api.post<KnowledgeSource>('/knowledge-sources', {
          workspace: workspaceId,
          body: {
            ...common,
            source_type: 'FAQ',
            entries: entries.map((entry) => ({
              question: entry.question.trim(),
              answer: entry.answer.trim(),
            })),
          },
        });
        router.push(`/app/${workspaceId}/knowledge/${created.id}`);
      }
      notify({ tone: 'success', title: t('created') });
      setOpen(false);
      reset();
    } catch (error) {
      showError(error);
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setOpen(next);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('button')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={t('title')}
        description={t('description')}
        closeLabel={tc('close')}
        size="lg"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Tabs
            value={mode}
            onValueChange={(value) => {
              setMode(value === 'URL' || value === 'FAQ' ? value : 'FILE');
            }}
          >
            <TabsList>
              <TabsTrigger value="FILE">{t('modes.FILE')}</TabsTrigger>
              <TabsTrigger value="URL">{t('modes.URL')}</TabsTrigger>
              <TabsTrigger value="FAQ">{t('modes.FAQ')}</TabsTrigger>
            </TabsList>
            <TabsContent value="FILE" className="pt-4">
              <Field id="knowledge-file" label={t('file')} hint={t('fileHint')} error={fileError}>
                <Input
                  id="knowledge-file"
                  type="file"
                  accept={ACCEPTED_FILE_TYPES}
                  className="py-2"
                  onChange={(event) => {
                    selectFile(event.target.files?.[0] ?? null);
                  }}
                />
              </Field>
            </TabsContent>
            <TabsContent value="URL" className="grid gap-4 pt-4 md:grid-cols-[2fr_1fr]">
              <Field id="knowledge-url" label={t('url')} hint={t('urlHint')}>
                <Input
                  id="knowledge-url"
                  type="url"
                  inputMode="url"
                  value={uri}
                  maxLength={2000}
                  placeholder="https://"
                  onChange={(event) => {
                    setUri(event.target.value);
                  }}
                />
              </Field>
              <Field id="knowledge-ttl" label={t('refreshEvery')}>
                <NativeSelect
                  id="knowledge-ttl"
                  value={ttl}
                  onChange={(event) => {
                    setTtl(event.target.value);
                  }}
                >
                  {['6', '24', '168', '720'].map((hours) => (
                    <option key={hours} value={hours}>
                      {t(`ttl.${hours}`)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </TabsContent>
            <TabsContent value="FAQ" className="max-h-[45dvh] overflow-y-auto pt-4">
              <FaqEntriesEditor entries={entries} onChange={setEntries} idPrefix="create-faq" />
            </TabsContent>
          </Tabs>
          <div className="grid gap-4 md:grid-cols-3">
            <Field id="knowledge-title" label={t('titleField')} required className="md:col-span-3">
              <Input
                id="knowledge-title"
                value={title}
                maxLength={300}
                onChange={(event) => {
                  setTitle(event.target.value);
                }}
              />
            </Field>
            <Field id="knowledge-language" label={t('language')}>
              <NativeSelect
                id="knowledge-language"
                value={language}
                onChange={(event) => {
                  setLanguage(event.target.value);
                }}
              >
                <option value="">{t('detectLanguage')}</option>
                <option value="hu">Magyar</option>
                <option value="de">Deutsch</option>
                <option value="en">English</option>
              </NativeSelect>
            </Field>
            {locations.length > 0 ? (
              <Field id="knowledge-location" label={t('location')} className="md:col-span-2">
                <NativeSelect
                  id="knowledge-location"
                  value={locationId}
                  onChange={(event) => {
                    setLocationId(event.target.value);
                  }}
                >
                  <option value="">{t('allLocations')}</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
          </div>
          {upload.progress === null ? null : (
            <ProgressBar value={upload.progress} label={t('uploading')} />
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setOpen(false);
              }}
            >
              {tc('cancel')}
            </Button>
            <Button type="submit" loading={pending} disabled={pending || !valid}>
              {mode === 'FILE' ? tc('upload') : tc('create')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function KnowledgeSourceActions({
  workspaceId,
  source,
  canWrite,
}: {
  readonly workspaceId: string;
  readonly source: KnowledgeSource;
  readonly canWrite: boolean;
}) {
  const t = useTranslations('knowledge.actions');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const upload = useFileUpload(workspaceId);
  const [pending, setPending] = useState(false);
  if (!canWrite || source.status === 'ARCHIVED') {
    return null;
  }
  const busy = ['QUEUED', 'SCANNING', 'PARSING', 'CHUNKING', 'EMBEDDING'].includes(source.status);
  const replaceFile = async (file: File | null) => {
    if (file === null) {
      return;
    }
    if (
      fileSourceType(file) !== source.source_type ||
      file.size === 0 ||
      file.size > MAX_KNOWLEDGE_FILE_BYTES
    ) {
      notify({ tone: 'error', title: t('wrongFile') });
      return;
    }
    setPending(true);
    try {
      const updated = await api.post<KnowledgeSourceWithUpload>(
        `/knowledge-sources/${source.id}/uploads`,
        { workspace: workspaceId, body: { size_bytes: file.size, sha256: await sha256Hex(file) } },
      );
      await upload.run(updated, file);
      notify({ tone: 'success', title: t('uploaded') });
    } catch (error) {
      showError(error);
    } finally {
      setPending(false);
      router.refresh();
    }
  };
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap gap-2">
        {source.source_type === 'URL' ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={pending || busy}
            onClick={async () => {
              setPending(true);
              try {
                await api.post(`/knowledge-sources/${source.id}/sync`, { workspace: workspaceId });
                notify({ tone: 'success', title: t('syncQueued') });
                router.refresh();
              } catch (error) {
                showError(error);
              } finally {
                setPending(false);
              }
            }}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t('sync')}
          </Button>
        ) : null}
        {source.source_type.startsWith('FILE_') ? (
          <label
            className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-sm border border-border bg-surface px-3 text-[13px] font-medium text-text shadow-soft hover:bg-surface-muted ${pending || busy ? 'pointer-events-none opacity-60' : ''}`}
          >
            <FileUp className="h-4 w-4" aria-hidden="true" />
            {t('replaceFile')}
            <input
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              className="sr-only"
              disabled={pending || busy}
              onChange={(event) => void replaceFile(event.target.files?.[0] ?? null)}
            />
          </label>
        ) : null}
        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="sm" disabled={pending}>
              <Archive className="h-4 w-4" aria-hidden="true" />
              {t('archive')}
            </Button>
          }
          title={t('archiveTitle')}
          description={t('archiveDescription')}
          confirmLabel={t('archive')}
          destructive
          onConfirm={async () => {
            try {
              await api.post(`/knowledge-sources/${source.id}/archive`, {
                workspace: workspaceId,
                ifMatch: source.version,
              });
              notify({ tone: 'success', title: t('archived') });
              router.push(`/app/${workspaceId}/knowledge`);
              router.refresh();
              return true;
            } catch (error) {
              showError(error);
              return false;
            }
          }}
        />
      </div>
      {upload.progress === null ? null : (
        <div className="w-56">
          <ProgressBar value={upload.progress} label={t('uploading')} />
        </div>
      )}
    </div>
  );
}

export function FaqEntriesPanel({
  workspaceId,
  sourceId,
  version,
  initial,
  canWrite,
}: {
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly version: number;
  readonly initial: readonly FaqEntry[];
  readonly canWrite: boolean;
}) {
  const t = useTranslations('knowledge.faq');
  const router = useRouter();
  const { notify } = useToast();
  const showError = useApiErrorToast();
  const [entries, setEntries] = useState<FaqEntry[]>(
    initial.length === 0 ? [{ question: '', answer: '' }] : [...initial],
  );
  const [pending, setPending] = useState(false);
  const dirty = JSON.stringify(entries) !== JSON.stringify(initial);
  if (!canWrite) {
    return (
      <dl className="flex flex-col gap-3">
        {initial.map((entry, index) => (
          <div key={String(index)} className="rounded-lg border border-border p-3">
            <dt className="font-medium text-text">{entry.question}</dt>
            <dd className="mt-1 whitespace-pre-line text-sm text-text-muted">{entry.answer}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <FaqEntriesEditor entries={entries} onChange={setEntries} idPrefix={`faq-${sourceId}`} />
      <div className="flex justify-end">
        <Button
          disabled={!dirty || pending || !faqEntriesValid(entries)}
          loading={pending}
          onClick={async () => {
            setPending(true);
            try {
              await api.put(`/knowledge-sources/${sourceId}/entries`, {
                workspace: workspaceId,
                ifMatch: version,
                body: {
                  entries: entries.map((entry) => ({
                    question: entry.question.trim(),
                    answer: entry.answer.trim(),
                  })),
                },
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
          {t('save')}
        </Button>
      </div>
    </div>
  );
}
