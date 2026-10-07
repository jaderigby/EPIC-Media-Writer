# EPIC editor

The song editor uses CodeMirror 6. Metadata form fields remain native inputs.

- `codemirror.mjs` owns the editor view, history, placeholder, scroll geometry, and flash decorations. Its small adapter exposes the text/selection operations used by `renderer.js`.
- `epic-syntax.mjs` maps EPIC/EPICX and inline Markdown to source ranges. Existing color classes in `index.html` are applied as CodeMirror marks and line decorations; there is no mirrored HTML overlay.
- Use `editor.load(text)` when opening/restoring/resetting a song: it starts a fresh history. Assigning `editor.value` or calling `replaceEditorText` makes an undoable edit to the current song. Text replacement dispatches only the changed range.
- Editor change callbacks run in a microtask after CodeMirror finishes its transaction, so application callbacks can safely dispatch follow-up changes.

`npm start`, `npm run package`, and `npm run make` build the local browser bundle through Forge's `generateAssets` hook. No CDN or runtime network access is needed. `npm run build:editor` builds it separately. Generated `dist/` files are ignored by Git.

Run `npm test` for syntax, recipe, and metadata tests. Run `npm run test:editor` for real Electron renderer integration tests. The latter uses a temporary user-data directory and mock file IPC; it does not modify the user's songs or application session. It covers input, paste, shortcuts, menu undo, session restoration, file isolation, wrapped-line navigation, recipe changes/cancellation, save payloads, Studio timing updates, and a large song.

File tabs are managed in `lib/file-tabs.js`. Switching tabs captures/restores a CodeMirror state, so each open file keeps its undo history and cursor/scroll position. The session stores all tabs and their unsaved text; undo history is retained while running, not serialized across restarts. File operations lock tab switching until completion, and background validation rejects results from an earlier tab or document version. `npm run test:tabs` exercises multi-file isolation, close confirmation, metadata drafts, save routing, and session restoration using mock files.

Files dropped anywhere in the window open as tabs using the same loader as Open Media. Supported extensions are EPIC, EPICX, TXT, MD, WAV, and MP3 (case-insensitive). The preload resolves native File paths with Electron webUtils; the main process validates extensions and regular-file status before reading. Run `npm run test:drop` for native-path, multi-file, duplicate, unsupported-file, and unsaved-edit checks.
