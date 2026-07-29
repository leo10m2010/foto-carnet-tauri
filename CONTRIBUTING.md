# Contributing

FotoCarnet is developed and tested on Windows 10/11 x64. Install Node.js 22.13+, the Tauri Windows prerequisites, and `rustup`; `rust-toolchain.toml` selects the Rust version.

## Workflow

```powershell
npm ci
npm run check
npm run dev
```

- Keep changes focused and use synthetic DNI/name/photo fixtures in tests and reports.
- Never commit RENIEC tokens, real personal data, exports, local paths, or signing credentials.
- Add Vitest coverage for pure behavior. Browser-global scripts can be loaded with `tests/helpers/load-classic-scripts.js` without converting production modules.
- `npm run format` intentionally excludes `src/**`, `src-tauri/**`, generated lockfiles, and vendored code. Avoid unrelated mass formatting.
- Keep `package.json`, both package-lock root versions, `src-tauri/tauri.conf.json`, and the Cargo package version aligned.
- Do not update dependencies manually in lockfiles. Use `npm install` for npm packages and Cargo tooling for Rust dependencies.

Pull requests should explain behavior and privacy impact, list verification performed, and call out limitations. CI runs the complete Windows quality gate on pushes and pull requests.
