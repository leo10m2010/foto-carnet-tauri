import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceDirectory = resolve('src/js');

function findJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findJavaScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  });
}

const files = findJavaScriptFiles(sourceDirectory).sort();
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout);
  }
}

if (failed) process.exitCode = 1;
else
  console.log(
    `JavaScript syntax OK: ${files.length} files in ${relative(process.cwd(), sourceDirectory)}`
  );
