import { EToolResources } from './types/assistants';
import {
  fileConfig,
  getEndpointFileConfig,
  getUploadMimeTypes,
  inferMimeType,
  mergeFileConfig,
} from './file-config';

describe('upload MIME configuration', () => {
  it.each([
    ['openAI', undefined, 'openAI'],
    ['agents', 'openAI', 'openAI'],
    ['Gateway', 'custom', 'Gateway'],
    ['openAI', undefined, 'default'],
  ])('recognizes explicit types for %s / %s via %s', (endpoint, endpointType, key) => {
    const config = mergeFileConfig({
      endpoints: { [key]: { supportedMimeTypes: ['^application/rtf$'] } },
    });
    const resolved = getEndpointFileConfig({ fileConfig: config, endpoint, endpointType });
    expect(resolved.hasCustomMimeTypes).toBe(true);
    expect(fileConfig.checkType('application/rtf', resolved.supportedMimeTypes)).toBe(true);
    expect(fileConfig.checkType('application/pdf', resolved.supportedMimeTypes)).toBe(false);
  });

  it('does not mistake built-in defaults for an explicit provider allowlist', () => {
    const config = mergeFileConfig({ endpoints: { openAI: { fileLimit: 3 } } });
    expect(
      getEndpointFileConfig({ fileConfig: config, endpoint: 'openAI' }).hasCustomMimeTypes,
    ).toBeFalsy();
  });

  it('keeps provider and text MIME lists separate', () => {
    const config = mergeFileConfig({
      endpoints: { openAI: { supportedMimeTypes: ['^application/pdf$'] } },
      text: { supportedMimeTypes: ['^text/plain$'] },
      ocr: { supportedMimeTypes: [] },
    });
    const endpointFileConfig = getEndpointFileConfig({ fileConfig: config, endpoint: 'openAI' });
    const providerTypes = getUploadMimeTypes({ fileConfig: config, endpointFileConfig });
    const textTypes = getUploadMimeTypes({
      fileConfig: config,
      endpointFileConfig,
      toolResource: EToolResources.context,
    });
    expect(fileConfig.checkType('text/plain', providerTypes)).toBe(false);
    expect(fileConfig.checkType('text/plain', textTypes)).toBe(true);
    expect(fileConfig.checkType('application/pdf', textTypes)).toBe(false);
    expect(fileConfig.checkType('application/octet-stream', textTypes)).toBe(false);
  });

  it('does not allow text fallback to bypass a disabled endpoint', () => {
    expect(
      getUploadMimeTypes({
        endpointFileConfig: { disabled: true },
        toolResource: EToolResources.context,
      }),
    ).toEqual([]);
  });

  it.each([
    ['document.DOCX', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['workbook.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['document.pdf', 'application/pdf'],
  ])('infers %s when the browser omits its MIME type', (name, expected) => {
    expect(inferMimeType(name, '')).toBe(expected);
  });
});
