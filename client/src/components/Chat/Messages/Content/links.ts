import { defaultUrlTransform } from 'react-markdown';
import type { TAttachment } from 'librechat-data-provider';

const SANDBOX_ROOT = 'sandbox:/mnt/data/';

const decodePath = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizePath = (value: string): string =>
  decodePath(value)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');

const basename = (value: string): string => value.split('/').pop() ?? '';

export const getSandboxArtifactPath = (href: string): string | undefined => {
  if (!href.startsWith(SANDBOX_ROOT)) {
    return undefined;
  }

  const path = normalizePath(href.slice(SANDBOX_ROOT.length).split(/[?#]/, 1)[0]);
  if (!path || path.split('/').some((segment) => segment === '.' || segment === '..')) {
    return undefined;
  }
  return path;
};

export const markdownUrlTransform = (value: string, key: string): string =>
  key === 'href' && value.startsWith('sandbox:') ? value : defaultUrlTransform(value);

export const resolveSandboxAttachment = (
  href: string,
  attachments?: TAttachment[],
): TAttachment | undefined => {
  const artifactPath = getSandboxArtifactPath(href);
  if (!artifactPath || !attachments?.length) {
    return undefined;
  }

  const downloadable = attachments.filter(
    (attachment) => attachment.filepath && attachment.filename,
  );
  const exact = downloadable.filter(
    (attachment) => normalizePath(attachment.filename ?? '') === artifactPath,
  );
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    return undefined;
  }

  const artifactName = basename(artifactPath);
  const matchingBasenames = downloadable.filter(
    (attachment) => basename(normalizePath(attachment.filename ?? '')) === artifactName,
  );
  return matchingBasenames.length === 1 ? matchingBasenames[0] : undefined;
};
