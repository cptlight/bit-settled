'use strict';
/**
 * Minimal zero-dependency persistence for a single Space replica.
 *
 * Enabled only when STATE_PATH is set. Writes the whole in-memory `data.state`
 * atomically (tmp + rename), debounced so a burst of API writes creates one
 * snapshot. For a mounted Hugging Face Storage Bucket:
 *
 *   STATE_PATH=/data/settled-state.json
 *
 * This is a snapshot, not a transactional database. One replica only.
 */

const fs = require('fs');
const path = require('path');
const data = require('./data');

const FILE = process.env.STATE_PATH || '';
let timer = null;
let loaded = false;

function enabled() {
  return Boolean(FILE);
}

function load() {
  if (!FILE || loaded) return { loaded: false };
  loaded = true;
  try {
    if (!fs.existsSync(FILE)) return { loaded: false };
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { loaded: false };
    Object.assign(data.state, parsed);
    return { loaded: true, bytes: raw.length };
  } catch (err) {
    return { loaded: false, error: err.message };
  }
}

function saveNow() {
  if (!FILE) return false;
  try {
    const dir = path.dirname(FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data.state), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    return true;
  } catch (err) {
    process.stderr.write('[persist] save failed: ' + err.message + '\n');
    return false;
  }
}

function schedule() {
  if (!FILE) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    saveNow();
  }, 350);
  if (typeof timer.unref === 'function') timer.unref();
}

// Flush a pending debounced write when the container is stopped.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    if (timer) { clearTimeout(timer); timer = null; }
    saveNow();
    process.exit(0);
  });
}

module.exports = { enabled, load, schedule, saveNow, file: FILE };
