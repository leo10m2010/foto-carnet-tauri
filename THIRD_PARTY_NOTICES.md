# Third-Party Notices and Provenance

FotoCarnet depends on open-source software. This inventory is informational; the corresponding upstream license terms control. Preserve license headers when redistributing vendored files.

## Browser Libraries Shipped in `src/vendor/`

| Component                          | Version | License        | Upstream                               |
| ---------------------------------- | ------- | -------------- | -------------------------------------- |
| JSZip                              | 3.10.1  | MIT or GPL-3.0 | <https://stuk.github.io/jszip/>        |
| jsPDF                              | 4.2.1   | MIT            | <https://github.com/parallax/jsPDF>    |
| JsBarcode                          | 3.12.3  | MIT            | <https://github.com/lindell/JsBarcode> |
| Lucide                             | 1.7.0   | ISC            | <https://lucide.dev/>                  |
| SheetJS Community Edition (`xlsx`) | 0.18.5  | Apache-2.0     | <https://sheetjs.com/>                 |

These minified files are committed source artifacts and are not fetched during the release workflow. Their embedded headers are the immediate provenance record; maintainers should verify upstream checksums and licenses when updating them.

## Build and Runtime Dependencies

- Exact npm tool versions and registry integrity hashes are recorded in `package-lock.json`; releases use `npm ci`.
- Exact resolved Rust crates, checksums, and dependency graph are recorded in `src-tauri/Cargo.lock`; checks and builds use `cargo --locked` semantics.
- Direct Rust dependencies and requested feature sets are declared in `src-tauri/Cargo.toml`.
- Workflow actions are pinned to full commit SHAs. Adjacent comments record the published release tag whose commit was resolved and reviewed; update both together when upgrading an action.
- GitHub Actions records build-provenance attestations for released executables and checksum files.

Transitive notices can be reviewed from `npm ls --all`, `npm view <package> license`, `cargo metadata --locked`, and the two lockfiles. A release attestation proves which repository workflow produced an artifact; it does not audit every upstream source or provide code signing.
