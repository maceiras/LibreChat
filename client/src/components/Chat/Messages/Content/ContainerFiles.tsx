import { FileContext } from 'librechat-data-provider';
import type { TAttachment } from 'librechat-data-provider';
import { AttachmentGroup } from './Parts/Attachment';

/** Native Responses tools do not have a LibreChat tool-call part to hold their files. */
export default function ContainerFiles({ attachments }: { attachments?: TAttachment[] }) {
  const files = attachments?.filter(
    (file) =>
      'context' in file && file.context === FileContext.code_interpreter && !file.toolCallId,
  );
  if (!files?.length) {
    return null;
  }
  return <AttachmentGroup attachments={files} />;
}
