# EPTM Changelog — LibreChat

This changelog tracks changes specific to our fork, integrated into `local_main`.
Current base: LibreChat `v0.8.7` (`9e74cc0`). Entries are listed newest first.

## Unreleased

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
