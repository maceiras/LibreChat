import { PassThrough, Readable } from 'node:stream';
import { CustomOpenAIClient } from '@librechat/agents';
import {
  findVerifiedContainerFile,
  listContainerFiles,
  readTransferBuffer,
  sha256,
  throwIfAborted,
  verifyContainerFile,
} from './transfer';

const containerId = 'cntr_test';
const baseURL = 'https://openai.example/v1';

function openAIClient(fetch: jest.Mock): CustomOpenAIClient {
  return new CustomOpenAIClient({ apiKey: 'test-key', baseURL, fetch, maxRetries: 0 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('transfer primitives', () => {
  it('hashes strings and buffers identically', () => {
    expect(sha256('transfer')).toBe(sha256(Buffer.from('transfer')));
  });

  it('reads a Node stream up to the limit and destroys it after use', async () => {
    const source = Readable.from([Buffer.from('ab'), Buffer.from('cd')]);
    await expect(readTransferBuffer(source, 4)).resolves.toEqual(Buffer.from('abcd'));
    expect(source.destroyed).toBe(true);
  });

  it('rejects overflow and destroys the source', async () => {
    const source = Readable.from([Buffer.from('too-large')]);
    await expect(readTransferBuffer(source, 3)).rejects.toBeInstanceOf(RangeError);
    expect(source.destroyed).toBe(true);
  });

  it('aborts and destroys a stalled stream', async () => {
    const source = new PassThrough();
    const controller = new AbortController();
    const reason = new Error('cancel transfer');
    const reading = readTransferBuffer(source, 10, controller.signal);
    controller.abort(reason);

    await expect(reading).rejects.toBe(reason);
    expect(source.destroyed).toBe(true);
  });

  it('propagates either the signal reason or a received AbortError', () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    expect(() => throwIfAborted(controller.signal)).toThrow(reason);

    const providerAbort = Object.assign(new Error('provider aborted'), { name: 'AbortError' });
    expect(() => throwIfAborted(undefined, providerAbort)).toThrow(providerAbort);
    expect(() => throwIfAborted(undefined, new Error('network'))).not.toThrow();
  });
});

describe('container transfer HTTP', () => {
  it('paginates remote files but stops exactly at the 200-file cap', async () => {
    const allFiles = Array.from({ length: 250 }, (_, index) => ({
      id: `file-${index}`,
      bytes: index,
      path: `/mnt/data/file-${index}`,
    }));
    const fetch = jest.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const after = url.searchParams.get('after');
      const start = after ? Number(after.replace('file-', '')) + 1 : 0;
      const data = allFiles.slice(start, start + 100);
      return jsonResponse({
        object: 'list',
        data,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
        has_more: start + data.length < allFiles.length,
      });
    });

    const files = await listContainerFiles({ client: openAIClient(fetch), containerId });

    expect(files).toHaveLength(200);
    expect(files[199]?.id).toBe('file-199');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('treats empty, corrupt, oversized, and missing content as cache misses', async () => {
    const expected = { bytes: 4, sha256: sha256('good') };
    const fetch = jest.fn(async (input: string | URL | Request) => {
      const parts = new URL(String(input)).pathname.split('/');
      const id = parts[parts.length - 2];
      if (id === 'empty') return new Response(null);
      if (id === 'corrupt') return new Response('evil');
      if (id === 'oversized') return new Response('too-large');
      if (id === 'missing') return jsonResponse({ error: { message: 'missing' } }, 404);
      return new Response('good');
    });
    const transfer = { client: openAIClient(fetch), containerId };

    await expect(verifyContainerFile(transfer, 'good', expected)).resolves.toBe(true);
    await expect(verifyContainerFile(transfer, 'empty', expected)).resolves.toBe(false);
    await expect(verifyContainerFile(transfer, 'corrupt', expected)).resolves.toBe(false);
    await expect(verifyContainerFile(transfer, 'oversized', expected)).resolves.toBe(false);
    await expect(verifyContainerFile(transfer, 'missing', expected)).resolves.toBe(false);
  });

  it('propagates authorization, network, and cancellation failures', async () => {
    const expected = { bytes: 4, sha256: sha256('good') };
    const unauthorized = openAIClient(
      jest.fn(async () => jsonResponse({ error: { message: 'denied' } }, 401)),
    );
    await expect(
      verifyContainerFile({ client: unauthorized, containerId }, 'denied', expected),
    ).rejects.toMatchObject({ status: 401 });
    const unavailable = openAIClient(
      jest.fn(async () => jsonResponse({ error: { message: 'unavailable' } }, 500)),
    );
    await expect(
      verifyContainerFile({ client: unavailable, containerId }, 'failed', expected),
    ).rejects.toMatchObject({ status: 500 });

    const streamError = new RangeError('transport stream failed');
    const brokenStream = openAIClient(
      jest.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(streamError);
              },
            }),
          ),
      ),
    );
    await expect(
      verifyContainerFile({ client: brokenStream, containerId }, 'broken', expected),
    ).rejects.toBe(streamError);

    const networkError = new Error('connection lost');
    const disconnected = openAIClient(jest.fn(async () => Promise.reject(networkError)));
    await expect(
      verifyContainerFile({ client: disconnected, containerId }, 'offline', expected),
    ).rejects.toMatchObject({ message: 'Connection error.', cause: networkError });

    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(
      verifyContainerFile(
        { client: disconnected, containerId, signal: controller.signal },
        'unused',
        expected,
      ),
    ).rejects.toBe(reason);
  });

  it('verifies exact and provider-prefixed filenames before returning a match', async () => {
    const expected = { bytes: 4, sha256: sha256('good') };
    const fetch = jest.fn(async (input: string | URL | Request) => {
      const parts = new URL(String(input)).pathname.split('/');
      const id = parts[parts.length - 2];
      return new Response(id === 'verified' ? 'good' : 'evil');
    });
    const files = [
      { id: 'wrong-size', bytes: 3, path: '/mnt/data/report.zip' },
      { id: 'wrong-name', bytes: 4, path: '/mnt/data/other.zip' },
      { id: 'corrupt', bytes: 4, path: '/mnt/data/report.zip' },
      { id: 'verified', bytes: 4, path: '/mnt/data/provider-report.zip' },
    ];

    await expect(
      findVerifiedContainerFile(
        { client: openAIClient(fetch), containerId },
        files,
        'report.zip',
        expected,
      ),
    ).resolves.toEqual(files[3]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
