import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function cargoPackageVersion(source) {
  const packageStart = source.search(/^\[package\]\s*$/m);
  if (packageStart === -1) return '';
  const afterHeading = source.slice(packageStart).replace(/^\[package\]\s*$/m, '');
  const nextSection = afterHeading.search(/^\[/m);
  const packageSection = nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection);
  return packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? '';
}

export function readVersions(root = process.cwd()) {
  const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const packageJson = readJson('package.json');
  const packageLock = readJson('package-lock.json');
  const tauriConfig = readJson('src-tauri/tauri.conf.json');
  const cargoToml = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8');

  return {
    'package.json': packageJson.version,
    'package-lock.json': packageLock.version,
    'package-lock.json root package': packageLock.packages?.['']?.version,
    'src-tauri/tauri.conf.json': tauriConfig.version,
    'src-tauri/Cargo.toml': cargoPackageVersion(cargoToml)
  };
}

export function validateVersions(versions, tag = '') {
  const entries = Object.entries(versions);
  const canonical = versions['package.json'];
  const errors = [];

  if (!canonical || !SEMVER.test(canonical)) {
    errors.push(`package.json has an invalid semantic version: ${canonical || '<missing>'}`);
  }

  for (const [file, version] of entries) {
    if (!version) errors.push(`${file} has no version`);
    else if (canonical && version !== canonical) {
      errors.push(`${file} is ${version}; expected ${canonical}`);
    }
  }

  if (tag && tag !== `v${canonical}`) {
    errors.push(`release tag is ${tag}; expected v${canonical}`);
  }

  return errors;
}

function tagFromArguments(arguments_) {
  const equalsArgument = arguments_.find((argument) => argument.startsWith('--tag='));
  if (equalsArgument) return equalsArgument.slice('--tag='.length);
  const index = arguments_.indexOf('--tag');
  return index === -1 ? process.env.RELEASE_TAG || '' : arguments_[index + 1] || '';
}

export function main(arguments_ = process.argv.slice(2)) {
  const versions = readVersions();
  const tag = tagFromArguments(arguments_);
  const errors = validateVersions(versions, tag);

  if (errors.length) {
    for (const error of errors) console.error(`Version error: ${error}`);
    return 1;
  }

  console.log(`Version consistency OK: ${versions['package.json']}${tag ? ` (${tag})` : ''}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
