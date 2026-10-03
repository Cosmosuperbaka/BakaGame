import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../../Client/package.json', import.meta.url));
const picomatch = require('picomatch');
const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const block = workflow.split('            client:\n')[1].split('            e2e:\n')[0];
const rules = [...block.matchAll(/- '([^']+)'/g)].map(match => picomatch(match[1], { dot: true }));

for (const [path, expected] of [
  ['README.md', false], ['Agents/Testing.md', false], ['tools/build_bangumi_db.py', false],
  ['Server/src/Index.ts', false], ['Client/e2e/App.spec.ts', false], ['Client/e2e/fixtures/deep/a.ts', false],
  ['Client/src/a.ts', true], ['Client/src/deep/a.ts', true], ['Client/.storybook/main.ts', true],
  ['Client/package.json', true], ['Client/playwright.config.ts', true],
  ['.github/workflows/ci.yml', true], ['Server/src/shared/models/A.ts', true],
  ['Server/scripts/ClientCiFilter.mjs', true],
]) test(`client OR filter ${path} => ${expected}`, () => assert.equal(rules.some(rule => rule(path)), expected));
