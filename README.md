# dsh-has

On-device reversible anonymization for DeepSeek Harness, based on the HaS
(Hide and Seek) text skill. A pure Node.js ESM port: no Python, no npm
dependencies, no network calls beyond `127.0.0.1`.

| Tool | Purpose |
| --- | --- |
| `has_scan` | NER only: per-type entity counts (values with `reveal:true`) |
| `has_hide` | Replace entities with `<类型[ID].类别.属性>` tags, persist mapping JSON |
| `has_restore` | Restore tags from a mapping file (deterministic first, model fallback) |
| `has_status` | Readiness, server lifecycle (`check` / `start` / `stop`) |

User-facing guide: [`docs/usage.md`](./docs/usage.md) (also the plugin detail page).

## How it works

```text
tool call ──► ServerManager.ensure() ──► llama-server (127.0.0.1, HaS 0.6B Q8)
                  │  lazy start, cross-process reuse via <stateDir>/server.json
                  ▼
            hide:  NER → Hide(with/without mapping) → Pair(diff, model fallback)
                        → Model-Split for composite keys → mapping self-check
            scan:  NER per chunk, entities merged per document
            seek:  Tool-Seek → (if tags remain / language changed) Model-Seek,
                        chunked at sentence boundaries without cutting a tag
```

The per-chunk budget shrinks as the accumulated mapping grows
(`min(maxChunkTokens, (ctx - 200 - mappingTokens)/2.05, (ctx - 230)/2.05)`), and a
context overflow retries the chunk at 75 % size (up to twice), then the whole
call is retried once against a 16 K-per-slot server.

### Layout

```text
index.js            apply(): resolve config, register tools in one ctx.effect
lib/config.js       defaults ← <stateDir>/config.json ← row config ← env
lib/server.js       lazy llama-server: spawn, /health poll, /props reuse, idle stop
lib/client.js       fetch wrapper for /v1/chat/completions and /tokenize
lib/prompts.js      the six HaS prompt templates (must stay byte-exact)
lib/chunker.js      sentence-aware chunking
lib/mapping.js      tag regex, mapping merge/normalize, tolerant JSON, 0600 files
lib/pair.js         diff-based mapping extraction (SequenceMatcher port)
lib/hide.js         hide pipeline + overflow retries + bounded concurrency
lib/scan.js         scan pipeline (chunk pool per directory)
lib/seek.js         restore pipeline (tool seek, model seek, tag-safe chunking)
lib/tools.js        tool definitions (raw JSON Schema, privacy-preserving output)
lib/io.js           UTF-8/binary-safe reads, protected writes, default dirs
lib/zip.js          minimal ZIP reader/writer for .docx containers
lib/docx.js         Word support: paragraph/run text extraction, tag placement per run
lib/pdf-parse.js    PDF object/xref reader (ObjStm, FlateDecode, page tree)
lib/pdf-text.js     content-stream text extraction, ToUnicode CMap, line/paragraph assembly
lib/fonts.js        TrueType reader: cmap, hmtx widths, metrics for embedding
lib/pdf-write.js    text PDF writer with an embedded CID font, tag-aware line wrapping
lib/pdf.js         PDF support: extract → hide/seek → rebuild
test/               smoke (units), apply (fake ctx), integration, tools, docx, pdf, long
```

Word documents (`.docx`) are supported by `has_hide` / `has_restore` / `has_scan`:
the document XML is edited in place, so styles, fonts and layout survive, and tags
are written into the same run as the entity they replace. Tables, headers, footers
and footnotes are covered because every `w:p` is processed; images and text boxes
are left untouched.

PDFs (`.pdf`) are supported by `has_hide` / `has_restore` / `has_scan` for text-based
documents. The text is extracted in reading order (soft-wrapped lines are joined
back into paragraphs, so an entity split across a line break still matches),
anonymized, and written into a new PDF that embeds a CJK TrueType font. Page size
and original font size are kept, and tags are never broken across lines so restore
stays deterministic; images, tables and vector graphics from the source are not
carried over, so a PDF output is a re-typeset copy of the document text.

