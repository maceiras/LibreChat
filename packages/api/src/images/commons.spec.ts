import sharp from 'sharp';
import { createCommonsClient } from './commons';

const originalUrl = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Matterhorn.jpg';
const thumbnailUrl =
  'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Matterhorn.jpg/1600px-Matterhorn.jpg';

function metadata(
  overrides: {
    credit?: string;
    license?: string;
    licenseUrl?: string | null;
    url?: string;
    thumbnail?: string;
  } = {},
) {
  return {
    query: {
      pages: [
        {
          pageid: 42,
          title: 'File:Matterhorn.jpg',
          imageinfo: [
            {
              url: overrides.url ?? originalUrl,
              thumburl: overrides.thumbnail ?? thumbnailUrl,
              width: 4000,
              height: 3000,
              mime: 'image/jpeg',
              descriptionurl: 'https://commons.wikimedia.org/wiki/File:Matterhorn.jpg',
              extmetadata: {
                Artist: { value: '<b>Alice &amp; Bob</b>' },
                Attribution: { value: '<span>Alice &amp; Bob / Wikimedia Commons</span>' },
                ImageDescription: { value: '<p>The <b>Matterhorn</b> in winter.</p>' },
                LicenseShortName: { value: overrides.license ?? 'CC BY-SA 4.0' },
                ...(overrides.credit ? { Credit: { value: overrides.credit } } : {}),
                ...(overrides.licenseUrl === null
                  ? {}
                  : {
                      LicenseUrl: {
                        value:
                          overrides.licenseUrl ?? 'http://creativecommons.org/licenses/by-sa/4.0/',
                      },
                    }),
              },
            },
          ],
        },
      ],
    },
  };
}

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function createFetchMock(handler: FetchHandler) {
  return Object.assign(jest.fn(handler), { preconnect: jest.fn() });
}

