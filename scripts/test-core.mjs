import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

rmSync('.tmp-tests', { recursive: true, force: true });
const compiler = resolve('node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
execFileSync(compiler, ['src/lib/calculations.ts', '--target', 'ES2022', '--module', 'ES2022', '--outDir', '.tmp-tests'], { stdio: 'inherit', shell: process.platform === 'win32' });
execFileSync(process.execPath, ['--test', 'tests/finance-core.test.mjs'], { stdio: 'inherit' });
