# EPTM Changelog — LibreChat

This changelog tracks changes specific to our fork, integrated into `local_main`.
Current base: LibreChat `v0.8.7` (`9e74cc0`). Entries are listed newest first.
Features are grouped by integration date, with commit references, behavior changes,
and compatibility, limitations, and validation notes when available.

## 2026-09-29

### Keep internal container artifacts out of delivered attachments

- Save native OpenAI container files only when their provider citation matches
  an explicit sandbox download link in the response text. Unlinked inspection
  images and verification reports stay inside the working container.
- Keep requested JSON, images and Office files downloadable; avoid inferring
  deliverables from filenames or publishing ambiguous file references.

**Validation:** 28 native file tests and 8 direct/resumable streaming integration
tests passed. API TypeScript, changed-file ESLint, formatting, diff checks and
the Docker build passed.

### Download generated files from inline sandbox links

- Resolve Markdown `sandbox:/mnt/data/` links against the current message's
  attachments and reuse the authenticated attachment download flow, including
  previously saved responses and nested output paths.
- Keep the default URL filtering for other protocols. Leave missing or ambiguous
  file references inactive instead of navigating to a new chat or selecting a
  different message's file.

**Validation:** 28 tests passed across the real Markdown renderer, block rendering
and attachment download behavior. Client TypeScript, changed-file ESLint,
formatting, diff checks and the Docker build passed. Browser verification
confirmed successful downloads from both existing inline links.

### Unblock follow-up responses with reusable Python containers

- Register the Meilisearch `updateOne` synchronization hook as document middleware.
  Query updates return an update result rather than a document; the previous hook
  never completed its callback and left container continuation claims waiting
  after MongoDB had already saved them.
- Keep document updates indexed while allowing atomic container claims to finish,
  so follow-up file edits can proceed beyond response preparation.

**Validation:** all 57 Meilisearch plugin tests passed, including a real MongoDB
container-claim regression and document-update indexing. The original query hook
was independently reproduced hanging after the write. The data-schemas TypeScript
check, changed-file ESLint and formatting, and the local Docker build passed.
Restarted the local API and retried the stalled PowerPoint follow-up in the
browser: it completed in 56 seconds with the updated presentation and its render
report available in the conversation.

### Show response progress during workspace preparation

- Start the primary Responses timeline before preparing its Python container,
  skill resources and restored files, so follow-up turns keep a visible status
  and elapsed time while preparation is still running.
- Preserve the progress observer through workspace preparation without wrapping
  it twice. Settle preparation failures and cancellations, and suppress new
  running snapshots for requests that have already been stopped.

**Validation:** 24 targeted backend tests passed, including delayed preparation,
failure, cancellation and provider eligibility. Changed-file ESLint, formatting
and syntax checks, the API TypeScript check and the local Docker build passed.
Restarted the local API and retried the affected PowerPoint follow-up; its
preparation status now appears before any model output.

### Keep response progress active during file retrieval

- Record recoverable output-file failures without stopping progress or freezing
  its duration while other downloads continue. Finalize as `incomplete` only when
  the response finishes, using the actual completion time.
- Aggregate visible generated files from all agents in the response, including
  secondary agents. Hidden sequential outputs remain excluded. Cancellation and
  terminal provider failures retain their existing priority and behavior.

**Validation:** 101 targeted tests passed across the tracker, real SDK file
retrieval with controlled HTTP responses, initialization, attachment callbacks,
metadata and the progress UI. The API build, changed-file ESLint, formatting and
diff checks passed. Full package TypeScript checks reported unrelated diagnostics
in concurrently edited `agents/native.ts` and `agents/workspaces.spec.ts`.
No deployment was performed.

### Reliable native OpenAI skill resources and file restoration

- Prepare the primary agent’s signed, conversation-scoped Code Interpreter
  container for skills and persisted files, preserving configured memory limits
  and initial file IDs.
- Upload deterministic skill archives directly from storage. Verify content hashes,
  install resources in versioned directories and reuse verified remote archives.
  Manual, always-apply, historical and autonomous skills receive actual container
  paths before execution; transfer failures do not claim resources are available.
- Share bounded stream reads, cancellation, checksums and remote-file verification
  between skill transfer and file restoration. Use Node's stream and timer APIs
  for cancellation, including stalled downloads.
- Restore persisted inputs and recent outputs from the current ancestor branch,
  checking owner, tenant, conversation, retention and size limits. Prefer recent
  revisions and report unavailable files without reconstructing their content.
- Traverse declared graph agents once before execution. Give native OpenAI handoff
  agents and subagents with accessible skills their own fresh explicit container
  for the request and transfer only those resources. Do not restore history,
  persist their Python memory or share the primary agent’s container.
- Preserve externally imposed explicit containers and refuse automatic resource
  transfer with an explicit error when it would be required. Do not rewrite
  agents created dynamically by the SDK after graph preparation. Other execution
  providers retain their behavior.

**Compatibility:** this does not restore Python memory or unsaved intermediates,
install rendering software, or change the storage retention policy. Rebuild the
API package and restart the server to enable the new transfer hooks.

