import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { CustomOpenAIClient } from '@librechat/agents';
import type { ServerRequest } from '~/types';
import { createOpenAISkillResourcePrimer } from './bundles';
import type { PrimeSkillFilesParams, SkillFileRecord } from './skillFiles';

const skill: PrimeSkillFilesParams['skill'] = {
  _id: 'skill-1',
  name: 'reports',
  version: 7,
  body: '# Reports\nUse scripts/render.py.',
};
const binary = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
const files: SkillFileRecord[] = [
  {
    relativePath: 'assets/échantillon.bin',
    filename: 'échantillon.bin',
    filepath: '/storage/sample.bin',
    source: 'local',
    bytes: binary.length,
  },
];

interface RemoteState {
  bytes?: Buffer;
  filename?: string;
  fileId?: string;
  path?: string;
  uploads: number;
  uploadFailures: number;
}

const run = promisify(execFile);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(state: RemoteState = { uploads: 0, uploadFailures: 0 }) {
  const fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/containers/cntr_bundle/files') && init?.method?.toUpperCase() === 'POST') {
      state.uploads++;
      if (state.uploadFailures-- > 0) {
        return json({ error: { message: 'try again', type: 'server_error' } }, 500);
      }
      const form = init.body;
      if (!(form instanceof FormData)) throw new Error('Expected multipart form data');
      const upload = form.get('file');
      if (!(upload instanceof File)) throw new Error('Expected a file upload');
      state.bytes = Buffer.from(await upload.arrayBuffer());
      state.filename = upload.name;
      state.fileId = `file-${state.uploads}`;
      state.path = `/mnt/data/123e4567-${upload.name}`;
      return json({
        id: state.fileId,
        bytes: upload.size,
        container_id: 'cntr_bundle',
        created_at: 1,
        object: 'container.file',
        path: state.path,
        source: 'user',
      });
    }
    if (href.includes('/containers/cntr_bundle/files?')) {
      return json({
        object: 'list',
        data:
          state.bytes && state.filename && state.fileId && state.path
            ? [
                {
                  id: state.fileId,
                  bytes: state.bytes.length,
                  container_id: 'cntr_bundle',
                  created_at: 1,
                  object: 'container.file',
                  path: state.path,
                  source: 'user',
                },
              ]
            : [],
        first_id: state.fileId ?? null,
        last_id: state.fileId ?? null,
        has_more: false,
      });
    }
    if (href.endsWith('/content') && state.bytes) {
      return new Response(new Uint8Array(state.bytes));
    }
    throw new Error(`Unexpected request: ${init?.method} ${href}`);
  });
  const client = new CustomOpenAIClient({
    apiKey: 'test-key',
    baseURL: 'https://openai.example/v1',
    fetch,
    maxRetries: 0,
  });
  const getStrategyFunctions: PrimeSkillFilesParams['getStrategyFunctions'] = () => ({
    getDownloadStream: async () => Readable.from(binary),
  });
  const makePrimer = (signal = new AbortController().signal) =>
    createOpenAISkillResourcePrimer({
      client,
      containerId: 'cntr_bundle',
      req: {} as ServerRequest,
      getStrategyFunctions,
      signal,
      retryDelayMs: 0,
    });
  return { state, fetch, makePrimer };
}

describe('OpenAI skill resource bundles', () => {
  it('uploads an executable deterministic ZIP with exact binary bytes and reuses verified copies', async () => {
    const s = setup();
    const first = await s.makePrimer().ensureSkill(skill, files);

    expect(s.state.uploads).toBe(1);
    expect(first.archivePath).toBe(`/mnt/data/123e4567-${s.state.filename}`);
    expect(first.skillRoot).toBe(
      `/mnt/data/.librechat/bundles/${first.bundleDigest}/skills/reports`,
    );
    expect(first.instructions).toContain(first.archiveSha256);
    expect(first.instructions).toContain(`runpy.run_path`);
    expect(first.instructions).not.toContain(skill.body);

    const archive = await JSZip.loadAsync(s.state.bytes as Buffer);
    expect(await archive.file('skills/reports/SKILL.md')?.async('string')).toBe(skill.body);
    expect(
      Buffer.from(
        (await archive.file('skills/reports/assets/échantillon.bin')?.async('uint8array')) ?? [],
      ),
    ).toEqual(binary);
    expect(await archive.file('__main__.py')?.async('string')).toContain(
      'manifest digest mismatch',
    );
    const manifest = JSON.parse(
      (await archive.file(`.librechat/${first.bundleDigest}/manifest.json`)?.async('string')) ??
        '{}',
    ) as { bundle_digest?: string; files?: Array<{ path: string; sha256: string }> };
    expect(manifest.bundle_digest).toBe(first.bundleDigest);
    expect(manifest.files?.map((file) => file.path)).toEqual([
      'skills/reports/SKILL.md',
      'skills/reports/assets/échantillon.bin',
    ]);

    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'librechat-skill-'));
    try {
      const main = await archive.file('__main__.py')?.async('string');
      if (!main) throw new Error('Missing ZIP bootstrap');
      archive.file(
        '__main__.py',
        main.replace("pathlib.Path('/mnt/data')", `pathlib.Path(${JSON.stringify(temporaryRoot)})`),
      );
      const executable = await archive.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
      const executablePath = path.join(temporaryRoot, 'skill.zip');
      const digest = createHash('sha256').update(executable).digest('hex');
      await writeFile(executablePath, executable);
      await run('python3', [
        '-c',
        "import hashlib,runpy,sys;p=sys.argv[1];assert hashlib.sha256(open(p,'rb').read()).hexdigest()==sys.argv[2];runpy.run_path(p,run_name='__main__')",
        executablePath,
        digest,
      ]);
      const installedPath = path.join(
        temporaryRoot,
        '.librechat',
        'bundles',
        first.bundleDigest,
        'skills',
        'reports',
        'assets',
        'échantillon.bin',
      );
      expect(await readFile(installedPath)).toEqual(binary);
      expect((await stat(installedPath)).mode & 0o222).toBe(0);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }

    const samePrimer = s.makePrimer();
    const cached = await samePrimer.ensureSkill(skill, files);
    expect(cached).toEqual(first);
    expect(s.state.uploads).toBe(1);
  });

  it('rejects a changed remote archive, retries transient uploads, and honors cancellation', async () => {
    const s = setup({ uploads: 0, uploadFailures: 1 });
    const primer = s.makePrimer();
    const first = await primer.ensureSkill(skill, files);
    expect(s.state.uploads).toBe(2);

    s.state.bytes = Buffer.from('mutated');
    const replaced = await primer.ensureSkill(skill, files);
    expect(s.state.uploads).toBe(3);
    expect(replaced.archiveSha256).toBe(first.archiveSha256);

    const controller = new AbortController();
    controller.abort();
    await expect(s.makePrimer(controller.signal).ensureSkill(skill, files)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(s.state.uploads).toBe(3);
  });

  it.each(['../secret.py', '/absolute.py', 'dir\\..\\secret.py'])(
    'rejects unsafe resource path %s before upload',
    async (relativePath) => {
      const s = setup();
      await expect(
        s.makePrimer().ensureSkill(skill, [{ ...files[0], relativePath }]),
      ).rejects.toThrow('Invalid skill resource path');
      expect(s.state.uploads).toBe(0);
    },
  );
});
