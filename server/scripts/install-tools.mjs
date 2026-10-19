import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const serverRoot = fileURLToPath(new URL('../', import.meta.url));
const binDirectory = path.join(serverRoot, '.bin');
const toolPath = path.join(binDirectory, 'yt-dlp');
const approvedHosts = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
const args = new Set(process.argv.slice(2));
const strictRuntime = args.has('--check-runtime');

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function approvedDownloadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !approvedHosts.has(url.hostname)) {
    throw new Error('The tool download redirected outside approved HTTPS GitHub release hosts.');
  }
  return url;
}

async function downloadArtifact(value, maximumBytes = 10 * 1024 * 1024) {
  let url = approvedDownloadUrl(value);
  // One deadline covers the complete redirect chain and body transfer.
  const signal = AbortSignal.timeout(60_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': 'MediaFlow-tools-installer/1.0', Accept: 'application/octet-stream' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error('The tool download exceeded its redirect limit.');
      url = approvedDownloadUrl(new URL(location, url).href);
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`The official tool download returned HTTP ${response.status}.`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (declared > maximumBytes) {
      await response.body.cancel();
      throw new Error('The tool download exceeds its installation size limit.');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > maximumBytes) {
          await reader.cancel();
          throw new Error('The tool download exceeds its installation size limit.');
        }
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      reader.releaseLock();
    }
    if (!size) throw new Error('The official tool download was empty.');
    return Buffer.concat(chunks, size);
  }
  throw new Error('The tool download exceeded its redirect limit.');
}

async function verifiedExisting(file, checksum) {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Installed tool files must not be symbolic links.');
    const existing = await readFile(file);
    if (digest(existing) !== checksum) return false;
    if (process.platform !== 'win32') await chmod(file, 0o755);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

async function installBytes(file, bytes) {
  const temporaryPath = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o755 });
    await rename(temporaryPath, file);
    if (process.platform !== 'win32') await chmod(file, 0o755);
  } finally {
    await unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function installTool(manifest) {
  const tool = manifest.ytDlp;
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(tool?.version ?? '') || !/^[a-f0-9]{64}$/.test(tool?.sha256 ?? '') || tool.artifact !== 'yt-dlp') {
    throw new Error('The tracked tool manifest is invalid.');
  }
  const expectedUrl = `https://github.com/yt-dlp/yt-dlp/releases/download/${tool.version}/yt-dlp`;
  if (tool.url !== expectedUrl) throw new Error('The manifest must point to a pinned official yt-dlp release.');
  if (await verifiedExisting(toolPath, tool.sha256)) {
    console.log(`[media-tools] yt-dlp ${tool.version}: verified existing artifact`);
    return;
  }
  const bytes = await downloadArtifact(tool.url);
  if (digest(bytes) !== tool.sha256) throw new Error('yt-dlp checksum verification failed. No downloaded code was installed or run.');
  await installBytes(toolPath, bytes);
  console.log(`[media-tools] yt-dlp ${tool.version}: downloaded and SHA-256 verified`);
}

// Parse only the single expected regular ZIP entry from a checksum-verified
// official release. No archive-supplied path is ever written to the filesystem.
export function extractBinary(zip, expectedEntry) {
  let end = -1;
  for (let index = zip.length - 22; index >= Math.max(0, zip.length - 65557); index--) {
    if (zip.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0) throw new Error('Unsupported Deno release archive.');
  const entries = zip.readUInt16LE(end + 10);
  const centralSize = zip.readUInt32LE(end + 12);
  let offset = zip.readUInt32LE(end + 16);
  const centralEnd = offset + centralSize;
  if (!entries || entries > 16 || centralEnd > end) throw new Error('Invalid Deno release archive directory.');
  let binary;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > centralEnd || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid Deno release archive entry.');
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const expandedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > centralEnd) throw new Error('Invalid Deno release archive entry size.');
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === expectedEntry) {
      if (binary || (flags & 1) || ![0, 8].includes(method) || expandedSize > 200 * 1024 * 1024 || localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Unsupported Deno binary archive entry.');
      const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
      if (start + compressedSize > offset) throw new Error('Invalid Deno binary archive bounds.');
      const compressed = zip.subarray(start, start + compressedSize);
      binary = method === 8 ? inflateRawSync(compressed, { maxOutputLength: 200 * 1024 * 1024 }) : Buffer.from(compressed);
      if (binary.length !== expandedSize) throw new Error('Deno binary archive size did not match.');
    }
    offset = next;
  }
  if (!binary) throw new Error('The expected Deno binary was not found in its release archive.');
  return binary;
}

