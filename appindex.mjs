// Steam 应用名称索引
//
// 商店的搜索接口（storesearch / search/suggest）只收录仍在售的游戏，
// 一旦游戏下架就再也搜不到；Web API 的应用列表（GetAppList）同样不含下架条目。
// 但 Steam 的 appinfo（PICS）协议里依然保留着这些游戏的资料——只要知道 App ID。
//
// 所以本站自己扫一遍 App ID 空间，把「App ID → 名称 / 类型 / 发售日期」存成索引，
// 搜索框就能同时搜到在售与已下架的游戏。纯 Node 实现，复用 appinfo.mjs 的 PICS 客户端。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAppInfoKvBatch, fetchAppInfoKvBatches, picsScan } from './appinfo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'app-index.json');
const LOCK_FILE = path.join(DATA_DIR, 'app-index.lock');

export const INDEX_FORMAT = 1;

// App ID 空间上限。Steam 目前的新 App ID 落在 3xx 万 ~ 4xx 万之间，
// 留出余量扫描到 4,000,000，尾部连续空段会自动停止。
const DEFAULT_MAX_APPID = 4_000_000;
// 一次请求问多少个 App ID。
// 实测：批次越大，服务端的回应缓冲区越容易装不下，被静默丢掉后面的 App ID
// （span=800 会漏 600 多个，span=200 漏 37 个，span=100 一个不漏）。
// 所以这里用小批次，吞吐靠「多条连接并行」来补。
const DEFAULT_CHUNK = 100;
// 并行扫描的连接数。每条连接有服务端自己的游标，互不干扰。
const DEFAULT_WORKERS = 4;
// 一条连接上连发多少个请求。太多会让 CM 服务器开始丢回应。
const REQUESTS_PER_SESSION = 60;
// 一条连接上连续发多少个请求（复用握手）。
const BATCHES_PER_SESSION = 60;
// 连续多少个区块都没扫到东西就认为到底了
const EMPTY_TAIL_CHUNKS = 60;

const TYPE_CODES = {
  game: 'g',
  dlc: 'd',
  demo: 'm',
  tool: 't',
  soundtrack: 'o',
  app: 'a',
  series: 's',
  mod: 'x',
};

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
}

/* --------------------------- 读写索引文件 --------------------------- */

export function loadAppIndex() {
  try {
    const raw = fs.readFileSync(INDEX_FILE, 'utf8');
    const json = JSON.parse(raw);
    if (!json || json.format !== INDEX_FORMAT || !json.entries) return { next: 1, entries: {} };
    return { next: Number(json.next) || 1, entries: json.entries || {} };
  } catch {
    return { next: 1, entries: {} };
  }
}

export function saveAppIndex(state) {
  ensureDataDir();
  const payload = {
    format: INDEX_FORMAT,
    updatedAt: new Date().toISOString(),
    next: state.next,
    count: Object.keys(state.entries).length,
    entries: state.entries,
  };
  const temp = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload));
  fs.renameSync(temp, INDEX_FILE);
  return payload.count;
}

/* --------------------------- 内存检索结构 --------------------------- */

export class AppIndex {
  constructor() {
    this.entries = new Map();   // appid -> { n, t, d }
    this.names = [];            // [小写名称, appid]，检索时免去重复小写化
    this.next = 1;
    this.loaded = false;
  }

  load() {
    const state = loadAppIndex();
    this.next = state.next;
    this.entries.clear();
    this.names.length = 0;
    for (const [appid, value] of Object.entries(state.entries)) {
      this.set(Number(appid), value);
    }
    this.loaded = true;
    return this.entries.size;
  }

  set(appid, value) {
    const id = Number(appid);
    if (!Number.isInteger(id) || id <= 0 || !value?.n) return;
    this.entries.set(id, value);
    this.names.push([value.n.toLowerCase(), id]);
  }

  get size() {
    return this.entries.size;
  }

  /**
   * 按名称检索：完全匹配优先，其次前缀匹配，最后包含匹配；
   * 同一档里游戏排在原声带 / DLC 前面。
   */
  search(query, limit = 12) {
    const term = String(query || '').trim().toLowerCase();
    if (!term) return [];
    const exact = [];
    const prefix = [];
    const contains = [];
    for (const [name, id] of this.names) {
      if (name === term) exact.push(id);
      else if (name.startsWith(term)) prefix.push(id);
      else if (name.includes(term)) contains.push(id);
    }
    const byKind = (a, b) => {
      const ta = this.entries.get(a)?.t;
      const tb = this.entries.get(b)?.t;
      if (ta === tb) return a - b;
      return ta === 'g' ? -1 : tb === 'g' ? 1 : a - b;
    };
    exact.sort(byKind);
    prefix.sort(byKind);
    contains.sort(byKind);
    const order = [...exact, ...prefix, ...contains].slice(0, limit);
    return order.map((id) => ({ appid: id, ...this.entries.get(id) }));
  }
}

/* --------------------------- 扫描锁 --------------------------- */

// 同一时间只允许一个扫描进程写索引，避免服务端与命令行互相覆盖进度。
export function acquireScanLock(maxAgeMs = 10 * 60 * 1000) {
  ensureDataDir();
  try {
    const stat = fs.statSync(LOCK_FILE);
    if (Date.now() - stat.mtimeMs < maxAgeMs) return false;
  } catch { /* 没有锁文件 */ }
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch {
    return false;
  }
  return true;
}

