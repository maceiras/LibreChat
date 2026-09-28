# EPTM Changelog — LibreChat

This changelog tracks changes specific to our fork, integrated into `local_main`.
Current base: LibreChat `v0.8.7` (`9e74cc0`). Entries are listed newest first.

## Unreleased

- **Documentation**: add this changelog and guidelines for keeping it up to date.

## 2026-09-28 — Automatic document uploads and MIME routing

- **Provider MIME routing**: honor explicit provider MIME allowlists for all
  declared formats, including Word, Excel, PowerPoint, and text documents.
  The legacy image/PDF fallback no longer overrides an explicit list. Existing
  Bedrock transport constraints and Azure Responses requirements still apply.
- Validate text uploads against their text/OCR/transcription allowlists on both
  client and server. Send routing metadata before the multipart file so the
  server can choose the correct validator. Keep successfully extracted text
  attached to messages even when its MIME type is outside the provider list.
- Route images selected for text extraction through the file-processing endpoint
  without image resizing. Infer common document MIME types when browsers omit them.
- **Automatic uploads**: remove the upload-mode menus from the paperclip and
  drag-and-drop flows. The paperclip opens the file picker directly; dropped
  files are processed immediately. Each file uses the provider when supported,
  otherwise text processing, with an error when neither path is available or
  processing fails. Routing still uses the existing pre-upload compatibility
  checks and MIME configuration.
- Keep SharePoint accessible through a separate button when configured. Agent
  configuration uploads and Assistants keep their existing routing.
- Remove the unused upload menu, drag-and-drop dialog, and dialog context;
  replace their tests with UI coverage of automatic uploads and errors.

**Validation:** 390 targeted tests passed across shared configuration, frontend,
upload middleware, file processing, and attachment filtering. Coverage includes
real multipart parsing, provider/text routing, text extraction errors, keyboard
activation, and SharePoint access. TypeScript, lint, and the data-provider, API,
and production frontend builds passed. No Docker deployment or live provider
tests were run.

## 2026-09-28 — Unified attachment uploads

Change: `61efa3b`; merged into `local_main`: `29ee450`.

- The paperclip and drag-and-drop paths follow the same rule: prefer provider
  upload, then fall back to text processing when the provider path does not
  support the file and the text capability and its MIME types allow it.
- Routing is determined per file, so a batch can combine provider and text uploads.
- Existing menus and explicit choices are preserved. File size and count limits,
  total size limits, and duplicate detection still apply to the entire batch.
- Permissive MIME configuration (`supportedMimeTypes: [".*"]`) is honored in both
  paths, including office documents uploaded to OpenAI.

**Known limitations:** without permissive configuration, the OpenAI provider path
remains limited to images/PDFs, even if another format is explicitly allowed in
the YAML. Text fallback uses its own MIME allowlists. Routing is determined before
upload; a provider rejection does not trigger an automatic retry as text.

**Validation:** 110 targeted tests passed, TypeScript and lint checks passed,
and shared package and frontend builds succeeded. No live provider tests were run.
