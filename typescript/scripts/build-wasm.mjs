import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const typescriptDirectory = resolve(scriptDirectory, '..');
const repositoryDirectory = resolve(typescriptDirectory, '..');
const wasmOutput = resolve(typescriptDirectory, 'dist/wasm');
const workletOutput = resolve(typescriptDirectory, 'dist/audio-worklet');

run('cargo', [
  'build',
  '--locked',
  '--manifest-path',
  resolve(repositoryDirectory, 'Cargo.toml'),
  '--package',
  'abrahamahn-audio-core',
  '--target',
  'wasm32-unknown-unknown',
  '--release',
  '--features',
  'wasm',
]);

rmSync(wasmOutput, { recursive: true, force: true });
rmSync(workletOutput, { recursive: true, force: true });
mkdirSync(wasmOutput, { recursive: true });
mkdirSync(workletOutput, { recursive: true });

run('wasm-bindgen', [
  resolve(repositoryDirectory, 'target/wasm32-unknown-unknown/release/audio_core.wasm'),
  '--target',
  'web',
  '--no-typescript',
  '--out-dir',
  wasmOutput,
  '--out-name',
  'audio_core_wasm',
]);

const gluePath = resolve(wasmOutput, 'audio_core_wasm.js');
const glue = readFileSync(gluePath, 'utf8')
  .replace('export class WasmEffectChain', 'class WasmEffectChain')
  .replace('export function wasmMemory', 'function wasmMemory')
  .replace(/\nexport \{ initSync, __wbg_init as default \};\s*$/u, '\n');
const processor = readFileSync(
  resolve(typescriptDirectory, 'worklet/rust-effects-processor.js'),
  'utf8',
).replace(
  "import { initSync, wasmMemory, WasmEffectChain } from '../wasm/audio_core_wasm.js';\n\n",
  '',
);
if (glue.includes('export ') || processor.startsWith('import ')) {
  throw new Error('unexpected wasm-bindgen or worklet module shape');
}
const textDecoderShim = `const TextDecoder = globalThis.TextDecoder ?? class {
  decode(bytes = new Uint8Array()) {
    let result = '';
    for (let index = 0; index < bytes.length;) {
      const first = bytes[index++] ?? 0;
      if (first < 0x80) {
        result += String.fromCodePoint(first);
        continue;
      }
      const length = first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
      let codePoint = first & (0x7f >> length);
      for (let offset = 1; offset < length; offset += 1) {
        codePoint = (codePoint << 6) | ((bytes[index++] ?? 0) & 0x3f);
      }
      result += String.fromCodePoint(codePoint);
    }
    return result;
  }
};`;
writeFileSync(
  resolve(workletOutput, 'rust-effects-processor.js'),
  `${textDecoderShim}\n${glue}\n${processor}`,
  'utf8',
);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryDirectory,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
