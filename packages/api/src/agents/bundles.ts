import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import type { CustomOpenAIClient } from '@librechat/agents';
import type { ServerRequest } from '~/types';
import type { PrimeSkillFilesParams, SkillFileRecord } from './skillFiles';
import {
  sha256,
  throwIfAborted,
  readTransferBuffer,
  listContainerFiles,
  verifyContainerFile,
  findVerifiedContainerFile,
} from './transfer';

const DEFAULT_MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_BUNDLE_FILES = 512;
const MAX_LOCAL_CACHE_ENTRIES = 128;
const FIXED_ZIP_DATE = new Date('1980-01-01T00:00:00.000Z');

interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface SkillBundle {
  archive: Buffer;
  archiveFilename: string;
  archiveSha256: string;
  bundleDigest: string;
  skillRoot: string;
}

export interface OpenAISkillResourcePrime {
  containerId: string;
  bundleDigest: string;
  archiveSha256: string;
  archiveFileId: string;
  archivePath: string;
  skillRoot: string;
  instructions: string;
}

export interface OpenAISkillResourcePrimer {
  ensureSkill(
    skill: PrimeSkillFilesParams['skill'],
    skillFiles: SkillFileRecord[],
  ): Promise<OpenAISkillResourcePrime>;
}

export interface OpenAISkillResourcePrimerOptions {
  client: CustomOpenAIClient;
  containerId: string;
  req: ServerRequest;
  getStrategyFunctions: PrimeSkillFilesParams['getStrategyFunctions'];
  signal: AbortSignal;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxBundleBytes?: number;
}

interface RemoteArchive {
  id: string;
  path: string;
}

function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeSkillName(name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new Error(`Invalid skill name: ${JSON.stringify(name)}`);
  }
  return name;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0'),
    )
  ) {
    throw new Error(`Invalid skill resource path: ${JSON.stringify(value)}`);
  }
  return segments.join('/');
}

function bootstrapSource(bundleDigest: string): string {
  return `import hashlib
import json
import os
import pathlib
import sys
import zipfile

ROOT = pathlib.Path('/mnt/data').resolve()
DIGEST = ${JSON.stringify(bundleDigest)}
MANIFEST_PATH = '.librechat/' + DIGEST + '/manifest.json'
INSTALL_ROOT = (ROOT / '.librechat' / 'bundles' / DIGEST).resolve()

def fail(message):
    raise RuntimeError('LibreChat skill bundle: ' + message)

with zipfile.ZipFile(sys.argv[0], 'r') as archive:
    manifest = json.loads(archive.read(MANIFEST_PATH))
    if manifest.get('bundle_digest') != DIGEST:
        fail('manifest digest mismatch')
    verified = []
    for item in manifest.get('files', []):
        relative = pathlib.PurePosixPath(item['path'])
        if relative.is_absolute() or '..' in relative.parts or '.' in relative.parts:
            fail('unsafe path: ' + item['path'])
        data = archive.read(item['path'])
        if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            fail('content mismatch: ' + item['path'])
        verified.append((relative, data))
    installed = []
    for relative, data in verified:
        destination = (INSTALL_ROOT / pathlib.Path(*relative.parts)).resolve()
        if INSTALL_ROOT not in destination.parents:
            fail('destination escapes workspace: ' + str(relative))
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + '.tmp-' + str(os.getpid()))
        with open(temporary, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o444)
        os.replace(temporary, destination)
        installed.append(str(destination))

receipt = ROOT / '.librechat' / 'installed' / (DIGEST + '.json')
receipt.parent.mkdir(parents=True, exist_ok=True)
temporary_receipt = receipt.with_name(receipt.name + '.tmp-' + str(os.getpid()))
with open(temporary_receipt, 'w', encoding='utf-8') as output:
    json.dump({'bundle_digest': DIGEST, 'files': installed}, output, sort_keys=True)
    output.flush()
    os.fsync(output.fileno())
os.replace(temporary_receipt, receipt)
print(json.dumps({'bundle_digest': DIGEST, 'files': installed}, sort_keys=True))
`;
}

function zipOptions() {
  return {
    createFolders: false,
    date: FIXED_ZIP_DATE,
    unixPermissions: 0o100444,
  } as const;
}

