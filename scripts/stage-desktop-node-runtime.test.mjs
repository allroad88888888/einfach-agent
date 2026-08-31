import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NODE_VERSION, outputFileName, resolveRelease, verifyArchive } from './stage-desktop-node-runtime.mjs';

function rejectsWith(action, message) {
  return assert.rejects(action, new RegExp(message));
}

async function testTargetMapping() {
  const release = resolveRelease('aarch64-apple-darwin');
  assert.equal(release.archiveName, `node-v${NODE_VERSION}-darwin-arm64.tar.gz`);
  assert.equal(release.windows, false);
  assert.equal(resolveRelease('x86_64-pc-windows-msvc').archiveName, `node-v${NODE_VERSION}-win-x64.zip`);
  assert.throws(() => resolveRelease('riscv64-unknown-linux-gnu'), /Unsupported Tauri target/);
}

async function testArchiveVerification() {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'einfach-node-runtime-'));
  const archivePath = path.join(temporaryDirectory, 'node.tar.gz');
  try {
    await rejectsWith(() => verifyArchive(archivePath, '0'.repeat(64)), 'Missing Node archive');
    await writeFile(archivePath, 'archive data');
    const expectedSha256 = createHash('sha256').update('archive data').digest('hex');
    await verifyArchive(archivePath, expectedSha256);
    await rejectsWith(() => verifyArchive(archivePath, '0'.repeat(64)), 'SHA-256 mismatch');
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function testOutputNaming() {
  assert.equal(outputFileName('aarch64-apple-darwin'), 'einfach-agent-node-aarch64-apple-darwin');
  assert.equal(outputFileName('x86_64-pc-windows-msvc'), 'einfach-agent-node-x86_64-pc-windows-msvc.exe');
}

await testTargetMapping();
await testArchiveVerification();
await testOutputNaming();
console.log('stage-desktop-node-runtime tests passed');
