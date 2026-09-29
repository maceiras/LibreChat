import axios from 'axios';
import FormData from 'form-data';
import { createReadStream } from 'fs';
import { logger } from '@librechat/data-schemas';
import { FileSources, inferMimeType } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { logAxiosError } from '~/utils';
import { generateShortLivedToken } from '~/crypto/jwt';

const MARKDOWN_MIME_TYPES = new Set([
  'text/markdown',
  'text/x-markdown',
  'text/md',
  'application/markdown',
  'application/x-markdown',
]);

const MARKDOWN_EXTENSIONS_RE = /\.(md|markdown|mdown|mkdn|mkd|mdwn)$/i;

const APPLICATION_TEXT_MIME_TYPES = new Set([
  ...MARKDOWN_MIME_TYPES,
  'application/csv',
  'application/ecmascript',
  'application/javascript',
  'application/sql',
  'application/toml',
  'application/typescript',
  'application/vnd.coffeescript',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-toml',
  'application/x-yaml',
  'application/yaml',
  'image/svg',
  'image/svg+xml',
]);

const BINARY_CONTROL_CHARACTERS = /(?![\t\n\r\f\v])\p{Cc}/u;

function normalizeMimeType(mimetype: string): string {
  if (!mimetype) {
    return '';
  }
  const semi = mimetype.indexOf(';');
  const base = semi === -1 ? mimetype : mimetype.slice(0, semi);
  return base.trim().toLowerCase();
}

function isMarkdownFile(file: Express.Multer.File): boolean {
  if (MARKDOWN_MIME_TYPES.has(normalizeMimeType(file.mimetype))) {
    return true;
  }
  return MARKDOWN_EXTENSIONS_RE.test(file.originalname ?? '');
}

function isPlainTextMimeType(mimetype: string): boolean {
  return (
    (mimetype.startsWith('text/') && mimetype !== 'text/rtf') ||
    APPLICATION_TEXT_MIME_TYPES.has(mimetype) ||
    /^application\/(?:[\w.+-]+\+)?(?:json|xml)$/.test(mimetype)
  );
}

function supportsNativeText(file: Express.Multer.File): boolean {
  const inferredType = inferMimeType(file.originalname, '');
  if (inferredType && !isPlainTextMimeType(inferredType)) {
    return false;
  }
  const mimetype = normalizeMimeType(file.mimetype);
  if (!mimetype || mimetype === 'application/octet-stream') {
    return !inferredType || isPlainTextMimeType(inferredType);
  }
  return isPlainTextMimeType(mimetype);
}

function extractionError(file: Express.Multer.File): Error {
  return new Error(
    `Unable to extract text from "${file.originalname}". ` +
      'No compatible text extractor succeeded for this file. ' +
      'Convert it to a PDF containing selectable text or a UTF-8 TXT file, ' +
      'or use a model that supports this format directly.',
  );
}

/**
 * Attempts to parse text using RAG API, falls back to native text parsing
 * @param params - The parameters object
 * @param params.req - The Express request object
 * @param params.file - The uploaded file
 * @param params.file_id - The file ID
 * @returns
 */
export async function parseText({
  req,
  file,
  file_id,
}: {
  req: ServerRequest;
  file: Express.Multer.File;
  file_id: string;
}): Promise<{ text: string; bytes: number; source: string }> {
  if (!process.env.RAG_API_URL) {
    logger.debug('[parseText] RAG_API_URL not defined, falling back to native text parsing');
    return parseTextNative(file);
  }

  if (isMarkdownFile(file)) {
    logger.debug(
      `[parseText] Markdown file detected (${file.originalname}, ${file.mimetype}), using native parsing to preserve raw formatting`,
    );
    return parseTextNative(file);
  }

  const userId = req.user?.id;
  if (!userId) {
    logger.debug('[parseText] No user ID provided, falling back to native text parsing');
    return parseTextNative(file);
  }

  try {
    const healthResponse = await axios.get(`${process.env.RAG_API_URL}/health`, {
      timeout: 10000,
    });
    if (healthResponse?.statusText !== 'OK' && healthResponse?.status !== 200) {
      logger.debug('[parseText] RAG API health check failed, falling back to native parsing');
      return parseTextNative(file);
    }
  } catch (healthError) {
    logAxiosError({
      message: '[parseText] RAG API health check failed, falling back to native parsing:',
      error: healthError,
    });
    return parseTextNative(file);
  }

  try {
    const jwtToken = generateShortLivedToken(userId);
    const formData = new FormData();
    formData.append('file_id', file_id);
    formData.append('file', createReadStream(file.path));

    const formHeaders = formData.getHeaders();

    const response = await axios.post(`${process.env.RAG_API_URL}/text`, formData, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        accept: 'application/json',
        ...formHeaders,
      },
      timeout: 300000,
    });

    const responseData = response.data;
    logger.debug(`[parseText] RAG API completed successfully (${response.status})`);

    if (
      typeof responseData?.text !== 'string' ||
      BINARY_CONTROL_CHARACTERS.test(responseData.text) ||
      (!responseData.text.trim() && !supportsNativeText(file))
    ) {
      throw new Error('RAG API did not return readable text');
    }

    return {
      text: responseData.text,
      bytes: Buffer.byteLength(responseData.text, 'utf8'),
      source: FileSources.text,
    };
  } catch (error) {
    logAxiosError({
      message: '[parseText] RAG API text parsing failed, falling back to native parsing',
      error,
    });
    return parseTextNative(file);
  }
}

/**
 * Read only text formats with strict UTF-8 decoding, including across chunk boundaries.
 * Binary documents require a successful specialized extractor instead of this fallback.
 * @param file - The uploaded file
 * @returns
 */
export async function parseTextNative(file: Express.Multer.File): Promise<{
  text: string;
  bytes: number;
  source: string;
}> {
  if (!supportsNativeText(file)) {
    throw extractionError(file);
  }

  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const chunks: string[] = [];
  let bytes = 0;
  const decode = (chunk?: Buffer): string => {
    let text: string;
    try {
      text = decoder.decode(chunk, { stream: chunk != null });
    } catch {
      throw extractionError(file);
    }
    if (BINARY_CONTROL_CHARACTERS.test(text)) {
      throw extractionError(file);
    }
    return text;
  };

  for await (const chunk of createReadStream(file.path) as AsyncIterable<Buffer>) {
    const text = decode(chunk);
    if (bytes === 0 && /^(?:\uFEFF)?(?:%PDF-|\{\\rtf)/.test(text)) {
      throw extractionError(file);
    }
    chunks.push(text);
    bytes += chunk.length;
  }
  chunks.push(decode());

  return {
    text: chunks.join(''),
    bytes,
    source: FileSources.text,
  };
}
