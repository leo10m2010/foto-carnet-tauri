import { describe, expect, it } from 'vitest';

import { cargoPackageVersion, readVersions, validateVersions } from './scripts/check-version.mjs';

describe('version consistency checker', () => {
  it('reads the package version rather than a dependency version from Cargo.toml', () => {
    expect(
      cargoPackageVersion(
        '[package]\nname = "app"\nversion = "2.3.4"\n\n[dependencies]\nlib = "9"\n'
      )
    ).toBe('2.3.4');
  });

  it('reads a package section at the end of Cargo.toml', () => {
    expect(cargoPackageVersion('[package]\nname = "app"\nversion = "3.0.0"\n')).toBe('3.0.0');
  });

  it('accepts aligned repository versions and the exact release tag', () => {
    const versions = Object.fromEntries(
      Object.keys(readVersions()).map((file) => [file, '1.2.3-rc.1'])
    );
    expect(validateVersions(versions, 'v1.2.3-rc.1')).toEqual([]);
  });

  it('reports drift and a mismatched release tag', () => {
    const versions = {
      'package.json': '1.2.3',
      'package-lock.json': '1.2.2',
      'package-lock.json root package': '1.2.3',
      'src-tauri/tauri.conf.json': '1.2.3',
      'src-tauri/Cargo.toml': '1.2.3'
    };

    expect(validateVersions(versions, 'v1.2.4')).toEqual([
      'package-lock.json is 1.2.2; expected 1.2.3',
      'release tag is v1.2.4; expected v1.2.3'
    ]);
  });

  it('passes for the repository as checked out', () => {
    expect(validateVersions(readVersions())).toEqual([]);
  });
});
