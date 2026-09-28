import { Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';
import { AppConfigService } from '@config/app-config.service';

/**
 * Uploads a backup to S3-compatible storage (Cloudflare R2, Backblaze B2,
 * MinIO, AWS S3).
 *
 * Implemented directly against the REST API with SigV4 rather than pulling in
 * the AWS SDK: this is one PUT of one file per night, and the SDK is a large
 * dependency for a single request. The signing below is the standard
 * `AWS4-HMAC-SHA256` flow with `UNSIGNED-PAYLOAD`, which every S3-compatible
 * provider accepts over TLS and which lets the body stream rather than being
 * buffered to hash it.
 */
@Injectable()
export class S3UploaderService {
  private readonly logger = new Logger(S3UploaderService.name);

  constructor(private readonly config: AppConfigService) {}

  async upload(key: string, body: Readable, contentLength: number): Promise<void> {
    const endpoint = this.config.get('BACKUP_S3_ENDPOINT');
    const bucket = this.config.get('BACKUP_S3_BUCKET');
    const region = this.config.get('BACKUP_S3_REGION');
    const accessKeyId = this.config.get('BACKUP_S3_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get('BACKUP_S3_SECRET_ACCESS_KEY');

    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('S3 upload is enabled but endpoint, bucket or credentials are missing');
    }

    const url = new URL(`${endpoint.replace(/\/+$/, '')}/${bucket}/${encodeKey(key)}`);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const headers: Record<string, string> = {
      host: url.host,
      'content-length': String(contentLength),
      'content-type': 'application/octet-stream',
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      'x-amz-date': amzDate,
    };

    headers.authorization = this.sign({
      method: 'PUT',
      url,
      headers,
      dateStamp,
      amzDate,
      region,
      accessKeyId,
      secretAccessKey,
    });

    await this.send(url, headers, body);
    this.logger.log(`Uploaded ${key} to ${url.host}/${bucket}`);
  }

  private send(url: URL, headers: Record<string, string>, body: Readable): Promise<void> {
    const requestFn = url.protocol === 'http:' ? httpRequest : httpsRequest;

    return new Promise((resolvePromise, reject) => {
      const req = requestFn(url, { method: 'PUT', headers, timeout: 10 * 60 * 1000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolvePromise();
          reject(new Error(`S3 upload failed with ${status}: ${Buffer.concat(chunks).toString().slice(0, 400)}`));
        });
      });

      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('S3 upload timed out')));
      body.on('error', reject);
      body.pipe(req);
    });
  }

  /** The AWS SigV4 signing procedure, in full. */
  private sign(input: {
    method: string;
    url: URL;
    headers: Record<string, string>;
    dateStamp: string;
    amzDate: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  }): string {
    const service = 's3';
    const signedHeaderNames = Object.keys(input.headers)
      .map((h) => h.toLowerCase())
      .sort();

    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${input.headers[name].trim()}\n`)
      .join('');

    const canonicalRequest = [
      input.method,
      input.url.pathname,
      input.url.searchParams.toString(),
      canonicalHeaders,
      signedHeaderNames.join(';'),
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const scope = `${input.dateStamp}/${input.region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      input.amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const dateKey = hmac(`AWS4${input.secretAccessKey}`, input.dateStamp);
    const regionKey = hmac(dateKey, input.region);
    const serviceKey = hmac(regionKey, service);
    const signingKey = hmac(serviceKey, 'aws4_request');
    const signature = hmac(signingKey, stringToSign).toString('hex');

    return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** Percent-encodes each path segment, leaving the separators intact. */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
