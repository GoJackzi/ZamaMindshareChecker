// api/top.js
const BASE = "https://leaderboard-bice-mu.vercel.app/api/zama";
const CACHE_TTL_SECONDS = 300;
const cache = new Map();

function cacheSet(k, v, ttl = CACHE_TTL_SECONDS) {
  cache.set(k, { v, exp: Date.now() + ttl * 1000 });
}

function cacheGet(k) {
  const it = cache.get(k);
  if (!it) return null;
  if (Date.now() > it.exp) {
    cache.delete(k);
    return null;
  }
  return it.v;
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
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
  
  if (typeof username === 'string') {
    username = username.trim().replace(/^@/, '');
  } else {
    for (const v of Object.values(entry)) {
      if (typeof v === 'string' && v.startsWith('@')) {
        username = v.replace(/^@/, '');
        break;
      }
    }
  }
  
  let mindshare = null;
  if (entry.mindshare != null) mindshare = Number(entry.mindshare);
  
  let mindshareDelta = null;
  if (entry.mindshareDelta != null) mindshareDelta = Number(entry.mindshareDelta);
  if (entry.mindshare_delta != null) mindshareDelta = Number(entry.mindshare_delta);
  
  let rank = Number(entry.rank);
  if (!Number.isFinite(rank)) {
    rank = (pageIdx - 1) * fallbackPageSize + (idxInPage + 1);
  }
  
  return {
    username,
    rank,
    mindshare: Number.isFinite(mindshare) ? mindshare : null,
    mindshareDelta: Number.isFinite(mindshareDelta) ? mindshareDelta : null
  };
}

async function fetchAllPagesForTimeframe(tf, maxPages = 20, pageSizeHint = 100) {
  const ck = `tf:${tf}`;
  const c = cacheGet(ck);
  if (c) return c;
  
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${BASE}?timeframe=${encodeURIComponent(tf)}&sortBy=mindshare&page=${page}`;
      const json = await fetchJson(url);
      const arr = getArrayFromResponse(json);
      if (!arr || !arr.length) break;
      
      for (let i = 0; i < arr.length; i++) {
        const n = normalize(arr[i], page, i, pageSizeHint);
        if (n && n.username) out.push(n);
      }
    } catch (err) {
      console.warn('fetch page error', err.message);
      break;
    }
  }
  
  cacheSet(ck, out);
  return out;
}

export default async function handler(req, res) {
  try {
    const timeframeKey = String(req.query?.timeframe || 'month');
    const entries = await fetchAllPagesForTimeframe(timeframeKey, 20, 100);
    const list = entries.slice(0, 100).map(e => ({
      username: e.username,
      rank: e.rank,
      mindshare: e.mindshare,
      mindshareDelta: e.mindshareDelta ?? null,
    }));
    
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ timeframe: timeframeKey, list });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

