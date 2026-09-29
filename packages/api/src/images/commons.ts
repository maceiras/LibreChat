import sharp from 'sharp';
import sanitizeHtml from 'sanitize-html';

const API_URL = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'EPTMChat/1.0 (https://ia.eptm.ch)';
const DEFAULT_SEARCH_LIMIT = 6;
const MAX_SEARCH_LIMIT = 10;
const DEFAULT_IMAGE_WIDTH = 1600;
const MAX_IMAGE_WIDTH = 2400;
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;
const REQUEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
const MIME_FORMATS = new Map([
  ['image/jpeg', { format: 'jpeg', extension: 'jpg' }],
  ['image/png', { format: 'png', extension: 'png' }],
  ['image/webp', { format: 'webp', extension: 'webp' }],
]);

interface MetadataValue {
  value?: string;
}

interface CommonsMetadata {
  Artist?: MetadataValue;
  Attribution?: MetadataValue;
  Credit?: MetadataValue;
  ImageDescription?: MetadataValue;
  License?: MetadataValue;
  LicenseShortName?: MetadataValue;
  LicenseUrl?: MetadataValue;
  UsageTerms?: MetadataValue;
}

interface CommonsApiImageInfo {
  url?: string;
  thumburl?: string;
  width?: number;
  height?: number;
  mime?: string;
  descriptionurl?: string;
  extmetadata?: CommonsMetadata;
}

interface CommonsApiPage {
  pageid?: number;
  title?: string;
  imageinfo?: CommonsApiImageInfo[];
}

interface CommonsApiResponse {
  error?: {
    code?: string;
    info?: string;
  };
  query?: {
    pages?: CommonsApiPage[];
  };
}