`has_hide` / `has_scan` / `has_restore` accept an optional `maxChunkTokens` to
For a long PDF, `pdfAsText: true` on `has_hide` / `has_restore` (or
`test/pdf-text-hide.mjs`) skips the typesetting step and writes a `.txt` next to
the mapping: every character survives, figures and tables do not, and the run is
much faster because no font is embedded and nothing is re-laid out.override the per-call chunk size; defaults are 3000 (hide/restore) and 5000
(scan).

## Install

From this directory:

```js
plugin_manager({ action: 'install_bundle', target: 'C:\\Users\\86152\\Desktop\\Code\\Dhas\\dsh-has' })
```

Then verify the row exists (`application` field), check
`cordis_inspect_query` host `listTools`, and call `has_status`.

The bundle patch pins `modelPath` / `llamaServerPath` for this machine; both are
auto-discovered when omitted.

## Develop

```powershell
node test/smoke.mjs          # pure-Node unit tests (no model needed)
node test/apply.mjs          # plugin entry point against a fake Cordis context
$env:DSH_HAS_HOME = 'C:\Users\86152\Desktop\Code\Dhas\.state'
node test/integration.mjs    # real llama-server: scan → hide → restore round-trip
node test/tools.mjs          # tool layer: text, files, directories, status, skipped files
node test/long.mjs           # multi-chunk document: mapping stability + damaged input
node test/roundtrip.mjs <file> --types 人名,电话号码   # byte-exact hide/restore of one real file
node test/docx.mjs <file.docx> --types 人名,地址      # Word: text round-trip, formatting kept
node test/docx-tools.mjs <file.docx>                  # Word through the tool layer, plus directory mode
node test/pdf.mjs <file.pdf> --types 人名,地址        # PDF: extract → hide → rebuild → restore
node test/pdf-tools.mjs <file.pdf>                    # PDF through the tool layer, plus directory mode
node test/pdf-text-hide.mjs <file.pdf>                # long PDFs: anonymize text only (no rebuild), with progress
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/validate-pdf.ps1 -Render <file.pdf>
                                                      # real-engine check (Windows PDF engine) + page-1 PNG
```

`test/integration.mjs` starts the server, anonymizes a Chinese ticket sample,
then restores it and asserts the round-trip is byte-identical after whitespace
normalization. `test/roundtrip.mjs` goes further on a real file: it compares the
restored bytes with the original and prints the anonymized text, the mapping and
output paths, which is the quickest way to check a document before sending it
out. `test/long.mjs` takes several minutes on a CPU-only build: a 0.6B model
generates at roughly 15 tokens/s.

The plugin's own reader is deliberately tolerant, so a PDF that it reads can still
be rejected by real viewers. `test/validate-pdf.ps1` loads a file with the Windows
PDF engine (the one Edge uses) and optionally renders page 1 to a PNG — use it after
changing `lib/pdf-write.js`.

`test/pdf.mjs` and `test/pdf-tools.mjs` exercise PDF documents. They compare
extracted text with whitespace collapsed, because the rebuilt PDF re-wraps the
paragraphs; each output PDF embeds a full CJK font (~5 MB).

`test/docx.mjs` and `test/docx-tools.mjs` exercise Word documents. They compare
paragraph text rather than bytes, because the ZIP writer re-packs the container
(entry order and compression method can differ while the document is equivalent);
run-level formatting is checked separately with `python-docx` when needed.

## Notes

- The model is loaded once per user session and unloaded after `idleTimeoutMs`
  (default 30 min); `has_status` `action:"stop"` frees it immediately.
- Only loopback hosts are accepted; `http://` elsewhere is refused by design.
- Mapping files are the key to plaintext: never log or return their contents.
- Every generation is bounded by `max_tokens`, and the request deadline scales
  with that bound (8 tokens/s floor, max 15 min), so a slow machine finishes
  long chunks instead of failing, while a degenerate repetition still fails
  fast and is retried on a smaller chunk.
- Optional `guidance: true` (env `DSH_HAS_GUIDANCE`) adds ~60 tokens of
  tag-handling rules to the system prompt for every session in the profile;
  leave it off if you would rather explain the tags per conversation.
- Image redaction from the upstream HaS skill (`has image scan|hide|categories`)
  is **not** included: it needs a separate `sensitive_seg_best.pt` detector that
  is not part of this workspace. Text is the whole surface for now.
