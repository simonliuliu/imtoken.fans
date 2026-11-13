import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import parser from '@typescript-eslint/parser';

const root = await mkdtemp(path.join(tmpdir(), 'imtoken-eslint-probe-'));
await mkdir(path.join(root, 'src'));
await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({compilerOptions:{strict:true}, include:['src/**/*.ts']}));
await writeFile(path.join(root, 'src', 'included.ts'), 'export const included = 1;');
await writeFile(path.join(root, 'scratch.ts'), 'export const scratch = 1;');
await writeFile(path.join(root, '.hidden.ts'), 'export const hidden = 1;');
await writeFile(path.join(root, 'denied.ts'), 'export const denied = 1;');
const options = {tsconfigRootDir:root, projectService:{allowDefaultProject:['scratch.ts','.hidden.ts']}, ecmaVersion:2022,sourceType:'module'};

test('project service permits explicitly allowlisted TypeScript file', () => {
  const result=parser.parseForESLint('export const scratch = 1;', {...options,filePath:path.join(root,'scratch.ts')});
  assert.ok(result.services.program);
});
test('project service permits explicitly allowlisted dotfile', () => {
  const result=parser.parseForESLint('export const hidden = 1;', {...options,filePath:path.join(root,'.hidden.ts')});
  assert.ok(result.services.program);
});
test('project service rejects an unmatched file', () => {
  assert.throws(() => parser.parseForESLint('export const denied = 1;', {...options,filePath:path.join(root,'denied.ts')}), /does not match/);
});
test.after(async () => { await rm(root,{recursive:true,force:true}); });
