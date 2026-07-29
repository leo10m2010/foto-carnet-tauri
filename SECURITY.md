# Security Policy

## Supported Versions

Security fixes are applied to the latest published release only. Older portable binaries should be upgraded rather than assumed supported.

## Reporting

Use GitHub's private security advisory feature for this repository when available. Otherwise contact the repository owner privately. Do not open a public issue containing DNI values, names, photos, RENIEC tokens, source files, exports, or exploit details.

Include the affected version, Windows version, reproduction steps using synthetic data, impact, and any proposed mitigation. Remove credentials and personal information from logs and screenshots.

## Release Trust

Release automation produces a SHA-256 checksum and a GitHub build-provenance attestation. These establish artifact integrity and workflow provenance but are not a substitute for Windows Authenticode signing.

Published binaries are currently unsigned. Code signing is required for a mature trusted-distribution process and is deferred until a protected certificate and CI credentials are available. Never bypass a Windows warning based solely on repository documentation; verify the checksum, attestation, tag, and publisher context.
