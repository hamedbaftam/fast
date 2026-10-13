'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const SERVER_LOCATION = process.env.SERVER_LOCATION || os.hostname();
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BYTES = 100 * 1024 * 1024;
const CHUNK = crypto.randomBytes(1024 * 1024); // 1MB of incompressible data

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...NO_CACHE, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function clientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}

function handleDownload(req, res, url) {
  let remaining = Math.min(Math.max(parseInt(url.searchParams.get('bytes'), 10) || 25 * 1024 * 1024, 1), MAX_BYTES);
  res.writeHead(200, {
    ...NO_CACHE,
    'Content-Type': 'application/octet-stream',
    'Content-Length': remaining,
    'Content-Encoding': 'identity',
  });

  let closed = false;
  req.on('close', () => { closed = true; });

  const pump = () => {
    while (remaining > 0 && !closed) {
      const n = Math.min(remaining, CHUNK.length);
      remaining -= n;
      const ok = res.write(n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n));
      if (!ok) { res.once('drain', pump); return; }
    }
    if (!closed) res.end();
  };
  pump();
}

function handleUpload(req, res) {
  let bytes = 0;
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) {
      sendJSON(res, 413, { error: 'Payload too large' });
      req.destroy();
    }
  });
  req.on('end', () => { if (!res.headersSent) sendJSON(res, 200, { bytes }); });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') { res.writeHead(204, NO_CACHE); return res.end(); }

  switch (url.pathname) {
    case '/api/download':
      return handleDownload(req, res, url);
    case '/api/upload':
      if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Use POST' });
      return handleUpload(req, res);
    case '/api/ping':
      res.writeHead(200, { ...NO_CACHE, 'Content-Type': 'text/plain', 'Content-Length': 1 });
      return res.end('1');
    case '/api/info':
      return sendJSON(res, 200, { ip: clientIP(req), server: SERVER_LOCATION });
    default:
      if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, url);
  }
});

server.listen(PORT, () => {
  console.log(`Speed test running at http://localhost:${PORT}`);
});
