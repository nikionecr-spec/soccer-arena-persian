/* Entry point: HTTP (REST + static client) + WebSocket on the same port. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { createStore } = require('./store');
const { Lobby } = require('./lobby');
const { makeRestHandler } = require('./rest');

async function main() {
  const store = createStore();
  await store.init();
  const lobby = new Lobby(store);
  const handleRest = makeRestHandler(store);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) return await handleRest(req, res, pathname);
      // static client (single self-contained HTML) — for local dev without Nginx
      const clientFile = config.STATIC_CLIENT || path.join(__dirname, '..', '..', 'client', 'index.html');
      if (pathname === '/' || pathname === '/index.html') {
        try {
          const data = fs.readFileSync(clientFile);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          return res.end(data);
        } catch (e) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('client file not found');
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (e) {
      console.error('[http] error on', pathname, e.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'server_error', message: 'خطای داخلی سرور' }));
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (conn, req) => {
    conn.isAlive = true;
    conn.on('pong', () => { conn.isAlive = true; });

    // optional token in upgrade URL: /ws?token=...
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (token) lobby.onAuth(conn, token);
    } catch (e) { /* auth via message instead */ }

    conn.on('message', raw => {
      try { lobby.onMessage(conn, String(raw)); }
      catch (e) {
        console.error('[ws] handler error:', e.message);
        try { conn.send(JSON.stringify({ t: 'error', code: 'server_error', message: 'خطای داخلی سرور' })); } catch (e2) { /* ignore */ }
      }
    });
    conn.on('close', () => lobby.onConnClosed(conn));
    conn.on('error', () => { /* close will follow */ });
  });

  // heartbeat: drop dead connections
  const beat = setInterval(() => {
    for (const conn of wss.clients) {
      if (!conn.isAlive) { try { conn.terminate(); } catch (e) { /* ignore */ } continue; }
      conn.isAlive = false;
      try { conn.ping(); } catch (e) { /* ignore */ }
    }
  }, 15000);
  beat.unref();

  server.listen(config.PORT, config.HOST, () => {
    console.log('Soccer Arena Persian server listening on ' + config.HOST + ':' + config.PORT);
    console.log('  store: ' + store.kind + ' | turnSeconds: ' + config.TURN_SECONDS + ' | targetGoals: ' + config.TARGET_GOALS);
  });

  process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
  process.on('SIGINT', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
}

main().catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});
