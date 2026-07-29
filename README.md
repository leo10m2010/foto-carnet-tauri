# FotoCarnet

FotoCarnet is a Windows desktop application for composing, validating, and exporting batches of ID cards from a visual template and photo filenames. It uses a vanilla HTML/CSS/JavaScript frontend inside Tauri 2 and a Rust backend for native dialogs, filesystem access, image loading, folder watching, RENIEC requests, and updates.

## Platform Support

Development, testing, and releases are supported on **Windows 10/11 x64 only**. The application requires Microsoft Edge WebView2. Other operating systems may be technically buildable by Tauri but are not tested or supported by this project.

## Supported Formats

- Template and photo input: JPEG/JPG, PNG, GIF, BMP, and WebP.
- Optional tabular data: CSV, XLSX, and XLS.
- Output: one PNG, a ZIP containing PNG cards, a multi-card PDF, or a print preview.
- Photo filenames may place a 6-12 digit DNI before or after a name, separated by spaces, `-`, or `–`. Eight-digit normalized DNI values are used to join spreadsheet rows.

## Architecture

- `src/index.html` loads browser-global scripts from `src/js/` in an explicit order. There is no frontend bundling step.
- `src/js/tauri-bridge.js` exposes the narrow Tauri command/event adapter used by the frontend.
- `src-tauri/src/lib.rs` implements native file dialogs, image reads and caches, folder watching, file writes, update checks, the RENIEC proxy, and secure persistence backed by Windows Credential Manager.
- `src/vendor/` contains browser libraries shipped with the app so normal editing and export do not depend on a CDN.
- Session and RENIEC token persistence are explicit opt-ins. On the official Windows/Tauri path, sessions are AES-256-GCM encrypted in app data and encryption keys plus RENIEC tokens are kept in Windows Credential Manager. Source photos remain in their selected disk locations: imports and session restore index authorized paths and dimensions without transporting every image to the WebView. Native data-URL caches are bounded to 64 MiB for previews and 32 MiB for thumbnails, while concurrent native decoding reserves up to 256 MiB. The renderer uses byte-bounded preview and thumbnail caches and releases their object URLs on eviction or clear. These limits are not a cap on total process memory.
- The native secure-storage upgrade migrates a valid legacy session from WebView `localStorage` only when its previous persistence preference is enabled or absent: it writes the encrypted native session first and removes the plaintext only after that succeeds. Invalid legacy data or a failed secure write is left unchanged rather than deleted; an explicit persistence opt-out deletes it. Legacy plaintext RENIEC tokens are not migrated and are deleted without being read, so the user must re-enter the token. Non-secret persistence preferences and UI settings can remain in `localStorage`.

## Large Batches

- A photo selection or watched folder can index up to 1,000 supported images.
- Indexing reads authorization, dimensions, file identity, and size only. Photo pixels are loaded lazily for the current preview and nearby records.
- The filmstrip requests small native thumbnails only when they enter the visible area.
- Session restore validates metadata without preloading all photo bytes.
- Export validates and renders full-quality photos serially. A missing, replaced, or corrupt photo stops the export with an actionable error instead of producing a card marked `Sin foto`.
- ZIP, PDF, and print output still grow with record count. For very large delivery sets, split exports into operationally manageable groups when the configured output limit is reached.

## Windows Development

Install the Windows prerequisites from the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/), including Visual Studio C++ Build Tools and WebView2. Install Node.js 22.13 or later; CI uses the exact compatible patch `22.13.0`. Rust is pinned by `rust-toolchain.toml` and will be installed by `rustup` when a Cargo command runs.

```powershell
npm ci
npm run dev
```

Useful commands:

```powershell
npm test                 # Vitest regression tests
npm run check:syntax     # Parse every first-party frontend script
npm run format:check     # Check infrastructure/docs formatting only
npm run check:version    # Compare npm, lockfile, Tauri, and Cargo versions
npm run test:rust        # cargo test --locked --all-targets
npm run lint:rust        # Clippy for all targets/features with warnings denied
npm run check            # All formatting, version, JS test, Rust test, and Clippy checks
npm run build            # Installer build; signs only if credentials are configured
npm run build:portable   # Unsigned portable executable
```

Legacy application sources and vendored files are deliberately excluded from Prettier to avoid a repository-wide rewrite. New infrastructure and documentation are formatted.

## Privacy and RENIEC

The core editor is local, but RENIEC enrichment is not offline: when configured, DNI values and the user's API token are sent over HTTPS to `dniruc.apisperu.com`. Session and token persistence are unchecked on first use and disabling either option deletes its persisted data. Update checks contact the GitHub API. There is no application telemetry in the current implementation. See [PRIVACY.md](PRIVACY.md) for data categories, retention, deletion, and operator responsibilities.

## Releases

1. Update `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` to the same semantic version.
2. Add release notes to `CHANGELOG.md` and run `npm ci` followed by `npm run check`.
3. Create and push the exact tag `v<version>`, for example `v1.2.0`. A suffix such as `v1.2.0-rc.1` creates a prerelease.
4. GitHub Actions verifies that the exact tag matches every project version, reruns JS and Rust tests plus Clippy, builds with npm and Cargo lockfiles, marks hyphenated semantic versions as prereleases, publishes the portable EXE plus SHA-256 checksum, and records a GitHub build-provenance attestation for both files.

Release binaries are currently **not Authenticode-signed**. A trusted release process requires a protected code-signing certificate and CI secrets; that work is deferred until credentials exist. Do not describe an unsigned binary as signed.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
