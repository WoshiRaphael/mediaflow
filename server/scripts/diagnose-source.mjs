// Operator-only, bounded diagnostics. Never expose this command as an HTTP endpoint.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { validateUrl, resolvePublicAddress } from '../dist/security.js';

const LIMIT = 64 * 1024;
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : 'DIAGNOSTIC_FAILED';

export function diagnosticFlags(text) {
  const rules = [
    ['BOT_CHECK_MESSAGE', /confirm you.re not a bot|unusual traffic|automated requests|not a robot/i],
    ['SIGN_IN_MESSAGE', /sign.?in|log.?in|authentication|members.only|cookies/i],
    ['JS_RUNTIME_MESSAGE', /javascript runtime|js runtime|deno|EJS/i],
    ['JS_CHALLENGE_MESSAGE', /n challenge|nsig|signature extraction|challenge solving|challenge solver/i],
    ['TOKEN_MESSAGE', /PO.?Token|proof.of.origin/i],
    ['FORMAT_MESSAGE', /requested format.*not available|no video formats|no downloadable format/i],
    ['UNSUPPORTED_URL_MESSAGE', /unsupported URL|not a valid URL/i],
    ['HTTP_403', /HTTP Error 403|403 Forbidden/i],
    ['HTTP_429', /HTTP Error 429|429 Too Many Requests/i],
    ['TLS_ERROR', /CERTIFICATE_VERIFY_FAILED|certificate verify failed|SSL.*error/i],
    ['TUNNEL_ERROR', /Tunnel connection failed|ProxyError|proxy error/i],
    ['DNS_ERROR', /Name or service not known|name resolution|nodename nor servname/i],
    ['CONNECTION_ERROR', /Remote end closed|Connection reset|Connection refused/i],
    ['TIMEOUT_MESSAGE', /timed? out|timeout/i],
    ['PYTHON_MODULE_ERROR', /ModuleNotFoundError|ImportError/i],
  ];
  const flags = rules.filter(([, pattern]) => pattern.test(text)).map(([flag]) => flag);
  return flags.length ? flags : ['UNKNOWN'];
}

export function redactDiagnostic(value, sensitiveValues = []) {
  let text = String(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/https?:\/\/[^\s"'<>`]+/gi, '[URL]')
    .replace(/https?:\\\/\\\/[^\s"'<>`]+/gi, '[URL]')
    .replace(/https?%3a(?:%2f){2}[^\s"'<>`]+/gi, '[URL]')
    .replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, '[AUTH]')
    .replace(/\b(?:token|signature|sig|password|passwd|authorization|cookie|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '[SECRET]')
    .replace(/[?&][A-Za-z][A-Za-z0-9_-]{0,50}=[^\s&#]+/g, '[QUERY]');
  for (const value of sensitiveValues) if (typeof value === 'string' && value.length >= 8) text = text.split(value).join('[REDACTED]');
  return text
    .replace(/\b[A-Za-z0-9_+/%=-]{32,}\b/g, '[OPAQUE]')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]+/g, '[PATH]')
    .replace(/\/(?:home|tmp|var|opt|usr|Users|app|srv|render)\/[^\s"'<>]+/g, '[PATH]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\r\n?/g, '\n');
}

async function main() {
  if (process.argv.length !== 3) {
    console.log(JSON.stringify({ outcome: 'usage_error', code: 'INVALID_INPUT', usage: 'node server/scripts/diagnose-source.mjs <public-https-url>' }));
    process.exitCode = 1;
    return;
  }
  let config;
  try { config = loadConfig(); }
  catch { console.log(JSON.stringify({ outcome: 'error', code: 'CONFIGURATION_INVALID', flags: ['CONFIGURATION_ERROR'], exitCode: null, stderrLines: [] })); return; }
  let input;
  try { input = validateUrl(process.argv[2], config); }
  catch (error) {
    console.log(JSON.stringify({ outcome: 'usage_error', code: safeCode(error?.code) }));
    process.exitCode = 1;
    return;
  }
  try { await resolvePublicAddress(input.hostname); }
  catch (error) {
    const unsafe = error?.code === 'UNSAFE_SOURCE';
    console.log(JSON.stringify({ outcome: unsafe ? 'usage_error' : 'error', code: safeCode(error?.code), flags: [unsafe ? 'UNSAFE_SOURCE' : 'DNS_ERROR'], exitCode: null, stderrLines: [] }));
    if (unsafe) process.exitCode = 1;
    return;
  }

  const originalSpawn = childProcess.spawn;
  const buffers = [];
  let captured = 0;
  let stderrBytes = 0;
  let exitCode = null;
  let spawnCode;
  const started = Date.now();
  childProcess.spawn = function(command, args, options) {
    const extractor = command === config.pythonPath && Array.isArray(args) && args.includes(config.extractorPath);
    // Warnings are useful to operators. All other production arguments and
    // the same checked/pinned egress transport are retained unchanged.
    const child = originalSpawn.call(this, command, extractor ? args.filter(arg => arg !== '--no-warnings') : args, options);
    if (extractor) {
      child.stderr?.on('data', bytes => {
        stderrBytes += bytes.length;
        const available = LIMIT - captured;
        if (available > 0) { const chunk = Buffer.from(bytes).subarray(0, available); buffers.push(chunk); captured += chunk.length; }
      });
      child.once('close', code => { exitCode = Number.isInteger(code) ? code : null; });
      child.once('error', error => { spawnCode = safeCode(error.code); });
    }
    return child;
  };
  syncBuiltinESMExports();
  try {
    const { extractVideoPage } = await import('../dist/extractor.js');
    const result = await extractVideoPage(input.href, config);
    console.log(JSON.stringify({ outcome: 'success', title: redactDiagnostic(result.title).slice(0, 180), platform: result.platform, formatCount: result.formats.length }));
  } catch (error) {
    const detail = Buffer.concat(buffers).toString('utf8');
    const sensitive = [config.pythonPath, config.extractorPath, config.denoPath, config.ffmpegPath, ...input.searchParams.values()];
    const stderrLines = redactDiagnostic(detail, sensitive).split('\n').map(line => line.trim()).filter(Boolean).slice(-8).map(line => line.length > 400 ? `${line.slice(0, 397)}...` : line);
    console.log(JSON.stringify({ outcome: 'error', code: safeCode(error?.code), flags: diagnosticFlags(detail), exitCode, ...(spawnCode ? { spawnCode } : {}), elapsedMs: Date.now() - started, stderrBytes, stderrLines }));
    // An inaccessible source must not fail a deployment's temporary diagnostic.
    process.exitCode = 0;
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
}

// Importable redaction helpers permit a canary check without any network call.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