export interface CommonsClientOptions {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

interface CommonsSearchOptions {
  query: string;
  limit?: number;
}

interface CommonsDownloadOptions {
  pageId: number;
  width?: number;
}

export interface CommonsImage {
  pageId: number;
  title: string;
  description: string;
  sourceUrl: string;
  url: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  author: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  attributionRequired: boolean;
  credit: string;
}

export interface CommonsDownload {
  image: CommonsImage;
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface CommonsClient {
  search(options: CommonsSearchOptions): Promise<CommonsImage[]>;
  download(options: CommonsDownloadOptions): Promise<CommonsDownload>;
}

export type CreateCommonsClient = (options?: CommonsClientOptions) => CommonsClient;

function decodeHtmlEntities(value: string): string {
  const named = new Map([
    ['amp', '&'],
    ['apos', "'"],
    ['gt', '>'],
    ['lt', '<'],
    ['nbsp', ' '],
    ['quot', '"'],
  ]);
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, key: string) => {
    if (key.startsWith('#')) {
      const hexadecimal = key[1]?.toLowerCase() === 'x';
      const point = Number.parseInt(key.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isSafeInteger(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    }
    return named.get(key.toLowerCase()) ?? entity;
  });
}

function cleanText(value: string | undefined, limit: number): string {
  if (!value) return '';
  const clean = sanitizeHtml(value, {
    allowedTags: [],
    allowedAttributes: {},
  });
  return decodeHtmlEntities(clean).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function completeText(value: string | undefined, limit: number): string | null {
  if (!value) return '';
  const clean = sanitizeHtml(value, {
    allowedTags: [],
    allowedAttributes: {},
  });
  const normalized = decodeHtmlEntities(clean).replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : null;
}

function metadataValue(value: MetadataValue | undefined, limit: number): string | null {
  return completeText(value?.value, limit);
}

function classifyLicense(metadata: CommonsMetadata | undefined): {
  name: string;
  attributionRequired: boolean;
  family: 'cc0' | 'cc-by' | 'cc-by-sa' | 'public-domain';
  version?: string;
} | null {
  if (!metadata) return null;
  const candidates = [
    metadataValue(metadata.LicenseShortName, 120),
    metadataValue(metadata.License, 120),
    metadataValue(metadata.UsageTerms, 120),
  ];

  for (const name of candidates) {
    if (!name) continue;
    const normalized = name
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, ' ')
      .trim();
    const cc0 = normalized.match(/^cc0(?: (1(?:\.0)?))?$/);
    if (cc0) {
      return { name, attributionRequired: false, family: 'cc0', version: cc0[1] ?? '1.0' };
    }
    if (normalized === 'public domain') {
      return { name, attributionRequired: false, family: 'public-domain' };
    }
    const publicDomainPrefixes = [
      'pd art',
      'pd author',
      'pd chem',
      'pd ineligible',
      'pd old',
      'pd scan',
      'pd self',
      'pd shape',
      'pd simple',
      'pd textlogo',
      'pd us',
    ];
    if (normalized === 'pd') {
      return { name, attributionRequired: false, family: 'public-domain' };
    }
    if (
      publicDomainPrefixes.some(
        (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `),
      )
    ) {
      return { name, attributionRequired: false, family: 'public-domain' };
    }
    const shareAlike = normalized.match(/^cc by sa (1\.0|2\.0|2\.5|3\.0|4\.0)(?: [a-z]{2,20})?$/);
    if (shareAlike) {
      return {
        name,
        attributionRequired: true,
        family: 'cc-by-sa',
        version: shareAlike[1],
      };
    }
    const attribution = normalized.match(/^cc by (1\.0|2\.0|2\.5|3\.0|4\.0)(?: [a-z]{2,20})?$/);
    if (attribution) {
      return {
        name,
        attributionRequired: true,
        family: 'cc-by',
        version: attribution[1],
      };
    }
  }
  return null;
}

function normalizeLicenseUrl(
  value: MetadataValue | undefined,
  license: NonNullable<ReturnType<typeof classifyLicense>>,
): string | null {
  const clean = completeText(value?.value, 500);
  if (clean === null) return null;
  if (!clean) return license.family === 'public-domain' ? '' : null;
  try {
    const url = new URL(clean, 'https://creativecommons.org');
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (
      url.protocol !== 'https:' ||
      !['creativecommons.org', 'www.creativecommons.org'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    ) {
      return license.family === 'public-domain' ? '' : null;
    }
    const version = license.version?.replace('.', '\\.');
    const path = url.pathname.toLowerCase();
    if (license.family === 'cc0') {
      return /^\/publicdomain\/zero\/1\.0(?:\/|$)/.test(path) ? url.toString() : null;
    }
    if (license.family === 'public-domain') {
      return /^\/publicdomain\/(?:mark|zero)\/1\.0(?:\/|$)/.test(path) ? url.toString() : '';
    }
    if (!license.version) return null;
    const family = license.family === 'cc-by-sa' ? 'by-sa' : 'by';
    const compatible = new RegExp(`^/licenses/${family}/${version}(?:/|$)`);
    return compatible.test(path) ? url.toString() : null;
  } catch {
    return license.family === 'public-domain' ? '' : null;
  }
}

function isTrustedDownloadUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      DOWNLOAD_HOSTS.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname.startsWith('/wikipedia/commons/')
    );
  } catch {
    return false;
  }
}

function isTrustedSourceUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'commons.wikimedia.org' &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

function positiveDimension(value: number | undefined): value is number {
  return Number.isInteger(value) && value !== undefined && value > 0;
}

function mapImage(page: CommonsApiPage): CommonsImage | null {
  const info = page.imageinfo?.[0];
  const metadata = info?.extmetadata;
  const license = classifyLicense(metadata);
  const title = completeText(page.title, 300);
  const licenseUrl = license ? normalizeLicenseUrl(metadata?.LicenseUrl, license) : null;
  if (
    !info ||
    !license ||
    licenseUrl === null ||
    !Number.isInteger(page.pageid) ||
    !page.pageid ||
    !title ||
    !info.mime ||
    !MIME_FORMATS.has(info.mime.toLowerCase()) ||
    !positiveDimension(info.width) ||
    !positiveDimension(info.height) ||
    !isTrustedDownloadUrl(info.url) ||
    !isTrustedSourceUrl(info.descriptionurl)
  ) {
    return null;
  }

  const author = metadataValue(metadata?.Artist, 2000);
  const suppliedAttribution = metadataValue(metadata?.Attribution, 4000);
  const credit = metadataValue(metadata?.Credit, 2000);
  if (author === null || suppliedAttribution === null || credit === null) return null;
  if (license.attributionRequired && !author && !suppliedAttribution) return null;
  const attributionParts = [suppliedAttribution || author, credit, license.name].filter(Boolean);
  const attribution = [...new Set(attributionParts)].join(' — ');
  if (attribution.length > 6000) return null;

  return {
    pageId: page.pageid,
    title,
    description: cleanText(metadata?.ImageDescription?.value, 1000),
    sourceUrl: info.descriptionurl,
    url: info.url,
    thumbnailUrl: isTrustedDownloadUrl(info.thumburl) ? info.thumburl : info.url,
    width: info.width,
    height: info.height,
    author,
    license: license.name,
    licenseUrl,
    attribution,
    attributionRequired: license.attributionRequired,
    credit,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
}

function normalizeWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) return DEFAULT_IMAGE_WIDTH;
  return Math.min(MAX_IMAGE_WIDTH, Math.max(320, Math.floor(width)));
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function withRequestSignal<T>(
  outerSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(outerSignal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(outerSignal?.reason);
  const timeout = setTimeout(
    () => controller.abort(new Error('Wikimedia Commons request timed out')),
    REQUEST_TIMEOUT_MS,
  );
  outerSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await operation(controller.signal);
  } catch (error) {
    throwIfAborted(outerSignal);
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

async function readResponseBuffer(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!response.body) throw new Error('Wikimedia Commons returned an empty response');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new RangeError(`Wikimedia Commons response exceeds ${limit} bytes`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const onAbort = () => void reader.cancel(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) return Buffer.concat(chunks, bytes);
      bytes += value.byteLength;
      if (bytes > limit) throw new RangeError(`Wikimedia Commons response exceeds ${limit} bytes`);
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function assertResponse(response: Response, purpose: string): void {
  if (response.redirected) throw new Error(`Wikimedia Commons ${purpose} unexpectedly redirected`);
  if (!response.ok) {
    throw new Error(`Wikimedia Commons ${purpose} failed with status ${response.status}`);
  }
}

async function fetchApi(
  fetcher: typeof globalThis.fetch,
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<CommonsApiResponse> {
  const url = new URL(API_URL);
  url.search = params.toString();
  const response = await fetcher(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    redirect: 'error',
    signal,
  });
  assertResponse(response, 'API request');
  const body = await readResponseBuffer(response, MAX_API_BYTES, signal);
  try {
    const result = JSON.parse(body.toString('utf8')) as CommonsApiResponse;
    if (result.error) {
      throw new Error(
        `Wikimedia Commons API error: ${result.error.info || result.error.code || 'unknown error'}`,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Wikimedia Commons returned invalid JSON');
    throw error;
  }
}

function imageInfoParams(): URLSearchParams {
  return new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: String(DEFAULT_IMAGE_WIDTH),
    origin: '*',
    prop: 'imageinfo',
  });
}

function mapPages(response: CommonsApiResponse): CommonsImage[] {
  return (response.query?.pages ?? []).reduce<CommonsImage[]>((images, page) => {
    const image = mapImage(page);
    if (image) images.push(image);
    return images;
  }, []);
}

function extensionForFormat(format: string): string {
  if (format === 'jpeg') return 'jpg';
  return format;
}

export function createCommonsClient({
  signal: outerSignal,
  fetch: fetcher = globalThis.fetch.bind(globalThis),
}: CommonsClientOptions = {}): CommonsClient {
  return {
    async search({ query, limit }: CommonsSearchOptions): Promise<CommonsImage[]> {
      const cleanQuery = query.trim().slice(0, 200);
      if (!cleanQuery) throw new TypeError('Wikimedia Commons search query is required');
      const params = imageInfoParams();
      params.set('generator', 'search');
      params.set('gsrlimit', String(normalizeLimit(limit)));
      params.set('gsrnamespace', '6');
      params.set('gsrsearch', cleanQuery);
      return withRequestSignal(outerSignal, async (signal) => {
        const response = await fetchApi(fetcher, params, signal);
        return mapPages(response);
      });
    },

    async download({ pageId, width }: CommonsDownloadOptions): Promise<CommonsDownload> {
      if (!Number.isInteger(pageId) || pageId <= 0) {
        throw new TypeError('A positive Wikimedia Commons page ID is required');
      }
      const imageWidth = normalizeWidth(width);
      const params = imageInfoParams();
      params.set('iiurlwidth', String(imageWidth));
      params.set('pageids', String(pageId));

      return withRequestSignal(outerSignal, async (signal) => {
        const response = await fetchApi(fetcher, params, signal);
        const image = mapPages(response)[0];
        if (!image || image.pageId !== pageId) {
          throw new Error('Wikimedia Commons image is missing or not eligible for reuse');
        }
        const downloadUrl = image.thumbnailUrl;
        if (!isTrustedDownloadUrl(downloadUrl)) {
          throw new Error('Wikimedia Commons returned an untrusted image URL');
        }
        const downloadResponse = await fetcher(downloadUrl, {
          headers: { Accept: 'image/jpeg,image/png,image/webp', 'User-Agent': USER_AGENT },
          redirect: 'error',
          signal,
        });
        assertResponse(downloadResponse, 'image download');
        const buffer = await readResponseBuffer(downloadResponse, MAX_IMAGE_BYTES, signal);
        const imageProcessor = sharp(buffer, {
          failOn: 'warning',
          limitInputPixels: MAX_IMAGE_PIXELS,
        });
        const metadata = await imageProcessor.metadata();
        const format = metadata.format ?? '';
        const mimeType = [...MIME_FORMATS.entries()].find(
          ([, value]) => value.format === format,
        )?.[0];
        if (
          !mimeType ||
          !positiveDimension(metadata.width) ||
          !positiveDimension(metadata.height)
        ) {
          throw new Error('Wikimedia Commons returned an unsupported or malformed image');
        }
        if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
          throw new Error('Wikimedia Commons image dimensions exceed the safety limit');
        }
        await imageProcessor.clone().rotate().resize(1, 1).raw().toBuffer();
        throwIfAborted(signal);
        return {
          image: {
            ...image,
            thumbnailUrl: downloadUrl,
            width: metadata.width,
            height: metadata.height,
          },
          buffer,
          filename: `commons-${pageId}.${extensionForFormat(format)}`,
          mimeType,
        };
      });
    },
  };
}
