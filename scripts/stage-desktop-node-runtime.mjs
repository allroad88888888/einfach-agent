import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, rename, rm, stat, writeFile, copyFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

export const NODE_VERSION = '22.13.0';

const releases = {
  'aarch64-apple-darwin': ['darwin-arm64', 'tar.gz', 'bc1e374e7393e2f4b20e5bbc157d02e9b1fb2c634b2f992136b38fb8ca2023b7'],
  'x86_64-apple-darwin': ['darwin-x64', 'tar.gz', 'cfaaf5edde585a15547f858f5b3b62a292cf5929a23707b6f1e36c29a32487be'],
  'aarch64-unknown-linux-gnu': ['linux-arm64', 'tar.gz', 'e0cc088cb4fb2e945d3d5c416c601e1101a15f73e0f024c9529b964d9f6dce5b'],
  'x86_64-unknown-linux-gnu': ['linux-x64', 'tar.gz', '9a33e89093a0d946c54781dcb3ccab4ccf7538a7135286528ca41ca055e9b38f'],
  'aarch64-pc-windows-msvc': ['win-arm64', 'zip', '8ca2c90ae0373d69e13301293306c31ea9afca2780b8325b6ca059319479e560'],
  'aarch64-pc-windows-gnu': ['win-arm64', 'zip', '8ca2c90ae0373d69e13301293306c31ea9afca2780b8325b6ca059319479e560'],
  'x86_64-pc-windows-msvc': ['win-x64', 'zip', 'b0feb09ebf41328628e7383f7a092fb7342ce1e05c867a90cf8f1379205a8429'],
  'x86_64-pc-windows-gnu': ['win-x64', 'zip', 'b0feb09ebf41328628e7383f7a092fb7342ce1e05c867a90cf8f1379205a8429'],
};

export function resolveRelease(target) {
  const release = releases[target];
  if (!release) {
    throw new Error(`Unsupported Tauri target: ${target}`);
  }

  const [nodePlatform, archiveExtension, sha256] = release;
  const archiveName = `node-v${NODE_VERSION}-${nodePlatform}.${archiveExtension}`;
  return {
    archiveExtension,
    archiveName,
    nodePlatform,
    sha256,
    target,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`,
    windows: archiveExtension === 'zip',
  };
}

export function outputFileName(target) {
  return `einfach-agent-node-${target}${resolveRelease(target).windows ? '.exe' : ''}`;
}

export async function verifyArchive(archivePath, expectedSha256) {
  let archive;
  try {
    archive = await readFile(archivePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Missing Node archive: ${archivePath}`);
    }
    throw error;
  }

  const actualSha256 = createHash('sha256').update(archive).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(`SHA-256 mismatch for ${archivePath}: expected ${expectedSha256}, got ${actualSha256}`);
  }
}

async function downloadArchive(release, archivePath) {
  const response = await fetch(release.url);
  if (!response.ok) {
    throw new Error(`Unable to download ${release.url}: HTTP ${response.status}`);
  }

  const temporaryPath = `${archivePath}.${process.pid}.download`;
  try {
    await writeFile(temporaryPath, Buffer.from(await response.arrayBuffer()));
    await verifyArchive(temporaryPath, release.sha256);
    await rename(temporaryPath, archivePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function ensureArchive(release, cacheDirectory) {
  const archivePath = path.join(cacheDirectory, release.archiveName);
  try {
    await stat(archivePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await downloadArchive(release, archivePath);
  }
  await verifyArchive(archivePath, release.sha256);
  return archivePath;
}

function powerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function extractArchive(release, archivePath, destination) {
  if (release.archiveExtension === 'tar.gz') {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destination]);
    return;
  }

  if (process.platform !== 'win32') {
    throw new Error(`Windows archive ${archivePath} must be staged on Windows`);
  }
  const command = `Expand-Archive -LiteralPath ${powerShellLiteral(archivePath)} -DestinationPath ${powerShellLiteral(destination)} -Force`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
}

function extractedExecutablePath(release, extractionDirectory) {
  const executable = release.windows ? 'node.exe' : path.join('bin', 'node');
  return path.join(extractionDirectory, `node-v${NODE_VERSION}-${release.nodePlatform}`, executable);
}

export async function stageNodeRuntime(target, options = {}) {
  const release = resolveRelease(target);
  const desktopDirectory = options.desktopDirectory ?? path.join(repositoryRoot, 'apps', 'desktop');
  const cacheDirectory = options.cacheDirectory ?? path.join(desktopDirectory, '.cache', 'node-runtime');
  const binariesDirectory = options.binariesDirectory ?? path.join(desktopDirectory, 'binaries');
  const extractionDirectory = path.join(cacheDirectory, `${release.nodePlatform}-${process.pid}.extract`);
  const outputPath = path.join(binariesDirectory, outputFileName(target));

  await mkdir(cacheDirectory, { recursive: true });
  await mkdir(binariesDirectory, { recursive: true });
  const archivePath = await ensureArchive(release, cacheDirectory);

  await rm(extractionDirectory, { force: true, recursive: true });
  await mkdir(extractionDirectory, { recursive: true });
  try {
    await extractArchive(release, archivePath, extractionDirectory);
    const sourcePath = extractedExecutablePath(release, extractionDirectory);
    await stat(sourcePath);
    const temporaryOutputPath = `${outputPath}.${process.pid}.tmp`;
    await copyFile(sourcePath, temporaryOutputPath);
    if (!release.windows) await chmod(temporaryOutputPath, 0o755);
    await rm(outputPath, { force: true });
    await rename(temporaryOutputPath, outputPath);
  } finally {
    await rm(extractionDirectory, { force: true, recursive: true });
  }
  return outputPath;
}

function targetFromArguments(argumentsList) {
  const targetIndex = argumentsList.indexOf('--target');
  const target = argumentsList[targetIndex + 1];
  if (targetIndex === -1 || !target || target.startsWith('--')) {
    throw new Error('Usage: node scripts/stage-desktop-node-runtime.mjs --target <tauri-target-triple>');
  }
  return target;
}

async function main() {
  const outputPath = await stageNodeRuntime(targetFromArguments(process.argv.slice(2)));
  console.log(`Staged Node v${NODE_VERSION}: ${outputPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
