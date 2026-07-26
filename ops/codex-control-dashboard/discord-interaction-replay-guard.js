'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000;

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function createDiscordInteractionReplayGuard(options = {}) {
  const statePath = options.statePath || '/home/ubuntu/.hermes/state/discord-interaction-replay-v1.json';
  const now = options.now || (() => new Date());
  const maxAgeMs = Number(options.maxAgeMs || DEFAULT_MAX_AGE_MS);
  const retentionMs = Number(options.retentionMs || DEFAULT_RETENTION_MS);

  function isFresh(timestamp) {
    if (!/^\d{10}$/.test(String(timestamp || ''))) return false;
    const issuedAt = Number(timestamp) * 1000;
    const current = now().getTime();
    return Number.isFinite(issuedAt) && Math.abs(current - issuedAt) <= maxAgeMs;
  }

  function claim(interactionId) {
    const id = String(interactionId || '');
    if (!/^\d{16,24}$/.test(id)) return false;
    const current = now().getTime();
    const claimDirectory = `${statePath}.claims`;
    const claimPath = path.join(claimDirectory, crypto.createHash('sha256').update(id).digest('hex'));
    let claimFd;
    try {
      fs.mkdirSync(claimDirectory, { recursive: true, mode: 0o700 });
      try {
        claimFd = fs.openSync(claimPath, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') return false;
        const claimedAt = Number(fs.readFileSync(claimPath, 'utf8'));
        if (!Number.isFinite(claimedAt) || current - claimedAt <= retentionMs) return false;
        fs.unlinkSync(claimPath);
        claimFd = fs.openSync(claimPath, 'wx', 0o600);
      }
      fs.writeFileSync(claimFd, String(current), 'utf8');
      fs.fsyncSync(claimFd);
      fs.closeSync(claimFd);
      claimFd = undefined;
    } catch {
      if (claimFd !== undefined) fs.closeSync(claimFd);
      return false;
    }
    let seen = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') seen = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        try { fs.unlinkSync(claimPath); } catch {}
        return false;
      }
    }
    seen = Object.fromEntries(Object.entries(seen).filter(([, claimedAt]) => (
      Number.isFinite(claimedAt) && current - claimedAt <= retentionMs
    )));
    if (Object.prototype.hasOwnProperty.call(seen, id)) {
      try { fs.unlinkSync(claimPath); } catch {}
      return false;
    }
    seen[id] = current;
    try {
      atomicWrite(statePath, seen);
    } catch {
      try { fs.unlinkSync(claimPath); } catch {}
      return false;
    }
    return true;
  }

  return Object.freeze({ isFresh, claim });
}

module.exports = { DEFAULT_MAX_AGE_MS, createDiscordInteractionReplayGuard };