**Validation:** targeted resource, container, restoration, tool-handler and graph
tests passed, including controlled HTTP responses through the installed OpenAI
SDK. Backend initialization and attachment regression checks, package TypeScript,
changed-file ESLint and the API build passed. No live OpenAI transfer or deployment
was performed for this change.

### Reject unreadable document fallbacks

- Require a successful extractor for binary documents instead of decoding their
  bytes as text when RAG is absent, unavailable or returns unusable output.
- Restrict native parsing to text formats and validate UTF-8 throughout the stream,
  rejecting binary content even with misleading file names or MIME types. Preserve
  Markdown, structured text, source code, SVG and readable files with generic MIME
  metadata.
- Surface an actionable upload error before persisting a file, suggesting a PDF
  with selectable text, UTF-8 TXT or a model that supports the format directly.
  Keep provider uploads, built-in document parsing, OCR and successful RAG extraction.

**Compatibility:** this does not add new document extractors. Native text parsing
rejects invalid UTF-8 and non-whitespace control characters, including ANSI escape
sequences; such files need conversion or a compatible extractor.

**Validation:** 247 targeted tests passed across real temporary files and archives,
document parsing, upload persistence, error handling and frontend routing. External
RAG responses were simulated. API TypeScript (including tests), changed-file ESLint,
formatting and the API package build passed. No deployment was performed.

### Native OpenAI regression fixes

- Hide generated attachments from intermediate agents when sequential outputs are
  hidden, while preserving usage accounting and the final agent's attachments.
- Claim Python continuations only after the remote container check succeeds.
  Temporary provider failures, timeouts and cancellation during that check no
  longer consume the saved continuation; concurrent claims remain atomic.
- Stabilize message and parent-message placeholders in the signed container
  identity while sending current values in outbound headers. Keep user, tenant,
  conversation, provider and authentication isolation intact.
- Preserve the second model's `code_execution` and `useResponsesApi` settings in
  parallel conversations, with preset fallback and explicit `false` respected.

**Compatibility:** existing container signatures with static headers remain valid.
Sessions previously signed with turn-specific headers start a fresh container once.
Persisted agent configurations retain their existing behavior.

**Validation:** 272 targeted tests passed, including real SDK serialization,
standard/resumable attachment callbacks and MongoDB continuation claims. API
TypeScript, changed-file ESLint and the API package build passed. Provider traffic
was simulated; no live OpenAI calls or deployment were performed for these fixes.

## 2026-09-28

### Reusable OpenAI Python containers

**References:** change `66366db37`.

- Reuse the primary agent's native Responses Code Interpreter container across
  conversation turns, including reloads. Persist its reference even when Python
  returns no file, and validate the remote container before continuing.
- Start a fresh workspace after 20 minutes of locally observed inactivity or when
  OpenAI reports an expired or missing container. Tell the model to reconstruct
  needed state from available inputs; do not promise recovery of Python variables
  or unsaved intermediate files. Other provider failures remain visible.
- Bind session references to the owner, tenant, conversation, agent and provider
  configuration with a keyed signature. Atomically claim each saved continuation
  so concurrent replies and older branches cannot share a mutable workspace.
- Preserve configured transports, gateway headers, native web search, progress
  and output attachments.

**Compatibility and limitations:** explicitly configured containers and secondary
agents retain their existing behavior. Existing messages without session metadata
start with a new container after the backend is rebuilt and restarted.

**Validation:** 139 targeted tests passed, including real SDK serialization and
MongoDB concurrency/tenant isolation. API/data-schemas TypeScript, changed-file
ESLint and both package builds passed. Three live OpenAI calls verified Python
state across persisted messages and a fresh container after simulated expiry.
The running local backend was not redeployed.

### Native Responses progress

**References:** change `09f24b3b4`; waiting-dot refinement `c8b168f81`.

- Show real OpenAI Responses stages (web search, code preparation, Python execution,
  response writing, and local file retrieval) with elapsed time. Keep completed
  replies compact with an expandable history and frozen duration.
- Observe native SSE status events before the LangChain adapter discards them,
  preserving the configured transport and original response bytes. Do not expose
  generated code or raw provider payloads.
- Preserve progress during reconnection and after reload, including stopped replies.
  Show it on the assistant placeholder before the first text arrives; ignore stale
  replay events and distinguish failure, interruption, and incomplete file retrieval.
- Hide the redundant waiting dot when the same message displays the Responses
  progress panel. Keep the dot as a fallback for messages without progress details.

**Compatibility and limitations:** this covers the primary Responses agent;
endpoints that do not emit native status events keep their existing behavior.

**Validation:** 249 targeted tests passed across progress tracking, the real SDK,
file retrieval, replay, metadata persistence, SSE handling, and the progress UI.
API/frontend TypeScript, changed-file ESLint, and production Docker builds passed.
The local API was rebuilt and restarted. A live Matplotlib request produced an
inline PNG and persisted its real stages (31 seconds). It exposed a missing
connection to the main message renderer, which was corrected. Final visual
verification was blocked by the browser-control runtime failing to start.
The waiting-dot refinement passed 24 existing rendering tests, ESLint, and the
local Docker build.