describe('Wikimedia Commons client', () => {
  it('searches reusable raster images and returns bounded plain metadata', async () => {
    const fetch = createFetchMock(async () => jsonResponse(metadata()));
    const client = createCommonsClient({ fetch });

    await expect(client.search({ query: '  Matterhorn winter  ', limit: 50 })).resolves.toEqual([
      {
        pageId: 42,
        title: 'File:Matterhorn.jpg',
        description: 'The Matterhorn in winter.',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Matterhorn.jpg',
        url: originalUrl,
        thumbnailUrl,
        width: 4000,
        height: 3000,
        author: 'Alice & Bob',
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        attribution: 'Alice & Bob / Wikimedia Commons — CC BY-SA 4.0',
        attributionRequired: true,
        credit: '',
      },
    ]);

    const [request, init] = fetch.mock.calls[0] ?? [];
    const url = new URL(String(request));
    expect(url.origin + url.pathname).toBe('https://commons.wikimedia.org/w/api.php');
    expect(url.searchParams.get('gsrnamespace')).toBe('6');
    expect(url.searchParams.get('gsrsearch')).toBe('Matterhorn winter');
    expect(url.searchParams.get('gsrlimit')).toBe('10');
    expect(new Headers(init?.headers).get('user-agent')).toBe('EPTMChat/1.0 (https://ia.eptm.ch)');
    expect(init?.redirect).toBe('error');
  });

  it('requeries by page ID, downloads a trusted thumbnail, and validates its real dimensions', async () => {
    const jpeg = await sharp({
      create: { width: 32, height: 24, channels: 3, background: '#447799' },
    })
      .jpeg()
      .toBuffer();
    const fetch = createFetchMock(async () => new Response())
      .mockImplementationOnce(async () => jsonResponse(metadata()))
      .mockImplementationOnce(async () => new Response(new Uint8Array(jpeg)));
    const client = createCommonsClient({ fetch });

    const result = await client.download({ pageId: 42, width: 1900 });

    expect(result).toMatchObject({
      filename: 'commons-42.jpg',
      mimeType: 'image/jpeg',
      image: { pageId: 42, width: 32, height: 24, thumbnailUrl },
    });
    expect(result.buffer).toEqual(jpeg);
    const apiUrl = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(apiUrl.searchParams.get('pageids')).toBe('42');
    expect(apiUrl.searchParams.get('iiurlwidth')).toBe('1900');
    expect(fetch.mock.calls[1]?.[0]).toBe(thumbnailUrl);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('filters images with missing or disallowed licenses', async () => {
    const missing = metadata({ license: '' });
    const nonCommercial = metadata({ license: 'CC BY-NC 4.0' });
    const fetch = createFetchMock(async () => new Response())
      .mockImplementationOnce(async () => jsonResponse(missing))
      .mockImplementationOnce(async () => jsonResponse(nonCommercial));
    const client = createCommonsClient({ fetch });

    await expect(client.search({ query: 'mountain' })).resolves.toEqual([]);
    await expect(client.search({ query: 'mountain' })).resolves.toEqual([]);
  });

  it('requires compatible Creative Commons license links but permits unlinked public domain works', async () => {
    const invalidHost = metadata({ licenseUrl: 'https://example.com/licenses/by-sa/4.0/' });
    const wrongFamily = metadata({ licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' });
    const publicDomain = metadata({ license: 'Public domain', licenseUrl: null });
    const portedLicense = metadata({
      license: 'CC BY-SA 2.5 Switzerland',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.5/ch/',
    });
    const fetch = createFetchMock(async () => new Response())
      .mockImplementationOnce(async () => jsonResponse(invalidHost))
      .mockImplementationOnce(async () => jsonResponse(wrongFamily))
      .mockImplementationOnce(async () => jsonResponse(publicDomain))
      .mockImplementationOnce(async () => jsonResponse(portedLicense));
    const client = createCommonsClient({ fetch });

    await expect(client.search({ query: 'mountain' })).resolves.toEqual([]);
    await expect(client.search({ query: 'mountain' })).resolves.toEqual([]);
    await expect(client.search({ query: 'mountain' })).resolves.toMatchObject([
      { pageId: 42, license: 'Public domain', licenseUrl: '', attributionRequired: false },
    ]);
    await expect(client.search({ query: 'mountain' })).resolves.toMatchObject([
      {
        pageId: 42,
        license: 'CC BY-SA 2.5 Switzerland',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.5/ch/',
      },
    ]);
  });

  it('never downloads URLs outside Wikimedia image hosts', async () => {
    const fetch = createFetchMock(async () =>
      jsonResponse(
        metadata({ url: 'https://example.com/image.jpg', thumbnail: 'https://evil.test/a.jpg' }),
      ),
    );
    const client = createCommonsClient({ fetch });

    await expect(client.download({ pageId: 42 })).rejects.toThrow('not eligible for reuse');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed image bytes after download', async () => {
    const fetch = createFetchMock(async () => new Response())
      .mockImplementationOnce(async () => jsonResponse(metadata()))
      .mockImplementationOnce(async () => new Response('not an image'));
    const client = createCommonsClient({ fetch });

    await expect(client.download({ pageId: 42 })).rejects.toThrow();
  });

  it('rejects a truncated image whose header still exposes dimensions', async () => {
    const jpeg = await sharp({
      create: { width: 128, height: 96, channels: 3, background: '#447799' },
    })
      .jpeg()
      .toBuffer();
    const truncated = jpeg.subarray(0, jpeg.length - 10);
    await expect(sharp(truncated).metadata()).resolves.toMatchObject({ width: 128, height: 96 });
    const fetch = createFetchMock(async () => new Response())
      .mockImplementationOnce(async () => jsonResponse(metadata()))
      .mockImplementationOnce(async () => new Response(new Uint8Array(truncated)));
    const client = createCommonsClient({ fetch });

    await expect(client.download({ pageId: 42 })).rejects.toThrow();
  });

  it('enforces the download body limit before reading the response', async () => {
    const fetch = createFetchMock(async () => new Response())
      .mockImplementationOnce(async () => jsonResponse(metadata()))
      .mockImplementationOnce(
        async () =>
          new Response('small', { headers: { 'content-length': String(16 * 1024 * 1024) } }),
      );
    const client = createCommonsClient({ fetch });

    await expect(client.download({ pageId: 42 })).rejects.toBeInstanceOf(RangeError);
  });

  it('enforces the download body limit when Content-Length is absent', async () => {
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.close();
      },
    });
    const fetch = createFetchMock(async () => new Response())
      .mockImplementationOnce(async () => jsonResponse(metadata()))
      .mockImplementationOnce(async () => new Response(oversizedBody));
    const client = createCommonsClient({ fetch });

    await expect(client.download({ pageId: 42 })).rejects.toBeInstanceOf(RangeError);
  });

  it('cancels a stalled image body when the caller aborts', async () => {
    const stalledBody = new ReadableStream<Uint8Array>({ start() {} });
    const fetch = createFetchMock(async () => new Response())
      .mockImplementationOnce(async () => jsonResponse(metadata()))
      .mockImplementationOnce(async () => new Response(stalledBody));
    const controller = new AbortController();
    const reason = new Error('stop image download');
    const client = createCommonsClient({ fetch, signal: controller.signal });

    const downloading = client.download({ pageId: 42 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(reason);

    await expect(downloading).rejects.toBe(reason);
  });

  it('propagates cancellation before issuing a request', async () => {
    const controller = new AbortController();
    const reason = new Error('stop Commons search');
    controller.abort(reason);
    const fetch = createFetchMock(async () => jsonResponse(metadata()));
    const client = createCommonsClient({ fetch, signal: controller.signal });

    await expect(client.search({ query: 'Matterhorn' })).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });
});