async function buildBundle(
  skill: PrimeSkillFilesParams['skill'],
  skillFiles: SkillFileRecord[],
  req: ServerRequest,
  getStrategyFunctions: PrimeSkillFilesParams['getStrategyFunctions'],
  maxBundleBytes: number,
  signal: AbortSignal,
): Promise<SkillBundle> {
  throwIfAborted(signal);
  const skillName = normalizeSkillName(skill.name);
  if (skillFiles.length + 1 > MAX_BUNDLE_FILES) {
    throw new Error(`Skill resource bundle exceeds ${MAX_BUNDLE_FILES} files`);
  }

  const contents = new Map<string, Buffer>();
  const skillPath = `skills/${skillName}/SKILL.md`;
  const body = Buffer.from(skill.body, 'utf8');
  if (body.length > maxBundleBytes) {
    throw new Error(`Skill resource bundle exceeds ${maxBundleBytes} bytes`);
  }
  contents.set(skillPath, body);
  let totalBytes = body.length;

  const orderedFiles = [...skillFiles].sort((left, right) =>
    comparePaths(left.relativePath, right.relativePath),
  );
  for (const file of orderedFiles) {
    throwIfAborted(signal);
    const relativePath = normalizeRelativePath(file.relativePath);
    const archivePath = `skills/${skillName}/${relativePath}`;
    if (contents.has(archivePath)) {
      throw new Error(`Duplicate skill resource path: ${file.relativePath}`);
    }
    const strategy = getStrategyFunctions(file.source);
    if (!strategy.getDownloadStream) {
      throw new Error(`No download stream for skill resource: ${file.relativePath}`);
    }
    const stream = await strategy.getDownloadStream(req, file.filepath);
    const content = await readTransferBuffer(stream, maxBundleBytes - totalBytes, signal);
    totalBytes += content.length;
    contents.set(archivePath, content);
  }

  const files: ManifestFile[] = [...contents]
    .sort(([left], [right]) => comparePaths(left, right))
    .map(([filePath, content]) => ({
      path: filePath,
      bytes: content.length,
      sha256: sha256(content),
    }));
  const metadata = {
    schema: 1,
    skill: { id: skill._id.toString(), name: skill.name, version: skill.version },
    files,
  };
  const bundleDigest = sha256(JSON.stringify(metadata));
  const manifest = JSON.stringify({ ...metadata, bundle_digest: bundleDigest });

  const zip = new JSZip();
  zip.file('__main__.py', bootstrapSource(bundleDigest), zipOptions());
  zip.file(`.librechat/${bundleDigest}/manifest.json`, manifest, zipOptions());
  for (const [filePath, content] of [...contents].sort(([left], [right]) =>
    comparePaths(left, right),
  )) {
    zip.file(filePath, content, zipOptions());
  }
  const archive = await zip.generateAsync({
    type: 'nodebuffer',
    platform: 'UNIX',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'skill';
  return {
    archive,
    archiveFilename: `librechat-skill-${safeName}-${bundleDigest}.zip`,
    archiveSha256: sha256(archive),
    bundleDigest,
    skillRoot: `/mnt/data/.librechat/bundles/${bundleDigest}/skills/${skillName}`,
  };
}

function retryable(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (typeof error !== 'object' || error === null || !('status' in error)) return true;
  const status = (error as { status?: unknown }).status;
  return (
    typeof status !== 'number' ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (delayMs <= 0) return;
  try {
    await delay(delayMs, undefined, { signal });
  } catch (error) {
    throwIfAborted(signal, error);
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function makeResult(
  containerId: string,
  bundle: SkillBundle,
  remote: RemoteArchive,
): OpenAISkillResourcePrime {
  return {
    containerId,
    bundleDigest: bundle.bundleDigest,
    archiveSha256: bundle.archiveSha256,
    archiveFileId: remote.id,
    archivePath: remote.path,
    skillRoot: bundle.skillRoot,
    instructions: [
      `Skill resources archive: ${remote.path}`,
      `Expected archive SHA-256: \`${bundle.archiveSha256}\`.`,
      'Before using this skill, verify and run it with:',
      `\`python3 -c "import hashlib,runpy,sys;p=sys.argv[1];assert hashlib.sha256(open(p,'rb').read()).hexdigest()==sys.argv[2];runpy.run_path(p,run_name='__main__')" ${shellQuote(remote.path)} ${shellQuote(bundle.archiveSha256)}\`.`,
      `The bootstrap verifies every SHA-256 and installs the files at \`${bundle.skillRoot}\`.`,
      'Use those files directly; do not reconstruct their contents from tool text.',
    ].join(' '),
  };
}

export function createOpenAISkillResourcePrimer({
  client,
  containerId,
  req,
  getStrategyFunctions,
  signal,
  maxAttempts = 3,
  retryDelayMs = 50,
  maxBundleBytes = DEFAULT_MAX_BUNDLE_BYTES,
}: OpenAISkillResourcePrimerOptions): OpenAISkillResourcePrimer {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }
  const cache = new Map<string, OpenAISkillResourcePrime>();
  const pending = new Map<string, Promise<OpenAISkillResourcePrime>>();
  const transfer = { client, containerId, signal };

  const withRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfAborted(signal);
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!retryable(error) || attempt === maxAttempts) throw error;
        await wait(retryDelayMs * attempt, signal);
      }
    }
    throw lastError;
  };

  const upload = async (bundle: SkillBundle): Promise<RemoteArchive> => {
    const uploaded = await withRetry(() =>
      client.containers.files.create(
        containerId,
        {
          file: new File([new Uint8Array(bundle.archive)], bundle.archiveFilename, {
            type: 'application/zip',
          }),
        },
        { signal, idempotencyKey: `${containerId}:${bundle.archiveSha256}` },
      ),
    );
    return { id: uploaded.id, path: uploaded.path };
  };

  return {
    async ensureSkill(skill, skillFiles) {
      const bundle = await buildBundle(
        skill,
        skillFiles,
        req,
        getStrategyFunctions,
        maxBundleBytes,
        signal,
      );
      const cacheKey = `${containerId}:${bundle.bundleDigest}:${bundle.archiveSha256}`;
      const active = pending.get(cacheKey);
      if (active) return active;

      const operation = (async () => {
        const expected = { bytes: bundle.archive.length, sha256: bundle.archiveSha256 };
        const cached = cache.get(cacheKey);
        if (cached) {
          const valid = await withRetry(() =>
            verifyContainerFile(transfer, cached.archiveFileId, expected),
          );
          if (valid) return cached;
          cache.delete(cacheKey);
        }
        const candidates = await withRetry(() => listContainerFiles(transfer));
        const remote =
          (await withRetry(() =>
            findVerifiedContainerFile(transfer, candidates, bundle.archiveFilename, expected),
          )) ?? (await upload(bundle));
        const result = makeResult(containerId, bundle, remote);
        if (cache.size >= MAX_LOCAL_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest) cache.delete(oldest);
        }
        cache.set(cacheKey, result);
        return result;
      })();
      pending.set(cacheKey, operation);
      try {
        return await operation;
      } finally {
        pending.delete(cacheKey);
      }
    },
  };
}
