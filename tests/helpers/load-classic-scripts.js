import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

function createDocumentStub() {
  return {
    createElement() {
      let text = '';
      return {
        set textContent(value) {
          text = String(value ?? '');
        },
        get innerHTML() {
          return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
      };
    }
  };
}

export function loadClassicScripts(...relativePaths) {
  const context = vm.createContext({
    console,
    document: createDocumentStub(),
    URL
  });

  for (const relativePath of relativePaths) {
    const absolutePath = resolve(relativePath);
    const source = readFileSync(absolutePath, 'utf8');
    new vm.Script(source, { filename: absolutePath }).runInContext(context);
  }

  return context;
}
