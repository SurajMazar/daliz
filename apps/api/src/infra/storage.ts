import type { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * Object storage behind a narrow interface. Keys are always built from validated segments,
 * never from user-supplied filenames, and tenant objects always live under
 * `tenants/<tenantId>/`, so one tenant's key can never address another tenant's object.
 */
@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly logger = new Logger(StorageService.name);

  constructor(@Inject(ENV) env: Env) {
    this.bucket = env.S3_BUCKET;
    this.s3 = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    });
  }

  static tenantKey(tenantId: string, ...segments: string[]): string {
    for (const s of [tenantId, ...segments]) {
      if (!SAFE_SEGMENT.test(s) || s.includes('..')) throw new Error(`Unsafe storage key segment: ${s}`);
    }
    return ['tenants', tenantId, ...segments].join('/');
  }

  static platformKey(...segments: string[]): string {
    for (const s of segments) {
      if (!SAFE_SEGMENT.test(s) || s.includes('..')) throw new Error(`Unsafe storage key segment: ${s}`);
    }
    return ['platform', ...segments].join('/');
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`created bucket ${this.bucket}`);
    }
  }

  async put(key: string, body: Buffer, contentType: string, cacheControl = 'private, max-age=0'): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
        ServerSideEncryption: undefined,
      }),
    );
  }

  async get(key: string): Promise<{ body: Readable; contentType: string; contentLength: number | undefined } | null> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        body: out.Body as Readable,
        contentType: out.ContentType ?? 'application/octet-stream',
        contentLength: out.ContentLength,
      };
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    const obj = await this.get(key);
    if (!obj) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of obj.body) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  /**
   * Short-lived presigned URL. Callers must authorize before calling this. Downloads are
   * forced to `attachment`; `inline` is only for types known to be safe to render.
   */
  async signedDownloadUrl(
    key: string,
    filename: string,
    opts: { expiresInSeconds?: number; inline?: boolean; contentType?: string } = {},
  ): Promise<string> {
    const ascii = filename.replace(/[^\w.\- ]/g, '_').slice(0, 150);
    const utf8 = encodeURIComponent(filename.slice(0, 150));
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `${opts.inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${utf8}`,
        ResponseContentType: opts.contentType,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: Math.min(opts.expiresInSeconds ?? 120, 900) },
    );
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, Key: destinationKey, CopySource: `${this.bucket}/${sourceKey}` }));
  }

  async delete(keys: string[]): Promise<void> {
    if (!keys.length) return;
    for (const k of keys) if (!k.startsWith('tenants/') && !k.startsWith('platform/')) throw new Error('Refusing to delete outside known prefixes');
    await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix.startsWith('tenants/') && !prefix.startsWith('platform/')) throw new Error('Refusing to delete outside known prefixes');
    let deleted = 0;
    let token: string | undefined;
    do {
      const list = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const objects = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (objects.length) {
        await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects } }));
        deleted += objects.length;
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  async ping(): Promise<number> {
    const start = performance.now();
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return Math.round(performance.now() - start);
  }
}
