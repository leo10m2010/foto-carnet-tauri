# Privacy

FotoCarnet processes identification photos, DNI values, names, optional spreadsheet fields, templates, and generated cards. Anyone operating the application is responsible for having a lawful purpose, limiting access, and complying with applicable privacy and RENIEC rules.

## Processing and Network Access

Most editing and rendering occurs locally on the Windows device. The application does not currently include analytics, advertising, or telemetry.

Two features access external services:

- RENIEC enrichment sends each eligible eight-digit DNI and the operator-provided API token over HTTPS to `https://dniruc.apisperu.com`. The service returns identity data used to validate or correct names. Its terms and privacy practices apply independently.
- Update checks request the latest release metadata from the GitHub API. They do not intentionally include card or identity data.

Do not enter a RENIEC/API token or run enrichment unless the operator is authorized to query the affected DNI records. Tokens are credentials and should not be shared, committed, or included in support reports.

## Local Storage and Retention

- Session persistence is disabled until the operator explicitly enables **Guardar esta sesión en este equipo**. A saved session may contain DNI/name records, spreadsheet rows, field configuration, local source paths, watched-folder paths, and an embedded template image.
- In the official Windows/Tauri application, the serialized session is encrypted at rest with AES-256-GCM in the application data directory. Its random encryption key is stored separately in Windows Credential Manager and is never exposed to JavaScript. Session writes replace the encrypted file atomically, and sessions larger than 16 MiB are rejected; when possible, the app retries without embedding the template image.
- On a native secure-persistence upgrade, a structurally valid legacy `fotocarnet_session_v2` value is migrated when the previous session-persistence preference is enabled or absent. The app first writes it to the encrypted native session and removes the plaintext only after that succeeds. Invalid legacy data and failed migrations are retained unchanged rather than silently discarded; explicitly opting out deletes the legacy and native session data. The old plaintext `reniec-token` value is never read or migrated: it is removed on startup and must be re-entered if needed. Preference flags and non-secret UI state remain ordinary `localStorage` values.
- The browser-only fallback uses WebView/browser `localStorage` only after the same explicit session opt-in. This fallback does not provide application-level encryption and is not the official distribution path.
- A session is rejected and removed when restored more than 30 days after `savedAt`. This is cleanup-on-launch, not guaranteed secure erasure at exactly 30 days.
- Choosing **Limpiar** removes the encrypted saved session, its Credential Manager key, native image caches, and in-memory editing state. It does not delete original input files or previously exported files.
- RENIEC token persistence is also disabled by default. If explicitly enabled in the Windows/Tauri application, the token is stored in Windows Credential Manager. Turning the option off or using the token-clear control deletes that credential immediately. The browser fallback keeps the token in memory only and never writes it to `localStorage`.
- Original photos and spreadsheets stay at their existing disk locations and are not deleted by the app, but selected content and identity data are also resident in process memory. The Rust backend keeps least-recently-used data-URL caches bounded to 64 MiB/256 entries for images and 32 MiB/512 entries for thumbnails; concurrent decoding has a separate 256 MiB reservation budget. The WebView can additionally hold the active template, record and spreadsheet data, photo object/data URLs, up to 80 decoded photo elements, render/export buffers, and undo/redo stacks bounded to approximately 50 MiB each. Items remain until replaced, evicted, explicitly cleared, or process exit; allocator/runtime behavior may delay physical memory reclamation, and these individual limits do not cap total process memory.
- Print preview writes a randomly named `fotocarnet-preview-*.html` file in the operating-system temporary directory. The app removes previews older than 24 hours when it runs; operating-system cleanup policy controls any remaining retention.
- PNG, ZIP, and PDF exports remain at the location selected by the user until manually deleted.

For device disposal or incident response, clear the session and token in the app, remove exports and temporary files as appropriate, and follow the organization's Windows/WebView profile removal process.

## Security Boundaries

The official application protects opted-in session data with authenticated encryption and stores secrets through the current Windows account's Credential Manager. This does not protect data after the operator unlocks the account or while it is in process memory. Windows account controls and full-disk encryption should still protect the workstation. Avoid shared accounts, untrusted templates, and broadly accessible export folders.

Questions or incidents should be reported through the private process in [SECURITY.md](SECURITY.md), not a public issue containing personal data.
