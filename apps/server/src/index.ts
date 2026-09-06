import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createMemoryStore } from './store/memory-store.js';
import { initializeLiquidity } from './store/liquidity-seed.js';
import { createSessionService } from './services/session.service.js';
import { createRealtimeService } from './services/realtime.service.js';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const config = readConfig();
const store = createMemoryStore({ matchingEngine: config.MATCHING_ENGINE });
if (config.ENABLE_DEMO_LIQUIDITY) initializeLiquidity(store);
const sessions = createSessionService(store, { ttlMs: config.SESSION_TTL_MS });
const realtime = createRealtimeService({ store, sessions, allowedOrigins: config.ALLOWED_ORIGINS });
const server = createServer(
  createApp({
    store,
    sessions,
    allowedOrigins: config.ALLOWED_ORIGINS,
    secureCookies: config.COOKIE_SECURE,
    onTradeCommitted: realtime.publishTrade,
  }),
);
realtime.attach(server);
const sessionCleanup = setInterval(() => sessions.pruneExpired(), 60_000);
sessionCleanup.unref();
server.once('close', () => clearInterval(sessionCleanup));

server.on('error', (error) => {
  clearInterval(sessionCleanup);
  realtime.close();
  console.error('Unable to start HTTP server:', error.message);
  process.exitCode = 1;
});
server.listen(config.PORT, config.HOST, () => {
  console.info(
    'Stock server listening on http://' +
      config.HOST +
      ':' +
      config.PORT +
      ' (matching: ' +
      store.matchingEngine +
      ')',
  );
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(sessionCleanup);
  realtime.close();
  console.info('Stopping stock server...');
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    process.exitCode = 1;
  }, 10_000);
  deadline.unref();
  server.close((error) => {
    clearTimeout(deadline);
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
