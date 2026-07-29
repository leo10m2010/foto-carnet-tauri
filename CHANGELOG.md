# Changelog

Notable user-facing and release-engineering changes are documented here. This project follows semantic versioning for release tags.

## Unreleased

## 1.1.4 - 2026-07-28

- Add path-based lazy loading for selections and watched folders of up to 1,000 photos, native metadata inspection, visible-only thumbnails, adjacent preview prefetching, and byte-bounded renderer caches.
- Move blocking image and folder work off Tauri's main thread and harden Windows file authorization with handle-derived identity, reparse protection, bounded decoding, and one-use save paths.
- Fix asynchronous render, import, watcher, RENIEC, history, persistence, and export races that could mix records or lose the latest edit.
- Add encrypted opt-in session persistence with AES-256-GCM and Windows Credential Manager storage for encryption keys and RENIEC tokens.
- Validate export dimensions and output budgets, use immutable jobs, block missing or corrupt photos, and improve cancellation for PNG, ZIP, PDF, and print flows.
- Improve keyboard access, modal focus management, progress semantics, responsive behavior, high-contrast support, and large-import feedback.
- Add pinned JavaScript quality tooling, regression tests, version consistency checks, and a Windows CI quality gate.
- Harden portable releases with locked dependency installation, exact tag validation, checksums, prerelease handling, least-privilege jobs, and build-provenance attestation.
- Document architecture, supported formats, privacy, retention, RENIEC processing, dependency provenance, and the unsigned release status.

## 1.1.1

- Current application release before changelog adoption.
