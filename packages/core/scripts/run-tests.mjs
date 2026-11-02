// Compile core + tests to CommonJS and run them with the built-in node:test runner.
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const out = '.test-dist';
rmSync(out, { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.test.json'], { stdio: 'inherit', cwd: process.cwd() });
writeFileSync(join(out, 'package.json'), '{"type":"commonjs"}\n');
if (process.argv.includes('--compile-only')) process.exit(0);
const files = readdirSync(join(out, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => join(out, 'test', f));
execFileSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