// 扫描可能跑很久，定期刷新锁的时间戳，避免锁被当成失效的旧锁。
export function refreshScanLock() {
  try {
    const now = new Date();
    fs.utimesSync(LOCK_FILE, now, now);
  } catch { /* ignore */ }
}

export function releaseScanLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

/* --------------------------- 后台扫描 --------------------------- */

function summarize(kv) {
  const root = kv?.value?.appinfo || kv?.value || {};
  const common = root.common || {};
  const section = root.extended?.section || {};
  const name = section.name || common.name || '';
  if (!name) return null;
  const rawType = section.type || common.type || 'Game';
  const code = TYPE_CODES[String(rawType).toLowerCase()] || 'g';
  let date = null;
  const stamp = Number(common.steam_release_date);
  if (Number.isFinite(stamp) && stamp > 0) date = new Date(stamp * 1000).toISOString().slice(0, 10);
  return { n: String(name), t: code, d: date };
}

/**
 * 扫描 App ID 空间，建立名称索引。可重复调用，会从上次的进度继续。
 */
export async function scanAppIndex({
  from = null,
  to = DEFAULT_MAX_APPID,
  chunk = DEFAULT_CHUNK,
  workers = DEFAULT_WORKERS,
  signal = null,
  onProgress = null,
} = {}) {
  const locked = acquireScanLock();
  if (!locked) {
    const state = loadAppIndex();
    console.log('[index] 已有其它进程在扫描，跳过');
    return { scanned: 0, added: 0, next: state.next, count: Object.keys(state.entries).length, done: false, skipped: true };
  }
  try {
    const heartbeat = setInterval(refreshScanLock, 60 * 1000);
    heartbeat.unref?.();
    return await runScan({ from, to, chunk, workers, signal, onProgress });
  } finally {
    releaseScanLock();
  }
}

async function runScan({ from, to, chunk, workers, signal, onProgress }) {
  const state = loadAppIndex();
  let added = 0;
  let scanned = 0;
  let emptyTail = 0;
  let done = false;

  const record = (result) => {
    let found = 0;
    for (const [appid, kv] of result.apps) {
      const summary = summarize(kv);
      if (!summary) continue;
      found += 1;
      if (!state.entries[appid]) added += 1;
      state.entries[appid] = summary;
    }
    emptyTail = found ? 0 : emptyTail + 1;
    return found;
  };

  const start = from ?? Math.max(1, state.next || 1);
  const span = Math.max(1, Math.ceil((to - start) / workers));
  let maxCursor = start;

  // 每条连接负责一段互不重叠的区间：服务端游标是按连接算的，
  // 所以各扫各的区间正好把整个 App ID 空间覆盖掉。
  const tasks = [];
  for (let w = 0; w < workers; w += 1) {
    const workerFrom = start + w * span;
    const workerTo = Math.min(to, workerFrom + span);
    if (workerFrom >= workerTo) continue;
    tasks.push((async () => {
      let cursor = workerFrom;
      let lastSave = cursor;
      while (cursor < workerTo) {
        if (signal?.aborted) break;
        if (emptyTail >= EMPTY_TAIL_CHUNKS) break;

        const outcome = await picsScan({
          from: cursor,
          span: chunk,
          maxRequests: REQUESTS_PER_SESSION,
          signal,
          onResult: (result) => {
            record(result);
            scanned += result.apps.size + result.unknown.length;
          },
        });
        if (!outcome || outcome.cursor <= cursor) break;
        cursor = outcome.cursor;
        if (cursor > maxCursor) maxCursor = cursor;

        // 补取缺口：偶发丢包会让服务端跳过一段 App ID，这里重新问一遍。
        // 新连接的服务端游标从头开始，所以重问指定区间是有效的。
        const gaps = (outcome.gaps || []).filter(([gFrom, gTo]) => gTo >= gFrom);
        if (gaps.length) {
          const refill = [];
          for (const [gapFrom, gapTo] of gaps) {
            for (let id = gapFrom; id <= gapTo; id += 100) refill.push([id, Math.min(id + 99, gapTo)]);
          }
          const refillResults = await fetchAppInfoKvBatches(refill.map(([a, b]) => {
            const ids = [];
            for (let id = a; id <= b; id += 1) ids.push(id);
            return ids;
          }), { signal });
          for (const result of refillResults) {
            record(result);
            scanned += result.apps.size + result.unknown.length;
          }
        }

        if (cursor - lastSave >= 20000) {
          state.next = Math.max(state.next, cursor + 1);
          saveAppIndex(state);
          lastSave = cursor;
          if (onProgress) onProgress({ cursor: maxCursor, scanned, added, size: Object.keys(state.entries).length });
        }
      }
      return cursor;
    })());
  }

  await Promise.all(tasks);

  state.next = Math.max(state.next, maxCursor + 1);
  const count = saveAppIndex(state);
  return { scanned, added, next: state.next, count, done: done || maxCursor >= to };
}

export const APP_INDEX_PATHS = { INDEX_FILE, DATA_DIR };
