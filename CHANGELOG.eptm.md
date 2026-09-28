# EPTM Changelog — LibreChat

This changelog tracks changes specific to our fork, integrated into `local_main`.
Current base: LibreChat `v0.8.7` (`9e74cc0`). Entries are listed newest first.

## Unreleased

- **Code Interpreter image previews**: preserve dimensions and detected MIME types
  for generated PNG, JPEG, GIF, and WebP files, and store them on the existing image
  path using the configured image storage strategy. Images render inline during
  streaming and after reload without changing the original bytes. Invalid or
  unsupported images remain downloadable. Existing attachments are not migrated;
  regenerate them after rebuilding and restarting the backend to get previews.

**Image preview validation:** 154 targeted tests passed across file imports,
attachment/image rendering, agent initialization, SSE callbacks, and MIME filtering.
The image tests use real PNG/JPEG/GIF/WebP buffers and the real frontend image
component. API and frontend TypeScript, changed-file ESLint, and the API build
passed. Corrected the incomplete request fixture in the existing MIME-filter test
so the full API typecheck can run. No live provider call or deployment was performed.

- **OpenAI Responses Code Interpreter**: support `preset.code_execution` in model
  specs, conversations, and saved presets. When true, offer the OpenAI-hosted
  `code_interpreter` tool with an automatic container and use Responses. False
  or omission keeps it disabled; native web search can be enabled alongside it.
- Download generated container files with the producing client's configuration,
  enforce file size limits, and store owned, tenant-scoped attachments using the
  configured storage and retention. Display downloads during streaming and after
  reload, including resumable streams. This does not enable LibreChat code execution.
- Accept both raw OpenAI annotations and normalized LangChain citations. Deduplicate
  files and preserve the answer if a remote file cannot be downloaded.

**Code Interpreter validation:** 447 targeted tests passed, including SDK request
serialization and native results in streaming/non-streaming mode, file storage,
configuration persistence, SSE delivery, and attachment rendering. Shared package
and production frontend builds passed. Frontend and backend production entrypoints
plus the new backend tests passed TypeScript; changed files passed ESLint.
No live OpenAI calls or deployment were performed. Python state is not persisted
between conversation turns by this integration.

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