async function installDeno(manifest) {
  const runtime = manifest.deno;
  const target = runtime?.targets?.[`${process.platform}-${process.arch}`];
  if (!/^\d+\.\d+\.\d+$/.test(runtime?.version ?? '') || !target || !/^[a-f0-9]{64}$/.test(target.archiveSha256 ?? '') || !/^[a-f0-9]{64}$/.test(target.binarySha256 ?? '') || !['deno', 'deno.exe'].includes(target.entry) || !/^deno-[a-z0-9_-]+\.zip$/.test(target.asset)) {
    throw new Error('Automatic Deno setup supports Linux x64 and Windows x64 with a valid tracked manifest.');
  }
  const destination = path.join(binDirectory, target.entry);
  if (await verifiedExisting(destination, target.binarySha256)) {
    console.log(`[media-tools] Deno ${runtime.version}: verified existing artifact`);
    return destination;
  }
  const zip = await downloadArtifact(`https://github.com/denoland/deno/releases/download/v${runtime.version}/${target.asset}`, 64 * 1024 * 1024);
  if (digest(zip) !== target.archiveSha256) throw new Error('Deno release archive checksum verification failed. No archive code was installed or run.');
  const binary = extractBinary(zip, target.entry);
  if (digest(binary) !== target.binarySha256) throw new Error('Deno binary checksum verification failed. No runtime was installed or run.');
  await installBytes(destination, binary);
  console.log(`[media-tools] Deno ${runtime.version}: downloaded, extracted, and SHA-256 verified`);
  return destination;
}

function checkRuntime(label, executable, arguments_, required) {
  const result = spawnSync(executable, arguments_, {
    shell: false,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  if (result.status === 0 && !result.error) {
    const line = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split(/\r?\n/).find(value => value.trim());
    console.log(`[media-tools] ${label}: ${line?.trim() || 'available'}`);
    return true;
  }
  const explanation = result.error?.message || `exited with status ${result.status ?? 'unknown'}`;
  console.warn(`[media-tools] ${label}: unavailable (${explanation}).`);
  if (required) throw new Error(`${label} is required for --check-runtime. Set its executable path or install the runtime.`);
  return false;
}

async function main() {
  for (const argument of args) {
    if (!['--check-runtime', '--help'].includes(argument)) throw new Error(`Unknown setup argument: ${argument}`);
  }
  if (args.has('--help')) {
    console.log('Install checksum-pinned yt-dlp and Deno artifacts in server/.bin. Existing matching files are reused.');
    console.log('Usage: node scripts/install-tools.mjs [--check-runtime]');
    console.log('--check-runtime: fail if Python, yt-dlp, Deno, FFmpeg, or FFprobe cannot execute.');
    console.log('Environment: PYTHON_PATH (default python3, or python on Windows), DENO_PATH (default installed binary), FFMPEG_PATH (default ffmpeg), FFPROBE_PATH (default ffprobe).');
    console.log('The API resolves EXTRACTOR_PATH separately; use the installed server/.bin/yt-dlp artifact.');
    return;
  }
  const manifest = JSON.parse(await readFile(path.join(serverRoot, '.tools-version.json'), 'utf8'));
  await mkdir(binDirectory, { recursive: true });
  if ((await lstat(binDirectory)).isSymbolicLink()) throw new Error('The tool installation directory must not be a symbolic link.');
  await installTool(manifest);
  const deno = await installDeno(manifest);
  checkRuntime('Node', process.execPath, ['--version'], true);
  checkRuntime('Deno', process.env.DENO_PATH || deno, ['--version'], true);
  const python = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  // Keep ffprobe next to a custom FFmpeg executable unless explicitly set.
  const ffprobe = process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH
    ? path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : 'ffprobe');
  const pythonAvailable = checkRuntime('Python', python, ['--version'], strictRuntime);
  if (pythonAvailable) checkRuntime('yt-dlp', python, [toolPath, '--ignore-config', '--no-plugin-dirs', '--version'], strictRuntime);
  checkRuntime('FFmpeg', ffmpeg, ['-version'], strictRuntime);
  checkRuntime('FFprobe', ffprobe, ['-version'], strictRuntime);
  if (!strictRuntime) console.log('[media-tools] Pass --check-runtime in production builds to require all media runtimes.');
}

const invokedFile = process.argv[1] && path.resolve(process.argv[1]);
const moduleFile = fileURLToPath(import.meta.url);
if (invokedFile && (process.platform === 'win32' ? invokedFile.toLowerCase() === moduleFile.toLowerCase() : invokedFile === moduleFile)) {
  main().catch(error => {
    console.error(`[media-tools] ${error.message}`);
    process.exitCode = 1;
  });
}
