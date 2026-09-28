# EPTM Changelog — LibreChat

This changelog tracks changes specific to our fork, integrated into `local_main`.
Current base: LibreChat `v0.8.7` (`9e74cc0`). Entries are listed newest first.

## Unreleased

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
