import type { BadgeTone } from '@velyric/ui';

export const KNOWLEDGE_STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  PENDING_UPLOAD: 'neutral',
  QUEUED: 'sky',
  SCANNING: 'sky',
  PARSING: 'sky',
  CHUNKING: 'sky',
  EMBEDDING: 'sky',
  READY: 'mint',
  ACTIVE: 'success',
  FAILED: 'danger',
  QUARANTINED: 'danger',
  SUPERSEDED: 'neutral',
  ARCHIVED: 'neutral',
  DELETING: 'warning',
};
