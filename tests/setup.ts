import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Expose sample bytes to tests without needing a browser fetch.
export function sampleBytes(name: string): Uint8Array {
  const path = resolve(__dirname, '..', 'public', 'samples', name);
  return new Uint8Array(readFileSync(path));
}

// jsdom lacks structuredClone in some builds; the worker shim uses it.
if (typeof structuredClone !== 'function') {
  (globalThis as unknown as { structuredClone: <T>(v: T) => T }).structuredClone = (v) => JSON.parse(JSON.stringify(v));
}