### Code Interpreter image previews

**References:** change `b18dc4510`; merged into `local_main` as `b3a9af564`.

- Preserve dimensions and detected MIME types for generated PNG, JPEG, GIF, and
  WebP files, and store them on the existing image path using the configured image
  storage strategy.
- Render images inline during streaming and after reload without changing the
  original bytes. Keep invalid or unsupported images downloadable.

**Compatibility and limitations:** existing attachments are not migrated;
regenerate them after rebuilding and restarting the backend to get previews.

**Validation:** 154 targeted tests passed across file imports,
attachment/image rendering, agent initialization, SSE callbacks, and MIME filtering.
The image tests use real PNG/JPEG/GIF/WebP buffers and the real frontend image
component. API and frontend TypeScript, changed-file ESLint, and the API build
passed. Corrected the incomplete request fixture in the existing MIME-filter test
so the full API typecheck can run. No live provider call or deployment was performed.

### OpenAI Responses Code Interpreter

**References:** change `0d968bb97`; merged into `local_main` as `bfeef1446`.

- Support `preset.code_execution` in model specs, conversations, and saved presets.
  When true, offer the OpenAI-hosted `code_interpreter` tool with an automatic
  container and use Responses. False or omission keeps it disabled; native web
  search can be enabled alongside it.
- Download generated container files with the producing client's configuration,
  enforce file size limits, and store owned, tenant-scoped attachments using the
  configured storage and retention. Display downloads during streaming and after
  reload, including resumable streams.
- Accept both raw OpenAI annotations and normalized LangChain citations. Deduplicate
  files and preserve the answer if a remote file cannot be downloaded.

**Compatibility and limitations:** this does not enable LibreChat code execution.
The initial integration did not persist Python state between conversation turns;
cross-turn reuse is covered by [Reusable OpenAI Python containers](#reusable-openai-python-containers).

**Validation:** 447 targeted tests passed, including SDK request
serialization and native results in streaming/non-streaming mode, file storage,
configuration persistence, SSE delivery, and attachment rendering. Shared package
and production frontend builds passed. Frontend and backend production entrypoints
plus the new backend tests passed TypeScript; changed files passed ESLint.
No live OpenAI calls or deployment were performed.

### Automatic document uploads and MIME routing

**References:** change `fde0e6d75`.

- Honor explicit provider MIME allowlists for all declared formats, including
  Word, Excel, PowerPoint, and text documents. The legacy image/PDF fallback no
  longer overrides an explicit list.
- Validate text uploads against their text/OCR/transcription allowlists on both
  client and server. Send routing metadata before the multipart file so the
  server can choose the correct validator. Keep successfully extracted text
  attached to messages even when its MIME type is outside the provider list.
- Route images selected for text extraction through the file-processing endpoint
  without image resizing. Infer common document MIME types when browsers omit them.
- Remove the upload-mode menus from the paperclip and drag-and-drop flows.
  The paperclip opens the file picker directly; dropped files are processed
  immediately. Each file uses the provider when supported, otherwise text
  processing, with an error when neither path is available or
  processing fails. Routing still uses the existing pre-upload compatibility
  checks and MIME configuration.
- Keep SharePoint accessible through a separate button when configured.
- Remove the unused upload menu, drag-and-drop dialog, and dialog context;
  replace their tests with UI coverage of automatic uploads and errors.

**Compatibility and limitations:** existing Bedrock transport constraints and
Azure Responses requirements still apply. Agent configuration uploads and
Assistants keep their existing routing.

**Validation:** 390 targeted tests passed across shared configuration, frontend,
upload middleware, file processing, and attachment filtering. Coverage includes
real multipart parsing, provider/text routing, text extraction errors, keyboard
activation, and SharePoint access. TypeScript, lint, and the data-provider, API,
and production frontend builds passed. No Docker deployment or live provider
tests were run.

### Documentation

**References:** change `ff487661b`.

- Add this changelog and guidelines for keeping it up to date.

### Unified attachment uploads

**References:** change `61efa3b61`; merged into `local_main` as `29ee45065`.

- Apply the same rule to the paperclip and drag-and-drop paths: prefer provider
  upload, then fall back to text processing when the provider path does not
  support the file and the text capability and its MIME types allow it.
- Route each file independently so a batch can combine provider and text uploads.
- Preserve existing menus and explicit choices. Keep file size and count limits,
  total size limits, and duplicate detection for the entire batch.
- Honor permissive MIME configuration (`supportedMimeTypes: [".*"]`) in both paths,
  including office documents uploaded to OpenAI.

**Compatibility and limitations:** at the time of this change, without permissive
configuration, the OpenAI provider path remained limited to images/PDFs, even if
another format was explicitly allowed in the YAML. The later
[Automatic document uploads and MIME routing](#automatic-document-uploads-and-mime-routing)
change honors explicit provider MIME lists and removes the upload-mode menus.
Text fallback uses its own MIME allowlists. Routing is determined before upload;
a provider rejection does not trigger an automatic retry as text.

**Validation:** 110 targeted tests passed, TypeScript and lint checks passed,
and shared package and frontend builds succeeded. No live provider tests were run.
