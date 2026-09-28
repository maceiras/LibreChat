import {
  Providers,
  inferMimeType,
  EToolResources,
  EModelEndpoint,
  isBedrockDocumentType,
  isPermissiveMimeConfig,
  getUploadMimeTypes,
  isDocumentSupportedProvider,
  fileConfig as defaultFileConfig,
} from 'librechat-data-provider';
import type { EndpointFileConfig, FileConfig } from 'librechat-data-provider';

export interface UploadOptions {
  provider?: string | null;
  endpointType?: string | null;
  useResponsesApi?: boolean;
  endpointFileConfig?: EndpointFileConfig;
  fileConfig?: FileConfig | null;
  contextEnabled?: boolean;
}

export function supportsDocumentUpload({
  provider,
  endpointType,
  useResponsesApi,
}: UploadOptions): boolean {
  const isAzure =
    provider === EModelEndpoint.azureOpenAI || endpointType === EModelEndpoint.azureOpenAI;
  if (isAzure) {
    return useResponsesApi === true;
  }
  return (
    isDocumentSupportedProvider(endpointType) ||
    isDocumentSupportedProvider(provider) ||
    provider?.toLowerCase() === Providers.OPENROUTER
  );
}

export function supportsProviderUpload(
  file: Pick<File, 'name' | 'type'>,
  options: UploadOptions,
): boolean {
  const { provider, endpointType, endpointFileConfig } = options;
  const type = inferMimeType(file.name, file.type);
  if (!type || endpointFileConfig?.disabled === true) {
    return false;
  }
  if (!defaultFileConfig.checkType(type, endpointFileConfig?.supportedMimeTypes)) {
    return false;
  }
  if (type.startsWith('image/')) {
    return true;
  }
  if (!supportsDocumentUpload(options)) {
    return false;
  }
  if (provider === Providers.BEDROCK || endpointType === EModelEndpoint.bedrock) {
    return isBedrockDocumentType(type);
  }
  if (
    endpointFileConfig?.hasCustomMimeTypes ||
    isPermissiveMimeConfig(endpointFileConfig?.supportedMimeTypes)
  ) {
    return true;
  }
  if (
    provider === Providers.GOOGLE ||
    endpointType === EModelEndpoint.google ||
    provider?.toLowerCase() === Providers.OPENROUTER
  ) {
    return type.startsWith('video/') || type.startsWith('audio/') || type === 'application/pdf';
  }
  return type === 'application/pdf';
}

/** Undefined selects the provider; null means neither provider nor text can accept the file. */
export function getDefaultUploadToolResource(
  file: Pick<File, 'name' | 'type'>,
  options: UploadOptions,
): EToolResources.context | undefined | null {
  if (supportsProviderUpload(file, options)) {
    return undefined;
  }
  if (!options.contextEnabled || options.endpointFileConfig?.disabled === true) {
    return null;
  }
  const type = inferMimeType(file.name, file.type);
  const textTypes = getUploadMimeTypes({
    fileConfig: options.fileConfig,
    endpointFileConfig: options.endpointFileConfig ?? {},
    toolResource: EToolResources.context,
  });
  return type && defaultFileConfig.checkType(type, textTypes) ? EToolResources.context : null;
}
