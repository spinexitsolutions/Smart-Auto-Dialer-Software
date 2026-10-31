'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load .env (simple KEY=VALUE parser, no dependency)
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  // Persist a random secret so tokens survive restarts without manual config.
  const file = path.join(dataDir, '.jwt_secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(48).toString('hex');
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, s, { mode: 0o600 });
    } catch { /* read-only FS: fall back to in-memory secret */ }
    return s;
  }
}

module.exports = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  dataDir,
  dbFile: process.env.DB_FILE || path.join(dataDir, 'dialer.db'),
  uploadsDir: process.env.UPLOADS_DIR || path.join(dataDir, 'recordings'),
  jwtSecret: loadSecret(),
  jwtExpires: process.env.JWT_EXPIRES || '7d',
  brandName: process.env.BRAND_NAME || 'Smart Auto Dialer',
  maxRecordingMb: Number(process.env.MAX_RECORDING_MB) || 50,
};
