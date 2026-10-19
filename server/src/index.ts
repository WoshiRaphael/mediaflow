import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp(config);
const server = createServer(app);
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.listen(config.port, '0.0.0.0', () => console.log(`MediaFlow API listening on port ${config.port}`));
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  // Stop preparation jobs immediately and remove private cached files while
  // HTTP connections drain. Closing sockets also cancels pending extraction.
  const cleanup: Promise<void> = app.locals.dispose();
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    void cleanup.then(() => process.exit(1), () => process.exit(1));
  }, 10000).unref();
  server.close(() => { void cleanup.then(() => { clearTimeout(deadline); process.exit(0); }, () => { clearTimeout(deadline); process.exit(1); }); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
