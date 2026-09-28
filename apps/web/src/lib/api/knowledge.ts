import type {
  KnowledgeFreshness,
  KnowledgeSourceStatus,
  KnowledgeSourceType,
} from '@velyric/contracts';

export type FileSourceType = 'FILE_PDF' | 'FILE_DOCX' | 'FILE_TXT' | 'FILE_MARKDOWN' | 'FILE_CSV';
export type FaqSourceType = 'FAQ' | 'MANUAL_QA';

export interface PresignedUpload {
  readonly url: string;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
  readonly expires_at: string;
}

export interface KnowledgeSource {
  readonly id: string;
  readonly source_type: KnowledgeSourceType;
  readonly title: string;
  readonly uri: string | null;
  readonly mime_type: string | null;
  readonly size_bytes: number | null;
  readonly language: string | null;
  readonly location_id: string | null;
  readonly status: KnowledgeSourceStatus;
  readonly freshness: KnowledgeFreshness;
  readonly freshness_ttl_hours: number | null;
  readonly active_version_id: string | null;
  readonly acl: readonly string[];
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly last_synced_at: string | null;
  readonly last_error_code: string | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface KnowledgeSourceWithUpload extends KnowledgeSource {
  readonly upload?: PresignedUpload;
}

export type MalwareScanResult = 'CLEAN' | 'INFECTED' | 'ERROR';

export interface KnowledgeSourceVersion {
  readonly id: string;
  readonly version_number: number;
  readonly status: KnowledgeSourceStatus;
  readonly content_sha256: string;
  readonly malware_scan_result: MalwareScanResult | null;
  readonly pii_findings: readonly string[];
  readonly chunk_count: number;
  readonly parser: string | null;
  readonly ocr_used: boolean;
  readonly error_code: string | null;
  readonly parsed_at: string | null;
  readonly activated_at: string | null;
  readonly created_at: string;
}

export interface KnowledgeSourceDetail extends KnowledgeSource {
  readonly versions: readonly KnowledgeSourceVersion[];
}

export interface KnowledgeChunk {
  readonly id: string;
  readonly chunk_index: number;
  readonly heading_path: readonly string[];
  readonly content: string;
  readonly token_count: number;
  readonly pii_flags: readonly string[];
}

export interface FaqEntry {
  readonly question: string;
  readonly answer: string;
}

export interface LocationSummary {
  readonly id: string;
  readonly name: string;
  readonly is_primary: boolean;
  readonly status: string;
}

export const MAX_KNOWLEDGE_FILE_BYTES = 50 * 1024 * 1024;

export const FILE_SOURCE_TYPES: Readonly<
  Record<
    FileSourceType,
    {
      readonly mime: string;
      readonly extensions: readonly string[];
      readonly acceptedMimes: readonly string[];
    }
  >
> = {
  FILE_PDF: { mime: 'application/pdf', extensions: ['pdf'], acceptedMimes: ['application/pdf'] },
  FILE_DOCX: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx'],
    acceptedMimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  FILE_TXT: { mime: 'text/plain', extensions: ['txt'], acceptedMimes: ['text/plain'] },
  FILE_MARKDOWN: {
    mime: 'text/markdown',
    extensions: ['md', 'markdown'],
    acceptedMimes: ['text/markdown', 'text/x-markdown', 'text/plain'],
  },
  FILE_CSV: {
    mime: 'text/csv',
    extensions: ['csv'],
    acceptedMimes: ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
  },
};

export const FILE_ACCEPT = Object.values(FILE_SOURCE_TYPES)
  .flatMap((entry) => [...entry.extensions.map((extension) => `.${extension}`), entry.mime])
  .join(',');

export const KNOWLEDGE_LIMITS = {
  titleMax: 300,
  uriMin: 12,
  uriMax: 2000,
  ttlMin: 1,
  ttlMax: 8760,
  defaultTtlHours: 168,
  questionMin: 3,
  questionMax: 1000,
  answerMin: 1,
  answerMax: 8000,
  entriesMin: 1,
  entriesMax: 1000,
  aclMax: 20,
} as const;

export const ACL_TAG_PATTERN = /^[a-z][a-z0-9_:-]{1,60}$/;
export const LANGUAGE_OPTIONS = ['hu', 'de', 'en'] as const;
export const TTL_PRESETS = [24, 72, 168, 720] as const;

export const IN_FLIGHT_STATUSES: ReadonlySet<KnowledgeSourceStatus> = new Set([
  'QUEUED',
  'SCANNING',
  'PARSING',
  'CHUNKING',
  'EMBEDDING',
]);
export const REFRESHABLE_STATUSES: ReadonlySet<KnowledgeSourceStatus> = new Set([
  'ACTIVE',
  'FAILED',
  'READY',
  'QUARANTINED',
]);
export const PIPELINE_STEPS: readonly KnowledgeSourceStatus[] = [
  'PENDING_UPLOAD',
  'QUEUED',
  'SCANNING',
  'PARSING',
  'CHUNKING',
  'EMBEDDING',
  'ACTIVE',
];

export const SOURCE_STATUS_OPTIONS: readonly KnowledgeSourceStatus[] = [
  'PENDING_UPLOAD',
  'QUEUED',
  'SCANNING',
  'PARSING',
  'CHUNKING',
  'EMBEDDING',
  'READY',
  'ACTIVE',
  'FAILED',
  'QUARANTINED',
  'ARCHIVED',
];
export const SOURCE_TYPE_OPTIONS: readonly KnowledgeSourceType[] = [
  'URL',
  'WEBSITE',
  'FILE_PDF',
  'FILE_DOCX',
  'FILE_TXT',
  'FILE_MARKDOWN',
  'FILE_CSV',
  'FAQ',
  'MANUAL_QA',
];

export function isFileSourceType(value: string): value is FileSourceType {
  return Object.hasOwn(FILE_SOURCE_TYPES, value);
}

export function isFaqSourceType(value: string): value is FaqSourceType {
  return value === 'FAQ' || value === 'MANUAL_QA';
}

export function isRemoteSourceType(value: string): boolean {
  return value === 'URL' || value === 'WEBSITE';
}
