import axios from 'axios';
import JSZip from 'jszip';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import FormData from 'form-data';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { FileSources } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { resolveUploadErrorMessage } from '~/utils/files';
import { parseTextNative, parseText } from './text';

const pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const req = { user: { id: 'user123' } } as ServerRequest;
const savedRagUrl = process.env.RAG_API_URL;
const savedJwtSecret = process.env.JWT_SECRET;

describe('text extraction', () => {
  let directory: string;
  let pptx: Buffer;
  let responseData: { text?: string | null | number } | null;
  let extractionFailure: Error | undefined;

  const file = async (
    originalname: string,
    mimetype: string,
    content: string | Buffer,
  ): Promise<Express.Multer.File> => {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const path = join(directory, originalname);
    await writeFile(path, buffer);
    return {
      originalname,
      mimetype,
      path,
      size: buffer.length,
      fieldname: 'file',
      encoding: '7bit',
      destination: directory,
      filename: originalname,
      buffer,
      stream: Readable.from(buffer),
    };
  };

  const parse = (file: Express.Multer.File) => parseText({ req, file, file_id: 'file123' });

  beforeAll(async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:t>Readable slide content</a:t>');
    pptx = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'librechat-text-'));
    delete process.env.RAG_API_URL;
    process.env.JWT_SECRET = 'text-extraction-test-secret';
    responseData = { text: 'Extracted document content' };
    extractionFailure = undefined;
    jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, statusText: 'OK' });
    jest.spyOn(axios, 'post').mockImplementation(async (_url, data) => {
      if (!(data instanceof FormData)) {
        throw new Error('Expected a multipart document upload');
      }
      await new Promise<void>((resolve, reject) => {
        data.on('end', resolve);
        data.on('error', reject);
        data.resume();
      });
      if (extractionFailure) {
        throw extractionFailure;
      }
      return { status: 200, data: responseData };
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    if (savedRagUrl === undefined) delete process.env.RAG_API_URL;
    else process.env.RAG_API_URL = savedRagUrl;
    if (savedJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedJwtSecret;
  });

  it.each([
    ['notes.txt', 'text/plain'],
    ['rows.csv', 'application/csv'],
    ['data.json', 'application/json'],
    ['data.json', 'application/ld+json'],
    ['config.yaml', 'application/yaml'],
    ['query.sql', 'application/sql'],
    ['source.ts', 'application/typescript'],
    ['source.py', 'application/octet-stream'],
    ['data.xml', 'application/xml'],
    ['diagram.svg', 'image/svg+xml'],
    ['diagram.svg', 'image/svg'],
    ['notes.txt', ' TEXT/PLAIN ; charset=UTF-8 '],
    ['notes.txt', ''],
    ['Dockerfile', 'application/octet-stream'],
    ['settings.env', ''],
  ])('reads UTF-8 text without an extractor (%s, %s)', async (name, mimetype) => {
    const content = 'Français 日本語 😀\n\tTexte\r\n';
    expect(await parse(await file(name, mimetype, content))).toEqual({
      text: content,
      bytes: Buffer.byteLength(content),
      source: FileSources.text,
    });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it.each([
    ['notes.md', 'text/markdown'],
    ['notes.md', 'text/x-markdown'],
    ['notes', 'text/md'],
    ['notes.md', 'application/markdown'],
    ['notes.md', 'application/x-markdown'],
    ['README.md', 'application/octet-stream'],
    ['GUIDE.MARKDOWN', 'application/octet-stream'],
    ['post.mdown', 'application/octet-stream'],
    ['post.mkdn', 'application/octet-stream'],
    ['post.mkd', 'application/octet-stream'],
    ['docs.mdwn', 'application/octet-stream'],
    ['notes', 'text/markdown; charset=utf-8'],
    ['notes', 'TEXT/MARKDOWN'],
    ['notes.md', ''],
  ])('preserves raw Markdown without calling RAG (%s, %s)', async (name, mimetype) => {
    process.env.RAG_API_URL = 'http://rag-api.test';
    const content = '# Heading\n\n**bold** text';
    expect((await parse(await file(name, mimetype, content))).text).toBe(content);
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it.each([
    ['slides.pptx', pptxMime],
    ['slides.pptx', 'text/plain'],
    ['slides.pptx', 'application/octet-stream'],
    ['slides.pptx', ''],
    ['archive.zip', 'application/zip'],
    ['archive.txt', 'text/plain'],
    ['archive.md', 'text/markdown'],
    ['archive', 'application/octet-stream'],
  ])('rejects a real archive instead of returning ZIP bytes (%s, %s)', async (name, mimetype) => {
    await expect(parse(await file(name, mimetype, pptx))).rejects.toThrow(
      `Unable to extract text from "${name}"`,
    );
  });

  it.each([
    Buffer.from([0xc3, 0x28]),
    Buffer.from([0x61, 0xc3]),
    Buffer.from('text\0binary'),
    Buffer.from('text\u0001binary'),
    Buffer.from('text\u007fbinary'),
    Buffer.from('%PDF-1.7\n1 0 obj\nASCII PDF objects'),
    Buffer.from('{\\rtf1\\ansi Rich text}'),
  ])('rejects unreadable content even with text metadata (%p)', async (content) => {
    await expect(parse(await file('document.txt', 'text/plain', content))).rejects.toThrow(
      'Convert it to a PDF containing selectable text or a UTF-8 TXT file',
    );
  });

  it('validates the entire file rather than a text-looking prefix', async () => {
    const content = Buffer.concat([Buffer.alloc(128 * 1024, 'a'), Buffer.from([0xff])]);
    await expect(parse(await file('large.txt', 'text/plain', content))).rejects.toThrow(
      'Unable to extract text',
    );
  });

  it('preserves the actionable error through upload error handling', async () => {
    const document = await file('slides.pptx', pptxMime, pptx);
    const error = await parse(document).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(resolveUploadErrorMessage(error as Error)).toBe(
      'Unable to extract text from "slides.pptx". ' +
        'No compatible text extractor succeeded for this file. ' +
        'Convert it to a PDF containing selectable text or a UTF-8 TXT file, ' +
        'or use a model that supports this format directly.',
    );
  });

  it('preserves a UTF-8 BOM and a multibyte character split across stream chunks', async () => {
    const content = '\uFEFF' + 'a'.repeat(64 * 1024 - 4) + '😀é';
    const result = await parseTextNative(await file('large.txt', 'text/plain', content));
    expect(result.text).toBe(content);
    expect(result.bytes).toBe(Buffer.byteLength(content));
  });

  it('allows empty plain text files', async () => {
    expect(await parse(await file('empty.txt', 'text/plain', ''))).toEqual({
      text: '',
      bytes: 0,
      source: FileSources.text,
    });
  });

  it('preserves filesystem errors', async () => {
    const missingFile = await file('missing.txt', 'text/plain', 'text');
    await rm(missingFile.path);
    await expect(parseTextNative(missingFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a binary document when the configured extractor returns text', async () => {
    process.env.RAG_API_URL = 'http://rag-api.test';
    responseData = { text: 'Readable slide content' };
    expect(await parse(await file('slides.pptx', pptxMime, pptx))).toEqual({
      text: 'Readable slide content',
      bytes: 22,
      source: FileSources.text,
    });
    expect(axios.post).toHaveBeenCalledWith(
      'http://rag-api.test/text',
      expect.any(Object),
      expect.objectContaining({ timeout: 300000 }),
    );
  });

  it.each(['health error', 'unhealthy', 'extraction error', 'missing user'])(
    'falls back only for actual text when RAG has %s',
    async (failure) => {
      process.env.RAG_API_URL = 'http://rag-api.test';
      if (failure === 'health error') {
        jest.mocked(axios.get).mockRejectedValue(new Error('Offline'));
      } else if (failure === 'unhealthy') {
        jest.mocked(axios.get).mockResolvedValue({ status: 503, statusText: 'Unavailable' });
      } else if (failure === 'extraction error') {
        extractionFailure = new Error('Unsupported format');
      }
      const request = failure === 'missing user' ? ({} as ServerRequest) : req;
      const parseWithRequest = (file: Express.Multer.File) =>
        parseText({ req: request, file, file_id: 'file123' });
      await expect(parseWithRequest(await file('slides.pptx', pptxMime, pptx))).rejects.toThrow(
        'Unable to extract text',
      );
      expect((await parseWithRequest(await file('notes.txt', 'text/plain', 'Text'))).text).toBe(
        'Text',
      );
    },
  );

  it.each([
    null,
    {},
    { text: null },
    { text: 123 },
    { text: '' },
    { text: ' \n\t' },
    { text: '\0' },
  ])('rejects a binary document when extraction returns unusable output (%p)', async (data) => {
    process.env.RAG_API_URL = 'http://rag-api.test';
    responseData = data;
    await expect(parse(await file('slides.pptx', pptxMime, pptx))).rejects.toThrow(
      'Unable to extract text',
    );
  });

  it('uses native text when RAG returns malformed output for a text file', async () => {
    process.env.RAG_API_URL = 'http://rag-api.test';
    responseData = {};
    expect((await parse(await file('notes.txt', 'text/plain', 'Native text'))).text).toBe(
      'Native text',
    );
  });

  it('preserves empty text returned by RAG for a plain text file', async () => {
    process.env.RAG_API_URL = 'http://rag-api.test';
    responseData = { text: '' };
    expect((await parse(await file('empty.txt', 'text/plain', ''))).text).toBe('');
  });
});
