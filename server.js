/**
 * Simple Express server to run the app locally without Vercel.
 * Serves static files from /public and implements the /api/check, /api/health, and /api/ping routes.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// External leaderboard API base
const BASE = 'https://leaderboard-bice-mu.vercel.app/api/zama';
const TIMEFRAMES = [
  { key: '24h', label: 'Last 24 hours' },
  { key: '7d', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
];
const CACHE_TTL_SECONDS = 60 * 5; // 5 minutes

// In-memory cache
const cache = new Map();
function cacheSet(key, value, ttl = CACHE_TTL_SECONDS) {
  const expiresAt = Date.now() + ttl * 1000;
  cache.set(key, { value, expiresAt });
}
function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

// Helpers
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed ${r.status} ${url}`);
  return r.json();
}

function getArrayFromResponse(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.items)) return json.items;
  for (const v of Object.values(json || {})) {
    if (Array.isArray(v)) return v;
  }
  return [];
}

function normalize(entry, pageIdx, idxInPage, fallbackPageSize = 100) {
  if (!entry || typeof entry !== 'object') return null;

  const keys = Object.keys(entry);

  // detect username
  let username = null;
  for (const k of keys) {
    const lk = k.toLowerCase();
    if (
      lk.includes('username') ||
      lk.includes('user') ||
      lk.includes('twitter') ||
      lk.includes('handle') ||
      lk.includes('name') ||
      lk.includes('creator')
    ) {
      username = String(entry[k]);
      break;
    }
  }

  // mindshare
  let mindshare = null;
  if (entry.mindshare != null) mindshare = Number(entry.mindshare);

  // mindshare delta
  let mindshareDelta = null;
  if (entry.mindshareDelta != null) mindshareDelta = Number(entry.mindshareDelta);
  if (entry.mindshare_delta != null) mindshareDelta = Number(entry.mindshare_delta);

  // rank
  let rank = Number(entry.rank);
  if (!Number.isFinite(rank)) {
    rank = (pageIdx - 1) * fallbackPageSize + (idxInPage + 1);
  }

  if (typeof username === 'string') {
    username = username.trim().replace(/^@/, '');
  } else {
    // fallback: try values starting with @
    for (const v of Object.values(entry)) {
      if (typeof v === 'string' && v.startsWith('@')) {
        username = v.replace(/^@/, '');
        break;
      }
    }
  }

  return {
    rank,
    username,
    mindshare: Number.isFinite(mindshare) ? mindshare : null,
    mindshareDelta: Number.isFinite(mindshareDelta) ? mindshareDelta : null,
    raw: entry,
  };
}

async function fetchAllPagesForTimeframe(timeframeKey, maxPages = 20, pageSizeHint = 100) {
  const cacheKey = `tf:${timeframeKey}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${BASE}?timeframe=${encodeURIComponent(timeframeKey)}&sortBy=mindshare&page=${page}`;
      const json = await fetchJson(url);
      const arr = getArrayFromResponse(json);
      if (!arr || arr.length === 0) break;
      for (let i = 0; i < arr.length; i++) {
        const normalized = normalize(arr[i], page, i, pageSizeHint);
        if (normalized && normalized.username) results.push(normalized);
      }
    } catch (err) {
      console.warn('fetch page error', err.message);
      break;
    }
  }

  cacheSet(cacheKey, results);
  return results;
}

// API routes
app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/api/ping', (_req, res) => {
  res.status(200).json({ message: 'pong' });
});

app.get('/api/check', async (req, res) => {
  try {
    const raw = String(req.query?.username || '').trim();
    if (!raw) return res.status(400).json({ error: 'missing username' });
    const username = raw.replace(/^@/, '').toLowerCase();

    const timeframePromises = TIMEFRAMES.map(async (tf) => {
      const entries = await fetchAllPagesForTimeframe(tf.key, 20, 100);
      return { key: tf.key, label: tf.label, entries };
    });

    const all = await Promise.all(timeframePromises);
    const output = { username, results: {} };

    for (const bucket of all) {
      const entries = bucket.entries || [];
      const you = entries.find((e) => e.username && e.username.toLowerCase() === username);

      let rank100 = entries.find((e) => Number(e.rank) === 100);
      if (!rank100) {
        const withMs = entries.filter((e) => Number.isFinite(e.mindshare));
        if (withMs.length >= 100) {
          withMs.sort((a, b) => b.mindshare - a.mindshare);
          rank100 = withMs[99];
        } else {
          const sortedByRank = entries.slice().sort((a, b) => a.rank - b.rank);
          if (sortedByRank.length >= 100) rank100 = sortedByRank[99];
        }
      }

      const obj = {
        totalFetched: entries.length,
        rank100_mindshare: rank100 ? rank100.mindshare : null,
      };

      if (!you) {
        obj.found = false;
      } else {
        obj.found = true;
        obj.rank = you.rank;
        obj.mindshare = you.mindshare;
        obj.mindshareDelta = you.mindshareDelta ?? null;
        obj.needed_mindshare =
          rank100 &&
          Number.isFinite(rank100.mindshare) &&
          Number.isFinite(you.mindshare)
            ? Math.max(0, rank100.mindshare - you.mindshare)
            : null;
      }

      output.results[bucket.key] = obj;
    }

    return res.json(output);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// Top leaderboard (default 30d/month) for UI table
app.get('/api/top', async (req, res) => {
  try {
    const timeframeKey = (req.query?.timeframe || 'month').toString();
    const entries = await fetchAllPagesForTimeframe(timeframeKey, 20, 100);
    const list = entries.slice(0, 100).map((e) => ({
      username: e.username,
      rank: e.rank,
      mindshare: e.mindshare,
      mindshareDelta: e.mindshareDelta ?? null,
    }));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ timeframe: timeframeKey, list });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for root requests
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Local server running at http://localhost:${PORT}`);
});

