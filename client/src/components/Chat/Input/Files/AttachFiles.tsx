import React, { useState } from 'react';
import { TooltipAnchor, SharePointIcon } from '@librechat/client';
import type { EModelEndpoint, EndpointFileConfig, TConversation } from 'librechat-data-provider';
import type { SharePointFile } from '~/data-provider/Files/sharepoint';
import type { ExtendedFile, FileSetter } from '~/common';
import { useSharePointFileHandlingNoChatContext } from '~/hooks/Files/useSharePointFileHandling';
import { SharePointPickerDialog } from '~/components/SharePoint';
import { useGetStartupConfig } from '~/data-provider';
import useLocalize from '~/hooks/useLocalize';
import AttachFile from './AttachFile';

interface AttachFilesProps {
  agentId?: string | null;
  endpoint?: string | null;
  disabled?: boolean | null;
  conversationId: string;
  endpointType?: EModelEndpoint | string;
  endpointFileConfig?: EndpointFileConfig;
  useResponsesApi?: boolean;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
  conversation: TConversation | null;
}

const SharePointUpload = ({
  disabled,
  endpointFileConfig,
  files,
  setFiles,
  setFilesLoading,
  conversation,
}: AttachFilesProps) => {
  const localize = useLocalize();
  const [isSharePointDialogOpen, setIsSharePointDialogOpen] = useState(false);
  const { handleSharePointFiles, isProcessing, downloadProgress } =
    useSharePointFileHandlingNoChatContext(undefined, {
      files,
      setFiles,
      setFilesLoading,
      conversation,
    });

  const handleSharePointFilesSelected = async (sharePointFiles: SharePointFile[]) => {
    try {
      await handleSharePointFiles(sharePointFiles);
      setIsSharePointDialogOpen(false);
    } catch (error) {
      console.error('SharePoint file processing error:', error);
    }
  };

  return (
    <>
      <TooltipAnchor
        description={localize('com_files_upload_sharepoint')}
        render={
          <button
            type="button"
            disabled={disabled ?? false}
            aria-label={localize('com_files_upload_sharepoint')}
            className="flex size-9 items-center justify-center rounded-full p-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={() => setIsSharePointDialogOpen(true)}
          >
            <SharePointIcon />
          </button>
        }
      />
      <SharePointPickerDialog
        isOpen={isSharePointDialogOpen}
        onOpenChange={setIsSharePointDialogOpen}
        onFilesSelected={handleSharePointFilesSelected}
        isDownloading={isProcessing}
        downloadProgress={downloadProgress}
        maxSelectionCount={endpointFileConfig?.fileLimit}
      />
    </>
  );
};

const AttachFiles = (props: AttachFilesProps) => {
  const { data: startupConfig } = useGetStartupConfig();

  return (
    <>
      <AttachFile {...props} />
      {startupConfig?.sharePointFilePickerEnabled && <SharePointUpload {...props} />}
    </>
  );
};

export default React.memo(AttachFiles);
