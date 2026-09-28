import { createHash } from 'node:crypto';
import type {
  KnowledgeObjectStore,
  PresignedUpload,
  StoredObject,
} from '../../src/knowledge/object-store.js';

export class InMemoryKnowledgeObjectStore implements KnowledgeObjectStore {
  readonly transient = new Map<string, { body: Buffer; contentType: string }>();
  readonly knowledge = new Map<string, { body: Buffer; contentType: string }>();
  readonly presigned: { key: string; contentType: string; sizeBytes: number; sha256Hex: string }[] =
    [];

  presignUpload(input: {
    readonly key: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly sha256Hex: string;
  }): Promise<PresignedUpload> {
    this.presigned.push({ ...input });
    return Promise.resolve({
      url: `https://velyric-local-transient.s3.test/${input.key}?X-Amz-Signature=test`,
      method: 'PUT',
      headers: {
        'content-type': input.contentType,
        'content-length': String(input.sizeBytes),
        'x-amz-checksum-sha256': Buffer.from(input.sha256Hex, 'hex').toString('base64'),
      },
      expiresAt: new Date(Date.now() + 900_000),
    });
  }

  simulateClientUpload(key: string, body: Buffer, contentType: string): void {
    const declared = this.presigned.find((entry) => entry.key === key);
    if (declared === undefined) {
      throw new Error(`no presigned upload for ${key}`);
    }
    if (
      declared.sizeBytes !== body.length ||
      declared.sha256Hex !== createHash('sha256').update(body).digest('hex')
    ) {
      throw new Error('S3 would reject the upload: size or checksum mismatch');
    }
    this.transient.set(key, { body, contentType });
  }

  headUpload(key: string): Promise<StoredObject | null> {
    const object = this.transient.get(key);
    return Promise.resolve(
      object === undefined
        ? null
        : {
            sizeBytes: object.body.length,
            sha256Hex: createHash('sha256').update(object.body).digest('hex'),
            contentType: object.contentType,
          },
    );
  }

  putUpload(key: string, body: Buffer, contentType: string): Promise<void> {
    this.transient.set(key, { body, contentType });
    return Promise.resolve();
  }

  presignUploadDownload(key: string): Promise<{ readonly url: string; readonly expiresAt: Date }> {
    return Promise.resolve({
      url: `https://velyric-local-transient.s3.test/${key}?X-Amz-Signature=download`,
      expiresAt: new Date(Date.now() + 300_000),
    });
  }

  readDocument(key: string, maxBytes: number): Promise<Buffer | null> {
    const object = this.knowledge.get(key) ?? this.transient.get(key);
    return Promise.resolve(
      object === undefined || object.body.length > maxBytes ? null : object.body,
    );
  }

  promote(key: string): Promise<void> {
    const object = this.transient.get(key);
    if (object === undefined) {
      return Promise.reject(new Error(`NoSuchKey: ${key}`));
    }
    this.knowledge.set(key, object);
    return Promise.resolve();
  }
}
