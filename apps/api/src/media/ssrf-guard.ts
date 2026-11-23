import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { open, rename, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as ipaddr from 'ipaddr.js';

/**
 * Direct media imports may only connect to public addresses. DNS is resolved and
 * checked for every redirect, and the checked address is pinned to the actual
 * HTTP connection. The original URL is kept for the Host header, TLS SNI and
 * certificate validation.
 */
export interface UrlPolicyResult {
  url: URL;
  resolvedIps: string[];
}

class DownloadLimitError extends Error {}

function blockedIpReason(ip: string): string | null {
  // Do not interpret malformed DNS answers as hostnames or allow alternate IP
  // spellings to bypass the range checks. URL has already canonicalised literals.
  if (!isIP(ip)) return 'invalid address';
  const address = ipaddr.parse(ip);
  const range = address.range();
  if (range !== 'unicast') return range;
  // Reject IPv4-compatible/translated and other non-global IPv6 ranges as well
  // as IPv4-mapped addresses (including their hexadecimal URL spelling).
  if (address instanceof ipaddr.IPv6 && !address.match(ipaddr.IPv6.parse('2000::'), 3)) return 'non-global IPv6';
  return null;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function assertSafeOutboundUrl(
  rawUrl: string,
  options: { requireHttps: boolean; signal?: AbortSignal },
): Promise<UrlPolicyResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Malformed URL' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BadRequestException({ code: 'SSRF_BLOCKED', message: `Scheme ${url.protocol} is not allowed` });
  }
  if (options.requireHttps && url.protocol !== 'https:') {
    throw new BadRequestException({ code: 'SSRF_BLOCKED', message: 'Only HTTPS media URLs are accepted in this configuration' });
  }
  if (url.username || url.password) {
    throw new BadRequestException({ code: 'SSRF_BLOCKED', message: 'Credentials in URLs are not allowed' });
  }

  // WHATWG URL retains brackets around IPv6 literals; DNS and isIP do not.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const hostnameWithoutDot = hostname.replace(/\.$/, '');
  if (hostnameWithoutDot === 'localhost' || hostnameWithoutDot.endsWith('.localhost') ||
      hostnameWithoutDot.endsWith('.internal') || hostnameWithoutDot.endsWith('.local')) {
    throw new BadRequestException({ code: 'SSRF_BLOCKED', message: `Hostname ${hostname} is not allowed` });
  }

  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const records = await abortable(lookup(hostname, { all: true, verbatim: true }), options.signal);
      addresses = records.map((record) => record.address);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `Cannot resolve host ${hostname}` });
    }
  }
  if (addresses.length === 0) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `Cannot resolve host ${hostname}` });
  }
  for (const address of addresses) {
    const blocked = blockedIpReason(address);
    if (blocked) {
      throw new BadRequestException({ code: 'SSRF_BLOCKED', message: `${hostname} resolves to a blocked address (${blocked})` });
    }
  }
  return { url, resolvedIps: addresses };
}

/** Make exactly one connection using the validated address, without another DNS lookup. */
function requestPinned(url: URL, address: string, signal: AbortSignal): Promise<IncomingMessage> {
  const family = isIP(address);
  if (family !== 4 && family !== 6) throw new Error('Invalid validated address');
  const options: RequestOptions & { autoSelectFamily: boolean } = {
    method: 'GET',
    signal,
    // Do not reuse an existing connection whose destination was resolved elsewhere.
    agent: false,
    family,
    autoSelectFamily: false,
    headers: { 'accept-encoding': 'identity' },
    lookup: (_hostname, _options, callback) => callback(null, address, family),
  };
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(url, options, resolve);
    outgoing.once('error', reject);
    outgoing.end();
  });
}

/**
 * Stream to an adjacent private temporary file, then atomically publish it.
 * One deadline covers DNS, all redirects, headers and the complete response body.
 */
export async function downloadUrlToFile(
  rawUrl: string,
  destinationPath: string,
  options: { maxBytes: number; timeoutMs: number; maxRedirects?: number; requireHttps: boolean },
): Promise<{ sizeBytes: number; contentType: string | null; finalUrl: string }> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 ||
      !Number.isInteger(options.maxRedirects ?? 3) || (options.maxRedirects ?? 3) < 0) {
    throw new Error('Invalid download limits');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const temporaryPath = `${destinationPath}.tmp-${randomUUID()}`;
  let ownsTemporaryFile = false;
  let response: IncomingMessage | undefined;
  let current = rawUrl;
  try {
    const maxRedirects = options.maxRedirects ?? 3;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const policy = await assertSafeOutboundUrl(current, { requireHttps: options.requireHttps, signal: controller.signal });
      controller.signal.throwIfAborted();
      // DNS can return both IPv6 and IPv4 even when only one family is
      // reachable. Try each previously validated address, never re-resolve.
      let connectionError: unknown;
      for (const address of policy.resolvedIps) {
        try {
          response = await requestPinned(policy.url, address, controller.signal);
          break;
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          connectionError = error;
        }
      }
      if (!response) throw connectionError ?? new Error('No reachable validated address');
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        const location = response.headers.location;
        response.destroy();
        response = undefined;
        if (!location) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Redirect without Location header' });
        if (hop === maxRedirects) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Too many redirects' });
        try { current = new URL(location, policy.url).toString(); }
        catch { throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Malformed redirect URL' }); }
        continue;
      }
      break;
    }
    if (!response || !response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `Source returned HTTP ${response?.statusCode ?? 0}` });
    }
    const encoding = response.headers['content-encoding'];
    if (encoding && encoding.toLowerCase() !== 'identity') {
      throw new BadRequestException({ code: 'MEDIA_VALIDATION_FAILED', message: 'Compressed transfer encoding is not supported for media imports' });
    }
    const declaredLength = Number(response.headers['content-length'] ?? '0');
    if (declaredLength > options.maxBytes) {
      throw new BadRequestException({ code: 'MEDIA_VALIDATION_FAILED', message: `Remote file declares ${declaredLength} bytes, above the limit of ${options.maxBytes}` });
    }
    const contentType = response.headers['content-type'] ?? null;
    let written = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        if (written > options.maxBytes) callback(new DownloadLimitError(`Download exceeded the maximum of ${options.maxBytes} bytes`));
        else callback(null, chunk);
      },
    });
    const handle = await open(temporaryPath, 'wx', 0o600);
    ownsTemporaryFile = true;
    try {
      await pipeline(response, counter, handle.createWriteStream(), { signal: controller.signal });
    } finally {
      // createWriteStream normally closes the handle; close also covers early failure.
      await handle.close().catch(() => undefined);
    }
    controller.signal.throwIfAborted();
    await rename(temporaryPath, destinationPath);
    ownsTemporaryFile = false;
    return { sizeBytes: written, contentType, finalUrl: current };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    if (controller.signal.aborted) {
      throw new BadRequestException({ code: 'MEDIA_VALIDATION_FAILED', message: 'Remote download exceeded its deadline' });
    }
    // Network and filesystem exceptions can contain internal addresses or paths.
    throw new BadRequestException({ code: 'MEDIA_VALIDATION_FAILED', message: error instanceof DownloadLimitError ? error.message : 'Remote download failed' });
  } finally {
    clearTimeout(timer);
    response?.destroy();
    if (ownsTemporaryFile) await rm(temporaryPath, { force: true });
  }
}
