import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from '@velyric/contracts';

export const UPLOAD_URL_TTL_SECONDS = 900;
export const DOWNLOAD_URL_TTL_SECONDS = 300;

export interface PresignedUpload {
  readonly url: string;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface StoredObject {
  readonly sizeBytes: number;
  readonly sha256Hex: string | null;
  readonly contentType: string | null;
}

export interface KnowledgeObjectStore {
  presignUpload(input: {
    readonly key: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly sha256Hex: string;
  }): Promise<PresignedUpload>;
  headUpload(key: string): Promise<StoredObject | null>;
  putUpload(key: string, body: Buffer, contentType: string): Promise<void>;
  presignUploadDownload(key: string): Promise<{ readonly url: string; readonly expiresAt: Date }>;
  promote(key: string): Promise<void>;
  readDocument(key: string, maxBytes: number): Promise<Buffer | null>;
}

export interface S3KnowledgeObjectStoreOptions {
  readonly region: string;
  readonly bucketPrefix: string;
  readonly endpoint: string | null;
  readonly now?: () => Date;
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

function base64ToHex(value: string | undefined): string | null {
  if (value === undefined || value === '' || value.includes('-')) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 ? decoded.toString('hex') : null;
}

export class S3KnowledgeObjectStore implements KnowledgeObjectStore {
  readonly #client: S3Client;
  readonly #transientBucket: string;
  readonly #knowledgeBucket: string;
  readonly #now: () => Date;

  constructor(options: S3KnowledgeObjectStoreOptions) {
    this.#client = new S3Client({
      region: options.region,
      ...(options.endpoint === null ? {} : { endpoint: options.endpoint, forcePathStyle: true }),
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    this.#transientBucket = s3.bucketName(options.bucketPrefix, 'transient');
    this.#knowledgeBucket = s3.bucketName(options.bucketPrefix, 'knowledge');
    this.#now = options.now ?? (() => new Date());
  }

  async presignUpload(input: {
    readonly key: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly sha256Hex: string;
  }): Promise<PresignedUpload> {
    const checksum = hexToBase64(input.sha256Hex);
    const command = new PutObjectCommand({
      Bucket: this.#transientBucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.sizeBytes,
      ChecksumSHA256: checksum,
    });
    const url = await getSignedUrl(this.#client, command, {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length', 'x-amz-checksum-sha256']),
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
    });
    return {
      url,
      method: 'PUT',
      headers: {
        'content-type': input.contentType,
        'content-length': String(input.sizeBytes),
        'x-amz-checksum-sha256': checksum,
      },
      expiresAt: new Date(this.#now().getTime() + UPLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  async headUpload(key: string): Promise<StoredObject | null> {
    try {
      const head = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#transientBucket, Key: key, ChecksumMode: 'ENABLED' }),
      );
      return {
        sizeBytes: head.ContentLength ?? 0,
        sha256Hex: base64ToHex(head.ChecksumSHA256),
        contentType: head.ContentType ?? null,
      };
    } catch (error) {
      if (
        error instanceof NotFound ||
        (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)
      ) {
        return null;
      }
      throw error;
    }
  }

  async putUpload(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#transientBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ChecksumAlgorithm: 'SHA256',
      }),
    );
  }

  async presignUploadDownload(
    key: string,
  ): Promise<{ readonly url: string; readonly expiresAt: Date }> {
    const url = await getSignedUrl(
      this.#client,
      new GetObjectCommand({ Bucket: this.#transientBucket, Key: key }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    );
    return { url, expiresAt: new Date(this.#now().getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000) };
  }

  async readDocument(key: string, maxBytes: number): Promise<Buffer | null> {
    for (const bucket of [this.#knowledgeBucket, this.#transientBucket]) {
      try {
        const object = await this.#client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if ((object.ContentLength ?? 0) > maxBytes || object.Body === undefined) {
          return null;
        }
        return Buffer.from(await object.Body.transformToByteArray());
      } catch (error) {
        if (
          error instanceof S3ServiceException &&
          (error.name === 'NoSuchKey' || error.$metadata.httpStatusCode === 404)
        ) {
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  async promote(key: string): Promise<void> {
    await this.#client.send(
      new CopyObjectCommand({
        Bucket: this.#knowledgeBucket,
        Key: key,
        CopySource: `${this.#transientBucket}/${key.split('/').map(encodeURIComponent).join('/')}`,
        MetadataDirective: 'COPY',
        ChecksumAlgorithm: 'SHA256',
      }),
    );
  }
}
