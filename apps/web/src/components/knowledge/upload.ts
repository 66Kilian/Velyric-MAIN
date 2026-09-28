'use client';

import type { FileSourceType, PresignedUpload } from '@/lib/api/knowledge';

export const MAX_KNOWLEDGE_FILE_BYTES = 50 * 1024 * 1024;

const EXTENSIONS: Readonly<Record<string, FileSourceType>> = {
  pdf: 'FILE_PDF',
  docx: 'FILE_DOCX',
  txt: 'FILE_TXT',
  md: 'FILE_MARKDOWN',
  markdown: 'FILE_MARKDOWN',
  csv: 'FILE_CSV',
};

export const ACCEPTED_FILE_TYPES =
  '.pdf,.docx,.txt,.md,.markdown,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv';

export function fileSourceType(file: File): FileSourceType | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSIONS[extension] ?? null;
}

export async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const UNSAFE_HEADERS = new Set(['content-length', 'host']);

export function uploadToPresignedUrl(
  upload: PresignedUpload,
  file: File,
  onProgress: (ratio: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(upload.method, upload.url);
    for (const [name, value] of Object.entries(upload.headers)) {
      if (!UNSAFE_HEADERS.has(name.toLowerCase())) {
        request.setRequestHeader(name, value);
      }
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded / event.total);
      }
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
      } else {
        reject(new Error(`upload_failed_${String(request.status)}`));
      }
    };
    request.onerror = () => {
      reject(new Error('upload_network_error'));
    };
    request.onabort = () => {
      reject(new Error('upload_aborted'));
    };
    request.send(file);
  });
}
