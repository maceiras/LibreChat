import { EToolResources, mergeFileConfig, getEndpointFileConfig } from 'librechat-data-provider';
import type { UploadOptions } from '../uploads';
import { getDefaultUploadToolResource } from '../uploads';

const fileConfig = mergeFileConfig({});
const defaultOptions: UploadOptions = {
  provider: 'openAI',
  contextEnabled: true,
  fileConfig,
  endpointFileConfig: getEndpointFileConfig({ endpoint: 'openAI', fileConfig }),
};

const mimeTypes: Record<string, string> = {
  'document.pdf': 'application/pdf',
  'document.PDF': 'application/pdf',
  'document.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'workbook.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'slides.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'notes.txt': 'text/plain',
  'video.mp4': 'video/mp4',
  'audio.mp3': 'audio/mpeg',
};

const sampleFile = (name: string) => ({ name, type: mimeTypes[name] ?? '' });

describe('default attachment routing', () => {
  it.each(['document.docx', 'workbook.xlsx', 'slides.pptx', 'notes.txt'])(
    'sends explicitly supported %s to the provider instead of text',
    (name) => {
      const configured = mergeFileConfig({
        endpoints: { openAI: { supportedMimeTypes: [mimeTypes[name]] } },
      });
      const endpointFileConfig = getEndpointFileConfig({
        endpoint: 'openAI',
        fileConfig: configured,
      });
      expect(
        getDefaultUploadToolResource(sampleFile(name), {
          ...defaultOptions,
          fileConfig: configured,
          endpointFileConfig,
        }),
      ).toBeUndefined();
    },
  );

  it.each([
    ['image.png', 'image/png', undefined],
    ['document.pdf', 'application/pdf', undefined],
    ['photo.HEIC', '', undefined],
    ['document.PDF', 'application/pdf', undefined],
    ['notes.txt', 'text/plain', EToolResources.context],
    ['document.docx', mimeTypes['document.docx'], EToolResources.context],
    ['workbook.xlsx', mimeTypes['workbook.xlsx'], EToolResources.context],
    ['slides.pptx', mimeTypes['slides.pptx'], EToolResources.context],
    ['unknown.unknown', '', null],
  ])('routes %s to %s', (name, type, expected) => {
    expect(getDefaultUploadToolResource({ name, type }, defaultOptions)).toBe(expected);
  });

  it.each(['document.docx', 'workbook.xlsx', 'slides.pptx', 'notes.txt'])(
    'honors a permissive provider configuration for %s',
    (name) => {
      expect(
        getDefaultUploadToolResource(sampleFile(name), {
          ...defaultOptions,
          endpointFileConfig: {
            ...defaultOptions.endpointFileConfig,
            supportedMimeTypes: [/.*/],
          },
        }),
      ).toBeUndefined();
    },
  );

  it.each([
    ['google', 'video.mp4', undefined],
    ['google', 'audio.mp3', undefined],
    ['OpenRouter', 'video.mp4', undefined],
    ['bedrock', 'document.docx', undefined],
    ['bedrock', 'workbook.xlsx', undefined],
    ['bedrock', 'slides.pptx', EToolResources.context],
    ['anthropic', 'document.docx', EToolResources.context],
    ['azureOpenAI', 'document.pdf', EToolResources.context],
    ['unknown-provider', 'document.pdf', EToolResources.context],
  ])('routes %s / %s according to provider support', (provider, name, expected) => {
    expect(getDefaultUploadToolResource(sampleFile(name), { ...defaultOptions, provider })).toBe(
      expected,
    );
  });

  it('supports Azure documents only with Responses enabled', () => {
    const options = { ...defaultOptions, provider: 'azureOpenAI', useResponsesApi: true };
    expect(getDefaultUploadToolResource(sampleFile('document.pdf'), options)).toBeUndefined();
  });

  it('uses the resolved endpoint type for custom Google gateways', () => {
    expect(
      getDefaultUploadToolResource(sampleFile('video.mp4'), {
        ...defaultOptions,
        provider: 'gateway',
        endpointType: 'google',
      }),
    ).toBeUndefined();
  });

  it('does not override Bedrock document restrictions with a permissive allowlist', () => {
    expect(
      getDefaultUploadToolResource(sampleFile('slides.pptx'), {
        ...defaultOptions,
        provider: 'bedrock',
        endpointFileConfig: { supportedMimeTypes: [/.*/] },
      }),
    ).toBe(EToolResources.context);
  });

  it('falls back to text when the provider MIME allowlist excludes the file', () => {
    expect(
      getDefaultUploadToolResource(sampleFile('document.pdf'), {
        ...defaultOptions,
        endpointFileConfig: { supportedMimeTypes: [/^image\//] },
      }),
    ).toBe(EToolResources.context);
  });

  it('rejects unsupported provider files when text is disabled', () => {
    expect(
      getDefaultUploadToolResource(sampleFile('document.docx'), {
        ...defaultOptions,
        contextEnabled: false,
      }),
    ).toBeNull();
  });

  it('rejects files outside the configured text, OCR and speech MIME types', () => {
    expect(
      getDefaultUploadToolResource(sampleFile('document.docx'), {
        ...defaultOptions,
        fileConfig: {
          ...fileConfig,
          text: { supportedMimeTypes: [/^text\/plain$/] },
          ocr: { supportedMimeTypes: [] },
          stt: { supportedMimeTypes: [] },
        },
      }),
    ).toBeNull();
  });

  it('rejects all routes when uploads are disabled', () => {
    const options = { ...defaultOptions, endpointFileConfig: { disabled: true } };
    expect(getDefaultUploadToolResource(sampleFile('document.pdf'), options)).toBeNull();
    expect(getDefaultUploadToolResource({ name: 'notes.txt', type: '' }, options)).toBeNull();
  });
});
