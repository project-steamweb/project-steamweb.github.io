import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, watch as fsWatch, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAppInfo } from './appinfo.mjs';
import { AppIndex, scanAppIndex } from './appindex.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Optional .env support so `node server.mjs` is enough.
const envFile = path.join(__dirname, '.env');
function loadEnvFile({ override = false } = {}) {
  if (!existsSync(envFile)) return {};
  const loaded = {};
  for (const rawLine of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    loaded[key] = value;
    if (override || !(key in process.env)) process.env[key] = value;
  }
  return loaded;
}
loadEnvFile();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

// The Steam Web API key is stored encrypted (AES-256-GCM) so it never appears
// in the source tree. Set STEAM_API_KEY only to override the encrypted store.
const KEY_FILE = path.join(__dirname, '.steam-key.enc');
const SECRET_FILE = path.join(__dirname, '.steam-key.secret');
const SECRET_CONTEXT = 'steam-atlas:web-api-key:v1';

function decryptStoredKey() {
  try {
    if (!existsSync(KEY_FILE) || !existsSync(SECRET_FILE)) return '';
    const secret = Buffer.from(readFileSync(SECRET_FILE, 'utf8').trim(), 'base64');
    if (secret.length !== 32) return '';
    const payload = Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
    if (payload.length < 28) return '';
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const key = crypto.createHash('sha256').update(secret).update(SECRET_CONTEXT).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8').trim();
  } catch {
    return '';
  }
}

// The Steam Web API key. It normally lives encrypted in .steam-key.enc and can be
// replaced at runtime with `node set-key.mjs <key>`; the watcher below picks the
// new key up without a restart, so a key rotation never needs a downtime window.
let SERVER_KEY = (process.env.STEAM_API_KEY || decryptStoredKey() || '').trim();
const APP_VERSION = '1.5.0';

function watchStoredKey() {
  const keyFile = path.join(__dirname, '.steam-key.enc');
  if (!existsSync(keyFile)) return;
  let timer = null;
  try {
    fsWatch(keyFile, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const next = decryptStoredKey();
        if (!next || next === SERVER_KEY) return;
        SERVER_KEY = next;
        console.log(`[key] 已热更新 Steam API Key（结尾 ${next.slice(-6).toUpperCase()}）`);
      }, 400);
    });
  } catch (error) {
    console.warn('[key] 无法监听密钥文件变化:', error?.message || error);
  }
}

// Site titles shown after the Steam persona name. Keys are SteamID64 strings.
// The admin panel can edit these at runtime; the list is persisted in
// data/titles.json and falls back to the defaults below.
const DEFAULT_PLAYER_TITLES = [
  { id: 'owner', steamId: '76561199473775554', label: 'Owner', color: 'crimson', priority: 100 },
];
// The account the OpenID handshake claims by default (the site owner).
const DEFAULT_OWNER_STEAM_ID = '76561199473775554';

let playerTitles = new Map(DEFAULT_PLAYER_TITLES.map((item) => [item.steamId, item]));

function titleFor(steamId) {
  const title = playerTitles.get(String(steamId || ''));
  return title ? { ...title } : null;
}

const STORE_ORIGIN = 'https://store.steampowered.com';
const COMMUNITY_ORIGIN = 'https://steamcommunity.com';
const WEB_API_ORIGIN = process.env.WEB_API_ORIGIN || 'https://api.steampowered.com';

const REGIONS = [
  { cc: 'cn', code: 'CN', name: '中国', currency: 'CNY', currencyName: '人民币' },
  { cc: 'hk', code: 'HK', name: '中国香港', currency: 'HKD', currencyName: '港币' },
  { cc: 'tw', code: 'TW', name: '中国台湾', currency: 'TWD', currencyName: '新台币' },
  { cc: 'us', code: 'US', name: '美国', currency: 'USD', currencyName: '美元' },
  { cc: 'jp', code: 'JP', name: '日本', currency: 'JPY', currencyName: '日元' },
  { cc: 'kr', code: 'KR', name: '韩国', currency: 'KRW', currencyName: '韩元' },
  { cc: 'sg', code: 'SG', name: '新加坡', currency: 'SGD', currencyName: '新加坡元' },
  { cc: 'gb', code: 'GB', name: '英国', currency: 'GBP', currencyName: '英镑' },
  { cc: 'de', code: 'EU', name: '欧元区', currency: 'EUR', currencyName: '欧元' },
  { cc: 'ca', code: 'CA', name: '加拿大', currency: 'CAD', currencyName: '加元' },
  { cc: 'au', code: 'AU', name: '澳大利亚', currency: 'AUD', currencyName: '澳元' },
  { cc: 'br', code: 'BR', name: '巴西', currency: 'BRL', currencyName: '巴西雷亚尔' },
  { cc: 'mx', code: 'MX', name: '墨西哥', currency: 'MXN', currencyName: '墨西哥比索' },
  { cc: 'tr', code: 'TR', name: '土耳其', currency: 'TRY', currencyName: '土耳其里拉' },
  { cc: 'ar', code: 'AR', name: '阿根廷', currency: 'ARS', currencyName: '阿根廷比索' },
  { cc: 'ru', code: 'RU', name: '俄罗斯', currency: 'RUB', currencyName: '俄罗斯卢布' },
];

const REGION_BY_CC = new Map(REGIONS.map((region) => [region.cc, region]));
const REGION_BY_CODE = new Map(REGIONS.map((region) => [region.code, region]));
const STORE_LANGUAGE = 'schinese';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const STORE_HEADERS = {
  // 用常规浏览器 UA：Steam 对明显的脚本 UA 更容易直接返回 403。
  'User-Agent': BROWSER_UA,
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Cookie: 'birthtime=628473600; lastagecheckage=1-January-1990; wants_mature_content=1; mature_content=1',
};
const TEXT_HEADERS = {
  'User-Agent': BROWSER_UA,
  Accept: 'text/xml,application/xml,text/html;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Cookie: 'birthtime=628473600; lastagecheckage=1-January-1990; wants_mature_content=1',
};

class HttpError extends Error {
  constructor(status, message, code = 'HTTP_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const cache = new Map();
const pendingFetches = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  if (cache.size > 400) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

async function cached(key, ttlMs, loader) {
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const inFlight = pendingFetches.get(key);
  if (inFlight) return inFlight;
  const promise = (async () => {
    try {
      const value = await loader();
      cacheSet(key, value, ttlMs);
      return value;
    } finally {
      pendingFetches.delete(key);
    }
  })();
  pendingFetches.set(key, promise);
  return promise;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Steam 对突发请求很敏感：短时间内大量请求会直接返回 403（整个 IP 被临时限制）。
// 这里做两件事：给商店接口加最小间隔，并在收到 403 后进入冷却。
// 冷却按域名分别计算：Web API 的 Key 出问题不应该连带影响商店接口。
const STEAM_REQUEST_INTERVAL_MS = 220;
const STEAM_COOLDOWN_MS = 90 * 1000;
const steamCooldowns = new Map();   // host -> 冷却截止时间
let lastSteamRequestAt = 0;

function steamCoolingDown(host) {
  return Date.now() < (steamCooldowns.get(host) || 0);
}

function enterSteamCooldown(host) {
  steamCooldowns.set(host, Date.now() + STEAM_COOLDOWN_MS);
  console.warn(`[steam] ${host} 返回 403，暂停该接口 ${STEAM_COOLDOWN_MS / 1000} 秒以免被进一步限制`);
}

async function throttleSteamRequest() {
  const wait = lastSteamRequestAt + STEAM_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastSteamRequestAt = Date.now();
}

async function fetchJson(url, { timeout = 12000, retries = 1, headers = STORE_HEADERS } = {}) {
  let lastError;
  let host = '';
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (steamCoolingDown(host)) {
        throw new HttpError(503, 'Steam 暂时限制了请求频率，请稍后再试', 'STEAM_COOLDOWN');
      }
      await throttleSteamRequest();
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
      if (!response.ok) {
        if (response.status === 403) enterSteamCooldown(host);
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          await sleep(450 * (attempt + 1));
          continue;
        }
        throw new HttpError(
          502,
          `Steam 上游返回了 ${response.status}`,
          response.status === 401 || response.status === 403 ? 'STEAM_API_FORBIDDEN' : 'UPSTREAM_ERROR',
        );
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError) throw error;
      if (attempt < retries) {
        await sleep(450 * (attempt + 1));
        continue;
      }
    }
  }
  if (lastError?.name === 'TimeoutError') {
    throw new HttpError(504, 'Steam 响应超时，请稍后重试', 'UPSTREAM_TIMEOUT');
  }
  throw new HttpError(502, '无法连接 Steam 服务，请检查网络后重试', 'UPSTREAM_UNREACHABLE');
}

async function fetchText(url, { timeout = 10000, headers = TEXT_HEADERS } = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
    const text = await response.text();
    if (!response.ok && response.status !== 404) {
      throw new HttpError(502, `Steam 社区返回了 ${response.status}`, 'UPSTREAM_ERROR');
    }
    return { status: response.status, text };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === 'TimeoutError') {
      throw new HttpError(504, 'Steam 社区响应超时，请稍后重试', 'UPSTREAM_TIMEOUT');
    }
    throw new HttpError(502, '无法连接 Steam 社区，请检查网络后重试', 'UPSTREAM_UNREACHABLE');
  }
}

function formatMoney(currency, amount) {
  if (!Number.isFinite(amount)) return '—';
  try {
    const maximumFractionDigits = ['JPY', 'KRW', 'CLP', 'VND'].includes(currency) ? 0 : 2;
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function normalizePrice(priceOverview, fallbackCurrency) {
  if (!priceOverview) return null;
  const currency = priceOverview.currency || fallbackCurrency || 'USD';
  const final = Number(priceOverview.final) / 100;
  const initial = Number(priceOverview.initial) / 100;
  return {
    currency,
    final: Number.isFinite(final) ? final : 0,
    initial: Number.isFinite(initial) ? initial : final,
    discountPercent: Number(priceOverview.discount_percent) || 0,
    finalFormatted: formatMoney(currency, final),
    initialFormatted: formatMoney(currency, initial),
  };
}

function decodeEntities(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(Number(dec)); } catch { return ''; }
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function stripHtml(value) {
  if (!value) return '';
  const withBreaks = String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withBreaks)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(value, length = 1600) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length).trim()}…` : text;
}

function cleanRequirement(html) {
  if (!html) return null;
  const text = stripHtml(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(li|ul|p)>/gi, '\n'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  return text ? truncate(text, 900) : null;
}

function contentDescriptorLabel(id) {
  return ({
    1: '部分裸露内容',
    2: '频繁暴力或血腥',
    3: '成人内容',
    4: '频繁裸露或性内容',
    5: '赌博内容',
  })[Number(id)] || null;
}

function normalizeApp(appid, data, region) {
  const priceOverview = normalizePrice(data.price_overview, region.currency);
  const packages = (data.package_groups?.[0]?.subs || [])
    .map((sub) => ({
      id: sub.packageid,
      text: stripHtml(sub.option_text || ''),
      amount: typeof sub.price_in_cents_with_discount === 'number' ? sub.price_in_cents_with_discount / 100 : null,
      discountPercent: Number(sub.percent_savings) || 0,
    }))
    .filter((sub) => sub.text)
    .slice(0, 6);
  const platformRequirements = {
    windows: cleanRequirement(data.pc_requirements?.minimum),
    mac: cleanRequirement(data.mac_requirements?.minimum),
    linux: cleanRequirement(data.linux_requirements?.minimum),
  };
  const platformRequirementsRecommended = {
    windows: cleanRequirement(data.pc_requirements?.recommended),
    mac: cleanRequirement(data.mac_requirements?.recommended),
    linux: cleanRequirement(data.linux_requirements?.recommended),
  };
  const ratings = Object.entries(data.ratings || {}).map(([board, value]) => ({
    board: String(board).toUpperCase(),
    rating: String(value?.rating || '').toUpperCase(),
    requiredAge: Number(value?.required_age) || null,
    descriptors: String(value?.descriptors || '').split(/[\r\n]+/).map((item) => item.trim()).filter(Boolean),
  })).filter((rating) => rating.rating || rating.requiredAge);
  const contentNotes = data.content_descriptors?.notes
    ? stripHtml(String(data.content_descriptors.notes))
    : '';

  return {
    appid: Number(appid),
    name: data.name || `App ${appid}`,
    type: data.type || 'game',
    isFree: Boolean(data.is_free),
    shortDescription: data.short_description || '',
    about: truncate(stripHtml(data.about_the_game || data.detailed_description || data.short_description), 6000),
    headerImage: data.header_image || data.capsule_imagev5 || '',
    capsuleImage: data.capsule_imagev5 || data.capsule_image || data.header_image || '',
    backgroundImage: data.background_raw || data.background || data.header_image || '',
    screenshots: (data.screenshots || []).slice(0, 8).map((shot) => ({
      thumbnail: shot.path_thumbnail || shot.path_full,
      full: shot.path_full || shot.path_thumbnail,
    })).filter((shot) => shot.thumbnail && shot.full),
    movies: (data.movies || []).slice(0, 4).map((movie) => ({
      id: movie.id,
      name: movie.name || '宣传片',
      thumbnail: movie.thumbnail || '',
      highlight: Boolean(movie.highlight),
      stream: movie.hls_h264 || movie.dash_h264 || '',
      url: `${STORE_ORIGIN}/app/${appid}/?snr=1_5_9__400`,
    })).filter((movie) => movie.thumbnail),
    genres: (data.genres || []).map((genre) => genre.description).filter(Boolean),
    categories: (data.categories || []).map((category) => category.description).filter(Boolean),
    developers: data.developers || [],
    publishers: data.publishers || [],
    releaseDate: data.release_date?.date || '',
    comingSoon: Boolean(data.release_date?.coming_soon),
    platforms: {
      windows: Boolean(data.platforms?.windows),
      mac: Boolean(data.platforms?.mac),
      linux: Boolean(data.platforms?.linux),
    },
    metacritic: data.metacritic ? { score: data.metacritic.score, url: data.metacritic.url || '' } : null,
    recommendations: data.recommendations?.total || 0,
    website: data.website || '',
    supportUrl: data.support_info?.url || '',
    supportEmail: data.support_info?.email || '',
    requiredAge: Number(data.required_age) || 0,
    controllerSupport: data.controller_support || '',
    languages: truncate(stripHtml(data.supported_languages), 600),
    languageList: stripHtml(data.supported_languages)
      .split(/[,，]/)
      .map((name) => name.replace(/\*/g, '').trim())
      .filter(Boolean)
      .slice(0, 40),
    achievements: data.achievements?.total ? {
      total: Number(data.achievements.total),
      highlighted: (data.achievements.highlighted || []).slice(0, 6).map((item) => ({
        name: item.localized_name || item.name || '',
        description: stripHtml(item.description || '') || null,
        icon: item.path || (item.icon ? `https://shared.akamai.steamstatic.com/community_assets/images/apps/${appid}/${item.icon}` : ''),
        hidden: Boolean(item.hidden),
      })),
    } : null,
    dlc: (data.dlc || []).slice(0, 40).map((id) => ({ appid: Number(id) })),
    // For DLC / soundtracks Steam exposes the owning base game.
    fullgame: data.fullgame?.appid
      ? { appid: Number(data.fullgame.appid), name: String(data.fullgame.name || '') }
      : null,
    packages,
    ratings,
    contentDescriptors: (data.content_descriptors?.ids || []).map(contentDescriptorLabel).filter(Boolean),
    contentNotes,
    platformRequirements,
    platformRequirementsRecommended,
    legalNotice: data.legal_notice ? truncate(stripHtml(data.legal_notice), 400) : '',
    price: priceOverview,
    free: Boolean(data.is_free),
    storeUrl: `${STORE_ORIGIN}/app/${appid}`,
    region: { cc: region.cc, code: region.code, name: region.name, currency: region.currency },
  };
}

async function getDlcList(appid, cc, language = STORE_LANGUAGE) {
  const cacheKey = `dlc:${appid}:${cc}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const region = REGION_BY_CC.get(cc) || REGION_BY_CC.get('cn');
  const parent = await getAppData(appid, region.cc, language);
  const ids = (parent.dlc || []).map((item) => item.appid).filter(Boolean);

  if (!ids.length) {
    const empty = { appid, cc: region.cc, currency: region.currency, total: 0, items: [] };
    cacheSet(cacheKey, empty, 10 * 60 * 1000);
    return empty;
  }

  const items = await mapLimit(ids, 5, async (dlcAppid) => {
    try {
      const url = new URL(`${STORE_ORIGIN}/api/appdetails`);
      url.searchParams.set('appids', String(dlcAppid));
      url.searchParams.set('cc', region.cc);
      url.searchParams.set('l', language);
      const json = await fetchJson(url.toString(), { timeout: 10000, retries: 0, headers: STORE_HEADERS });
      const entry = json?.[String(dlcAppid)];
      if (!entry || entry.success !== true || !entry.data) return null;
      const data = entry.data;
      const price = normalizePrice(data.price_overview, region.currency);
      return {
        appid: Number(dlcAppid),
        name: data.name || `DLC ${dlcAppid}`,
        type: data.type || 'dlc',
        header: data.header_image || '',
        releaseDate: data.release_date?.date || null,
        free: Boolean(data.is_free),
        price,
        storeUrl: `${STORE_ORIGIN}/app/${dlcAppid}`,
      };
    } catch {
      return null;
    }
  });

  const result = {
    appid,
    cc: region.cc,
    currency: region.currency,
    total: ids.length,
    items: items.filter(Boolean),
  };
  cacheSet(cacheKey, result, 10 * 60 * 1000);
  return result;
}

// 游戏在商店接口失败时的兜底顺序：
// 1) 换一个区服再试（很多游戏只在个别区服上架或被单独下架）；
// 2) Steam appinfo 协议（能拿到商店没有公开的游戏资料）；
// 3) Steam Web API 的应用列表（至少还能给出名称）。
const FALLBACK_REGIONS_TIER1 = ['us', 'jp', 'de', 'tw', 'hk'];
const FALLBACK_REGIONS_TIER2 = ['sg', 'kr', 'br', 'ru', 'fr'];
const FALLBACK_CONCURRENCY = 3;
const APP_FAILURE_TTL_MS = 30 * 60 * 1000;

// Steam Web API 的应用列表：按 appid 升序返回，可以从一个「窗口」里直接定位
// 目标应用，一次请求即可（列表本身不含已彻底下架的游戏）。
async function lookupAppInStoreList(appid) {
  if (!SERVER_KEY) return null;
  const cacheKey = `applist:${appid}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  try {
    const from = Math.max(0, appid - 20000);
    const url = new URL(`${WEB_API_ORIGIN}/IStoreService/GetAppList/v1/`);
    url.searchParams.set('key', SERVER_KEY);
    url.searchParams.set('include_games', 'true');
    url.searchParams.set('include_dlc', 'true');
    url.searchParams.set('include_software', 'true');
    url.searchParams.set('last_appid', String(from));
    url.searchParams.set('max_results', '40000');
    const json = await fetchJson(url.toString(), { timeout: 15000, retries: 0, headers: { Accept: 'application/json' } });
    const apps = json?.response?.apps || [];
    const hit = apps.find((item) => item.appid === appid) || null;
    cacheSet(cacheKey, hit, 60 * 60 * 1000);
    return hit;
  } catch {
    return null;
  }
}

// 兜底返回的资料字段较少，结构与商店接口保持一致，页面可以照常渲染。
function sparseApp(appid, { name, type = 'game', price = null, releaseDate = null, developer = null, publisher = null, description = '', header = '', availability = 'webapi', source = 'webapi', note = '' }) {
  return {
    appid,
    name: name || `App ${appid}`,
    type,
    typeLabel: 'Game',
    shortDescription: description,
    description: description,
    about: description,
    headerImage: header || '',
    backgroundImage: '',
    screenshots: [],
    movies: [],
    developers: developer ? [developer] : [],
    publishers: publisher ? [publisher] : [],
    genres: [],
    categories: [],
    platforms: { windows: false, mac: false, linux: false },
    controllerSupport: null,
    releaseDate,
    comingSoon: false,
    recommendations: null,
    metacritic: null,
    achievements: null,
    dlc: [],
    packages: [],
    ratings: [],
    contentDescriptors: [],
    contentNotes: null,
    languageList: [],
    platformRequirements: {},
    platformRequirementsRecommended: {},
    legalNotice: '',
    supportInfo: null,
    website: null,
    supportUrl: null,
    supportEmail: null,
    price,
    free: Boolean(price && Number(price.final) === 0),
    isFree: Boolean(price && Number(price.final) === 0),
    storeUrl: `${STORE_ORIGIN}/app/${appid}`,
    region: { cc: REGION_BY_CC.get('cn')?.cc || 'cn', code: 'CN', name: '中国', currency: 'CNY' },
    fullgame: null,
    availability,
    source,
    note,
  };
}

// 商店接口拿不到时的统一入口。
async function resolveAppInfo(appid, cc) {
  // 整个解析过程都会打 Steam 接口，结果缓存 10 分钟，避免重复查询反复消耗额度。
  const key = `resolve:${appid}:${cc}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const result = await resolveAppInfoUncached(appid, cc);
  cacheSet(key, result, 10 * 60 * 1000);
  return result;
}

async function resolveAppInfoUncached(appid, cc) {
  const region = REGION_BY_CC.get(cc) || REGION_BY_CC.get('cn');
  const failureKey = `appfail:${appid}:${region.cc}`;

  // 之前已经确认查不到的游戏，短期内不再重复扫描各区服，避免给 Steam 添麻烦。
  const previousFailure = cacheGet(failureKey);
  if (previousFailure) {
    throw new HttpError(previousFailure.status || 404, previousFailure.message || '没有找到这款游戏，或该地区暂不提供', previousFailure.code || 'APP_NOT_FOUND');
  }

  try {
    const app = await getAppData(appid, region.cc, STORE_LANGUAGE);
    return { ...app, availability: 'store', source: 'store', note: '' };
  } catch (primaryError) {
    const notAvailable = primaryError?.code === 'APP_NOT_FOUND';
    const upstreamBlocked = primaryError?.code === 'STEAM_API_FORBIDDEN' || primaryError?.code === 'STEAM_COOLDOWN';

    if (upstreamBlocked) {
      // Steam 暂时拒绝了请求（多半是请求过于频繁），此时再扫描各区服只会加重限制。
      console.warn(`[app] ${appid} 上游暂时受限（${primaryError.code}），跳过区服回退`);
      throw primaryError;
    }

    if (notAvailable) {
      // 第一轮：常见的几个区服，先把「区服限制」的情况用完整商店数据解决。
      const firstHit = await scanOtherRegions(appid, region.cc, FALLBACK_REGIONS_TIER1);
      if (firstHit) return firstHit;

      // 第二轮准备：Steam Web API 的应用列表（判断游戏是否还在商店里，
      // 走的是另一个主机，额度宽松）与 Steam appinfo 协议（完全不占商店额度）并行。
      const [listed, appInfo] = await Promise.all([
        lookupAppInStoreList(appid),
        cached(`appinfo:${appid}`, 60 * 60 * 1000, () => fetchAppInfo(appid)),
      ]);

      // 还在商店列表里 → 说明只是某些区服不可用，值得再扫一轮拿带价格的完整数据。
      if (listed?.name) {
        const secondHit = await scanOtherRegions(appid, region.cc, FALLBACK_REGIONS_TIER2);
        if (secondHit) return secondHit;
      }

      // Steam appinfo 协议：商店完全查不到的游戏靠它补上。
      if (appInfo?.name) {
        console.log(`[app] ${appid} 通过 appinfo 取得资料：${appInfo.name}`);
        const sparse = sparseApp(appid, {
          name: appInfo.localizedName || appInfo.name,
          type: appInfo.type,
          description: appInfo.description,
          developer: appInfo.developer,
          publisher: appInfo.publisher,
          releaseDate: appInfo.releaseDate,
          header: appInfo.header,
          price: appInfo.price ? normalizePrice(appInfo.price, 'USD') : null,
          availability: 'appinfo',
          source: 'appinfo',
          note: '该游戏未在商店公开（可能已下架或未公开），以下资料来自 Steam appinfo 协议。',
        });
        sparse.links = buildAppLinks(appid, sparse, await fetchStoreSocialLinks(appid));
        return sparse;
      }

      // Steam Web API 应用列表：至少还能给出名称。
      if (listed?.name) {
        const sparse = sparseApp(appid, {
          name: listed.name,
          availability: 'webapi',
          source: 'webapi',
          note: '该游戏未在商店公开，Steam Web API 仅能提供名称与上架信息。',
        });
        sparse.links = buildAppLinks(appid, sparse, []);
        return sparse;
      }

      cacheSet(failureKey, { status: primaryError?.status || 404, message: primaryError?.message, code: primaryError?.code }, APP_FAILURE_TTL_MS);
      throw primaryError;
    }

    // 上游暂时不可用（非「查不到」）时不做兜底，直接把错误抛给调用方。
    cacheSet(failureKey, { status: primaryError?.status || 404, message: primaryError?.message, code: primaryError?.code }, APP_FAILURE_TTL_MS);
    throw primaryError;
  }
}

// 依次尝试其它区服，找到第一个能返回完整商店数据的。
async function scanOtherRegions(appid, currentCc, regions) {
  const candidates = regions.filter((fallbackCc) => fallbackCc !== currentCc);
  if (!candidates.length) return null;
  console.warn(`[app] ${appid} 在 ${currentCc} 不可用，尝试其它区服：${candidates.join(', ')}`);
  const regionResults = await mapLimit(candidates, FALLBACK_CONCURRENCY, async (fallbackCc) => {
    try {
      const app = await getAppData(appid, fallbackCc, STORE_LANGUAGE);
      return { app, fallbackCc };
    } catch {
      return null;
    }
  });
  const regionHit = regionResults.find(Boolean);
  if (!regionHit) return null;

  const fallbackRegion = REGION_BY_CC.get(regionHit.fallbackCc);
  const currentRegion = REGION_BY_CC.get(currentCc);
  console.log(`[app] ${appid} 通过 ${regionHit.fallbackCc} 区服取得数据`);
  return {
    ...regionHit.app,
    availability: 'store-region',
    source: 'store',
    fallbackRegion: { cc: regionHit.fallbackCc, code: fallbackRegion.code, name: fallbackRegion.name },
    note: `该游戏在 ${currentRegion.name} 区服不可用，以下数据来自 ${fallbackRegion.name} 区服。`,
  };
}

async function getAppData(appid, cc, language = STORE_LANGUAGE, { timeout = 12000, retries = 1 } = {}) {
  const region = REGION_BY_CC.get(cc) || REGION_BY_CC.get('us');
  const key = `app:${appid}:${region.cc}:${language}`;
  return cached(key, 10 * 60 * 1000, async () => {
    const url = `${STORE_ORIGIN}/api/appdetails?appids=${encodeURIComponent(appid)}&cc=${region.cc}&l=${language}`;
    // 社交账号在商店页面 HTML 里，和资料接口并行抓取。
    const [json, socialLinks] = await Promise.all([
      fetchJson(url, { timeout, retries }),
      fetchStoreSocialLinks(appid),
    ]);
    const result = json?.[String(appid)];
    if (!result || result.success !== true || !result.data) {
      throw new HttpError(404, '没有找到这款游戏，或该地区暂不提供', 'APP_NOT_FOUND');
    }
    const app = normalizeApp(appid, result.data, region);
    app.links = buildAppLinks(appid, app, socialLinks);
    return app;
  });
}

function parseAppid(value) {
  const appid = Number(value);
  if (!Number.isInteger(appid) || appid <= 0 || appid > 99999999) {
    throw new HttpError(400, 'App ID 格式不正确', 'INVALID_APPID');
  }
  return appid;
}

/* ---------------------- 社交媒体与社区链接 ---------------------- */

// 商店页面里开发者填写的社交账号：<a class="linkbar" data-tooltip-text="真实地址">
// <span class="social_account">平台名</span>
const SOCIAL_HOSTS = [
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i, 'YouTube'],
  [/(^|\.)discord\.com$|(^|\.)discord\.gg$|(^|\.)discordapp\.com$/i, 'Discord'],
  [/(^|\.)twitch\.tv$/i, 'Twitch'],
  [/(^|\.)twitter\.com$|(^|\.)x\.com$/i, 'X'],
  [/(^|\.)tiktok\.com$/i, 'TikTok'],
  [/(^|\.)instagram\.com$/i, 'Instagram'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$/i, 'Facebook'],
  [/(^|\.)bsky\.app$|(^|\.)bluesky\.app$/i, 'Bluesky'],
  [/(^|\.)reddit\.com$/i, 'Reddit'],
  [/(^|\.)vk\.com$/i, 'VK'],
  [/(^|\.)weibo\.(com|cn)$/i, '微博'],
  [/(^|\.)bilibili\.com$/i, '哔哩哔哩'],
  [/(^|\.)linktr\.ee$/i, 'Linktree'],
  [/(^|\.)patreon\.com$/i, 'Patreon'],
  [/(^|\.)youtube-nocookie\.com$/i, 'YouTube'],
];

function socialPlatform(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    for (const [pattern, label] of SOCIAL_HOSTS) {
      if (pattern.test(host)) return label;
    }
    return null;
  } catch {
    return null;
  }
}

// 抓商店页面，抽出开发者填写的社交账号。
async function fetchStoreSocialLinks(appid) {
  return cached(`social:${appid}`, 24 * 60 * 60 * 1000, async () => {
    try {
      const url = `${STORE_ORIGIN}/app/${appid}/?l=${STORE_LANGUAGE}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) return [];
      const html = await response.text();
      const links = [];
      const seen = new Set();
      const pattern = /<a\b[^>]*class="linkbar"[^>]*data-tooltip-text="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      for (const match of html.matchAll(pattern)) {
        const rawUrl = decodeEntities(match[1].trim());
        const platform = socialPlatform(rawUrl);
        if (!platform) continue;
        const labelMatch = match[2].match(/<span class="social_account">([^<]*)<\/span>/);
        const label = (labelMatch?.[1] || platform).trim();
        if (!rawUrl || seen.has(rawUrl)) continue;
        seen.add(rawUrl);
        links.push({ platform, label, url: rawUrl });
      }
      return links;
    } catch {
      return [];
    }
  });
}

// 组装游戏页上的「相关链接」：社交账号 + Steam 社区 + SteamDB + 官网 + 支持页。
function buildAppLinks(appid, app, socialLinks) {
  const links = [];
  const push = (platform, label, url) => {
    if (!url) return;
    try {
      const safe = new URL(url);
      if (safe.protocol !== 'http:' && safe.protocol !== 'https:') return;
    } catch {
      return;
    }
    links.push({ platform, label, url });
  };

  for (const social of socialLinks || []) push(social.platform, social.label, social.url);
  push('website', '游戏官网', app.website);
  push('support', '支持页面', app.supportUrl);
  push('community', 'Steam 社区', `${COMMUNITY_ORIGIN}/app/${appid}`);
  push('discussions', '社区讨论', `${COMMUNITY_ORIGIN}/app/${appid}/discussions/`);
  push('workshop', '创意工坊', `${COMMUNITY_ORIGIN}/app/${appid}/workshop/`);
  push('news', '更新记录', `${STORE_ORIGIN}/news/app/${appid}`);
  push('steamdb', 'SteamDB', `https://steamdb.info/app/${appid}/`);
  return links;
}

async function searchGames(query, cc) {
  const term = String(query || '').trim();
  if (!term) return { query: term, results: [] };
  if (term.length > 80) throw new HttpError(400, '搜索词过长', 'INVALID_QUERY');
  const region = REGION_BY_CC.get(cc) || REGION_BY_CC.get('cn');

  if (/^\d{1,8}$/.test(term)) {
    try {
      const game = await getAppData(parseAppid(term), region.cc, STORE_LANGUAGE);
      return {
        query: term,
        results: [{
          appid: game.appid,
          name: game.name,
          image: game.headerImage || game.capsuleImage,
          price: game.price,
          isFree: game.isFree,
          platforms: game.platforms,
          releaseDate: game.releaseDate,
        }],
      };
    } catch (error) {
      if (error.code !== 'APP_NOT_FOUND') throw error;
    }
  }

  const url = `${STORE_ORIGIN}/api/storesearch/?term=${encodeURIComponent(term)}&l=${STORE_LANGUAGE}&cc=${region.cc}`;
  const json = await cached(`search:${region.cc}:${term.toLowerCase()}`, 5 * 60 * 1000, () => fetchJson(url, { timeout: 9000 }));
  const items = Array.isArray(json?.items) ? json.items : [];
  const results = items
    .filter((item) => item.type === 'app' && item.id)
    .slice(0, 12)
    .map((item) => {
      const price = item.price ? {
        currency: item.price.currency || region.currency,
        final: Number(item.price.final) / 100,
        initial: Number(item.price.initial) / 100,
        discountPercent: Number(item.price.discount_percent) || (item.price.initial > item.price.final ? Math.round((1 - item.price.final / item.price.initial) * 100) : 0),
        finalFormatted: formatMoney(item.price.currency || region.currency, Number(item.price.final) / 100),
        initialFormatted: formatMoney(item.price.currency || region.currency, Number(item.price.initial) / 100),
      } : null;
      return {
        appid: item.id,
        name: item.name,
        image: item.tiny_image || '',
        price,
        isFree: Boolean(price && price.final === 0 && price.initial === 0),
        platforms: item.platforms || {},
        metascore: item.metascore || null,
      };
    });

  // 商店搜索只覆盖仍在售的游戏；再补上本地索引里的结果，
  // 这样已经下架（但 Steam 仍保留资料）的游戏也能被搜到。
  const seen = new Set(results.map((item) => item.appid));
  const indexed = appIndex.search(term, 12);
  for (const entry of indexed) {
    if (seen.has(entry.appid)) {
      const hit = results.find((item) => item.appid === entry.appid);
      if (hit) hit.inIndex = true;
      continue;
    }
    if (results.length >= 16) break;
    seen.add(entry.appid);
    results.push({
      appid: entry.appid,
      name: entry.n,
      image: `https://cdn.akamai.steamstatic.com/steam/apps/${entry.appid}/header.jpg`,
      price: null,
      isFree: false,
      platforms: {},
      metascore: null,
      releaseDate: entry.d || '',
      inIndex: true,
      unlisted: true,
    });
  }

  return { query: term, results, total: json?.total || results.length };
}

function featuredPrice(item) {
  if (item.original_price == null && item.final_price == null) return null;
  const currency = item.currency || 'CNY';
  const final = Number(item.final_price ?? 0) / 100;
  const initial = Number(item.original_price ?? item.final_price ?? 0) / 100;
  return {
    currency,
    final,
    initial,
    discountPercent: Number(item.discount_percent) || 0,
    finalFormatted: formatMoney(currency, final),
    initialFormatted: formatMoney(currency, initial),
    isFree: final === 0 && initial === 0,
  };
}

function normalizeFeaturedItem(item, sectionName) {
  return {
    appid: item.id,
    name: item.name,
    image: item.large_capsule_image || item.header_image || item.small_capsule_image || '',
    headerImage: item.header_image || item.large_capsule_image || '',
    smallImage: item.small_capsule_image || '',
    price: featuredPrice(item),
    discountPercent: Number(item.discount_percent) || 0,
    platforms: {
      windows: Boolean(item.windows_available),
      mac: Boolean(item.mac_available),
      linux: Boolean(item.linux_available),
    },
    section: sectionName,
  };
}

async function getFeatured(cc) {
  const region = REGION_BY_CC.get(cc) || REGION_BY_CC.get('cn');
  const key = `featured:${region.cc}`;
  return cached(key, 8 * 60 * 1000, async () => {
    const url = `${STORE_ORIGIN}/api/featuredcategories?cc=${region.cc}&l=${STORE_LANGUAGE}`;
    const json = await fetchJson(url, { timeout: 12000 });
    const pick = (name) => ({
      id: name,
      items: Array.isArray(json?.[name]?.items) ? json[name].items.slice(0, 12).map((item) => normalizeFeaturedItem(item, name)) : [],
    });
    return {
      region: { cc: region.cc, code: region.code, name: region.name, currency: region.currency },
      topSellers: pick('top_sellers').items,
      newReleases: pick('new_releases').items,
      specials: pick('specials').items,
      comingSoon: pick('coming_soon').items,
      fetchedAt: new Date().toISOString(),
    };
  });
}

async function getExchangeRates() {
  return cached('exchange-rates-cny', 12 * 60 * 60 * 1000, async () => {
    try {
      const json = await fetchJson('https://open.er-api.com/v6/latest/CNY', {
        timeout: 8000,
        retries: 1,
        headers: { 'User-Agent': 'SteamAtlas/1.0', Accept: 'application/json' },
      });
      if (json?.result === 'success' && json.rates) {
        return {
          base: 'CNY',
          rates: json.rates,
          updatedAt: json.time_last_update_utc || null,
          source: 'open.er-api.com',
          available: true,
        };
      }
    } catch {
      // Fall through to the secondary free provider.
    }
    try {
      const json = await fetchJson('https://api.frankfurter.app/latest?from=CNY', {
        timeout: 7000,
        retries: 0,
        headers: { 'User-Agent': 'SteamAtlas/1.0', Accept: 'application/json' },
      });
      if (json?.rates) {
        return {
          base: 'CNY',
          rates: { CNY: 1, ...json.rates },
          updatedAt: json.date || null,
          source: 'frankfurter.app',
          available: true,
        };
      }
    } catch {
      // Rates are optional; prices still display in local currency.
    }
    return { base: 'CNY', rates: { CNY: 1 }, updatedAt: null, source: null, available: false };
  });
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function getRegionPrices(appid) {
  const cacheKey = `prices:${appid}`;
  const cachedPrices = cacheGet(cacheKey);
  if (cachedPrices) return cachedPrices;

  const ratesInfo = await getExchangeRates();
  const rows = await mapLimit(REGIONS, 5, async (region) => {
    try {
      const game = await getAppData(appid, region.cc, 'english', { timeout: 9000, retries: 0 });
      const price = game.price;
      const isFree = game.isFree || (price && price.final === 0);
      const amount = price ? price.final : (isFree ? 0 : null);
      const rate = Number(ratesInfo.rates?.[price?.currency || region.currency]);
      const cny = amount != null && Number.isFinite(rate) && rate > 0 ? amount / rate : (isFree ? 0 : null);
      const storeCurrency = price?.currency || region.currency;
      return {
        ...region,
        storeCurrency,
        currencyMismatch: Boolean(price?.currency) && price.currency !== region.currency,
        available: Boolean(price) || isFree,
        isFree,
        price: price ? { ...price, finalFormatted: isFree ? '免费' : price.finalFormatted } : null,
        cny: cny == null ? null : Math.round(cny * 100) / 100,
        cnyFormatted: cny == null ? null : formatMoney('CNY', cny),
        gameName: game.name,
      };
    } catch (error) {
      return {
        ...region,
        available: false,
        isFree: false,
        price: null,
        cny: null,
        cnyFormatted: null,
        error: error.status === 404 ? '该区暂不可用' : '获取失败',
      };
    }
  });

  const available = rows.filter((row) => row.available);
  const ranked = [...available].filter((row) => row.cny != null).sort((a, b) => a.cny - b.cny);
  const lowest = ranked[0] || null;
  const highest = ranked.length ? ranked[ranked.length - 1] : null;
  const china = rows.find((row) => row.cc === 'cn') || null;
  const spreadPercent = lowest && highest && lowest.cny > 0
    ? Math.round(((highest.cny - lowest.cny) / lowest.cny) * 100)
    : null;

  const result = {
    appid,
    name: available[0]?.gameName || null,
    rows,
    availableCount: available.length,
    lowestCc: lowest?.cc || null,
    highestCc: highest?.cc || null,
    china,
    spreadPercent,
    rates: {
      available: ratesInfo.available,
      source: ratesInfo.source,
      updatedAt: ratesInfo.updatedAt,
    },
    fetchedAt: new Date().toISOString(),
    disclaimer: '跨区价格与购买限制以 Steam 商店实际结算为准；人民币金额按公开汇率估算，仅供参考。',
  };
  cacheSet(cacheKey, result, 10 * 60 * 1000);
  return result;
}

function xmlValue(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return null;
  return decodeEntities(match[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim());
}

function parseVisibility(value, state) {
  if (state === 'private') return 'private';
  if (state === 'friendsonly') return 'friends';
  if (state === 'public') return 'public';
  if (value === 3) return 'public';
  if (value === 2) return 'friends';
  return 'private';
}

function parsePublicProfileXml(xml, fallbackSteamId) {
  if (!xml || /<error>/i.test(xml)) return null;
  const steamId = xmlValue(xml, 'steamID64') || fallbackSteamId;
  if (!steamId) return null;
  const privacyState = xmlValue(xml, 'privacyState');
  const groupBlocks = [...String(xml).matchAll(/<group\s+isPrimary="([01])">([\s\S]*?)<\/group>/gi)];
  const primaryGroupMatch = groupBlocks.find((match) => match[1] === '1');
  const primaryGroup = primaryGroupMatch ? {
    name: xmlValue(primaryGroupMatch[2], 'groupName'),
    url: xmlValue(primaryGroupMatch[2], 'groupURL'),
    avatar: xmlValue(primaryGroupMatch[2], 'avatarMedium'),
    members: Number(xmlValue(primaryGroupMatch[2], 'memberCount')) || null,
  } : null;
  const statusText = xmlValue(xml, 'onlineState') || 'offline';
  return {
    steamId,
    personaName: xmlValue(xml, 'steamID') || 'Steam 玩家',
    realName: xmlValue(xml, 'realname'),
    avatar: xmlValue(xml, 'avatarFull') || xmlValue(xml, 'avatarMedium'),
    avatarMedium: xmlValue(xml, 'avatarMedium'),
    profileUrl: `${COMMUNITY_ORIGIN}/profiles/${steamId}`,
    customUrl: xmlValue(xml, 'customURL'),
    status: statusText,
    statusLabel: statusText === 'in-game' ? '游戏中' : statusText === 'online' ? '在线' : '离线',
    stateMessage: xmlValue(xml, 'stateMessage'),
    visibility: parseVisibility(null, privacyState),
    privacyState,
    memberSince: xmlValue(xml, 'memberSince'),
    location: xmlValue(xml, 'location'),
    headline: xmlValue(xml, 'headline'),
    summary: xmlValue(xml, 'summary'),
    hoursPlayed2Wk: Number(xmlValue(xml, 'hoursPlayed2Wk')) || 0,
    vacBanned: xmlValue(xml, 'vacBanned') === '1',
    tradeBanState: xmlValue(xml, 'tradeBanState'),
    limitedAccount: xmlValue(xml, 'isLimitedAccount') === '1',
    primaryGroup,
    groupCount: groupBlocks.length,
    source: 'public',
    level: null,
    recentGames: [],
    bans: null,
    createdAt: null,
    country: null,
    library: null,
    libraryCount: null,
    libraryHours: null,
    totalPlaytimeMinutes: null,
    levelXp: null,
    badgeCount: null,
    badgeLevel: null,
    nextLevelXp: null,
    privacy: {
      profile: parseVisibility(null, privacyState),
      details: false,
      games: xmlValue(xml, 'hoursPlayed2Wk') ? 'public' : 'private',
      playtime: xmlValue(xml, 'hoursPlayed2Wk') ? 'public' : 'private',
      realName: xmlValue(xml, 'realname') ? 'public' : 'private',
      location: xmlValue(xml, 'location') ? 'public' : 'private',
      lastOnline: 'private',
      groups: groupBlocks.length ? 'public' : 'private',
      comments: 'private',
    },
    title: titleFor(steamId),
  };
}

function parseProfileInput(raw) {
  let input = String(raw || '').trim();
  if (!input) throw new HttpError(400, '请输入 SteamID、个性域名或主页链接', 'INVALID_PROFILE');
  if (input.length > 200) throw new HttpError(400, '输入内容过长', 'INVALID_PROFILE');

  // Allow pasting "steamcommunity.com/id/xxx" without the scheme.
  if (!/^https?:\/\//i.test(input) && /^(www\.)?steamcommunity\.com\//i.test(input)) {
    input = `https://${input}`;
  }

  if (/^https?:\/\//i.test(input)) {
    let url;
    try { url = new URL(input); } catch { throw new HttpError(400, 'Steam 主页链接格式不正确', 'INVALID_PROFILE'); }
    if (!/(^|\.)steamcommunity\.com$/i.test(url.hostname)) {
      throw new HttpError(400, '请粘贴 steamcommunity.com 的主页链接', 'INVALID_PROFILE');
    }
    const profileMatch = url.pathname.match(/^\/profiles\/(\d{17})\/?$/i);
    if (profileMatch) return { steamId: profileMatch[1], vanity: null };
    const vanityMatch = url.pathname.match(/^\/id\/([^/]+)\/?$/i);
    if (vanityMatch) return { steamId: null, vanity: decodeURIComponent(vanityMatch[1]) };
    throw new HttpError(400, '链接中未找到有效的 SteamID 或个性域名', 'INVALID_PROFILE');
  }

  const clean = input.replace(/^@/, '');
  if (/^\d{17}$/.test(clean)) return { steamId: clean, vanity: null };

  // SteamID3, e.g. [U:1:134223490] or U:1:134223490.
  const id3Match = clean.match(/^\[?U:1:(\d+)\]?$/i);
  if (id3Match) {
    const accountId = BigInt(id3Match[1]);
    if (accountId > 4294967295n) throw new HttpError(400, 'SteamID3 账号部分超出范围', 'INVALID_PROFILE');
    return { steamId: (accountId + 76561197960265728n).toString(), vanity: null };
  }

  if (/^[A-Za-z0-9_-]{2,64}$/.test(clean)) return { steamId: null, vanity: clean };
  throw new HttpError(400, 'Steam 不支持按昵称搜索。请填写 17 位 SteamID64、个性域名（如 gabe）或完整主页链接', 'INVALID_PROFILE');
}

async function resolveVanity(vanity, key) {
  // Steam exposes vanity resolution under ISteamUser, not IPlayerService.
  const url = new URL(`${WEB_API_ORIGIN}/ISteamUser/ResolveVanityURL/v1/`);
  url.searchParams.set('key', key);
  url.searchParams.set('vanityurl', vanity);
  const json = await fetchJson(url.toString(), {
    timeout: 10000,
    retries: 0,
    headers: { Accept: 'application/json', 'User-Agent': 'SteamAtlas/1.0' },
  });
  if (json?.response?.success !== 1 || !json.response.steamid) {
    throw new HttpError(404, '没有找到这个个性域名对应的玩家', 'PROFILE_NOT_FOUND');
  }
  return json.response.steamid;
}

function personaStatus(state) {
  return ({
    0: { label: '离线', tone: 'offline' },
    1: { label: '在线', tone: 'online' },
    2: { label: '忙碌', tone: 'busy' },
    3: { label: '离开', tone: 'away' },
    4: { label: '打盹', tone: 'away' },
    5: { label: '想交易', tone: 'online' },
    6: { label: '想玩游戏', tone: 'online' },
  })[state] || { label: '未知', tone: 'offline' };
}

function visibilityLabel(value) {
  return ({ 1: '私密', 2: '仅好友', 3: '公开' })[value] || '未知';
}

function countryName(code) {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
}

async function getSteamLevelDetails(steamId, key) {
  try {
    const badgesUrl = new URL(`${WEB_API_ORIGIN}/IPlayerService/GetBadges/v1/`);
    badgesUrl.searchParams.set('key', key);
    badgesUrl.searchParams.set('steamid', steamId);
    const json = await fetchJson(badgesUrl.toString(), {
      timeout: 10000,
      retries: 0,
      headers: { Accept: 'application/json', 'User-Agent': 'SteamAtlas/1.0' },
    });
    const badges = json?.response?.badges || [];
    if (!badges.length) return null;
    const totalXp = badges.reduce((sum, badge) => sum + (Number(badge.xp) || 0), 0);
    const badgeLevel = badges.reduce((sum, badge) => sum + (Number(badge.level) || 0), 0);
    const playerLevel = json?.response?.player_level ?? null;
    const playerXp = json?.response?.player_xp ?? null;
    return {
      xp: playerXp != null ? Number(playerXp) : totalXp,
      badgeCount: badges.length,
      badgeLevel,
      level: playerLevel,
      nextLevelXp: json?.response?.player_xp_needed_to_level_up ?? null,
      remainingXp: json?.response?.player_xp_needed_current_level ?? null,
    };
  } catch {
    return null;
  }
}

async function getRecentGames(steamId, key) {
  try {
    const url = new URL(`${WEB_API_ORIGIN}/IPlayerService/GetRecentlyPlayedGames/v1/`);
    url.searchParams.set('key', key);
    url.searchParams.set('steamid', steamId);
    url.searchParams.set('count', '8');
    const json = await fetchJson(url.toString(), {
      timeout: 10000,
      retries: 0,
      headers: { Accept: 'application/json', 'User-Agent': 'SteamAtlas/1.0' },
    });
    const games = json?.response?.games || [];
    return games.map((game) => ({
      appid: game.appid,
      name: game.name,
      icon: game.img_icon_url ? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg` : '',
      header: `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/header.jpg`,
      playtime2Weeks: game.playtime_2weeks || 0,
      playtimeForever: game.playtime_forever || 0,
    }));
  } catch {
    return [];
  }
}

async function getOwnedGames(steamId, key) {
  try {
    const url = new URL(`${WEB_API_ORIGIN}/IPlayerService/GetOwnedGames/v1/`);
    url.searchParams.set('key', key);
    url.searchParams.set('steamid', steamId);
    url.searchParams.set('include_appinfo', '1');
    url.searchParams.set('include_played_free_games', '1');
    const json = await fetchJson(url.toString(), {
      timeout: 12000,
      retries: 0,
      headers: { Accept: 'application/json', 'User-Agent': 'SteamAtlas/1.0' },
    });
    const games = json?.response?.games || [];
    if (!games.length) return null;
    const totalMinutes = games.reduce((sum, game) => sum + (game.playtime_forever || 0), 0);
    const top = [...games]
      .sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0))
      .slice(0, 6)
      .map((game) => ({
        appid: game.appid,
        name: game.name,
        minutes: game.playtime_forever || 0,
        hours: Math.round((game.playtime_forever || 0) / 60 * 10) / 10,
        header: `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/header.jpg`,
      }));
    return {
      count: json?.response?.game_count ?? games.length,
      totalMinutes,
      totalHours: Math.round(totalMinutes / 60),
      top,
    };
  } catch {
    return null;
  }
}

async function getProfileFromWebApi(steamId, key) {
  const summaryUrl = new URL(`${WEB_API_ORIGIN}/ISteamUser/GetPlayerSummaries/v2/`);
  summaryUrl.searchParams.set('key', key);
  summaryUrl.searchParams.set('steamids', steamId);
  const summaryJson = await fetchJson(summaryUrl.toString(), {
    timeout: 10000,
    retries: 0,
    headers: { Accept: 'application/json', 'User-Agent': 'SteamAtlas/1.0' },
  });
  const player = summaryJson?.response?.players?.[0];
  if (!player) throw new HttpError(404, '没有找到这个 Steam 玩家', 'PROFILE_NOT_FOUND');

  const levelUrl = new URL(`${WEB_API_ORIGIN}/IPlayerService/GetSteamLevel/v1/`);
  levelUrl.searchParams.set('key', key);
  levelUrl.searchParams.set('steamid', steamId);
  const bansUrl = new URL(`${WEB_API_ORIGIN}/ISteamUser/GetPlayerBans/v1/`);
  bansUrl.searchParams.set('key', key);
  bansUrl.searchParams.set('steamids', steamId);

  const [levelResult, bansResult, recentGames, library, levelDetails] = await Promise.all([
    fetchJson(levelUrl.toString(), { timeout: 9000, retries: 0, headers: { Accept: 'application/json' } }).catch(() => null),
    fetchJson(bansUrl.toString(), { timeout: 9000, retries: 0, headers: { Accept: 'application/json' } }).catch(() => null),
    player.communityvisibilitystate === 3 ? getRecentGames(steamId, key) : Promise.resolve([]),
    player.communityvisibilitystate === 3 ? getOwnedGames(steamId, key) : Promise.resolve(null),
    getSteamLevelDetails(steamId, key),
  ]);

  const level = levelDetails?.level ?? levelResult?.response?.player_level ?? null;
  const gamesPrivate = player.communityvisibilitystate !== 3 || (library == null && recentGames.length === 0);
  const privacy = {
    profile: player.communityvisibilitystate === 3 ? 'public' : player.communityvisibilitystate === 2 ? 'friends' : 'private',
    details: player.communityvisibilitystate === 3,
    games: player.communityvisibilitystate === 3 ? (gamesPrivate ? 'private' : 'public') : (player.communityvisibilitystate === 2 ? 'friends' : 'private'),
    playtime: player.communityvisibilitystate === 3 ? (gamesPrivate ? 'private' : 'public') : 'private',
    realName: player.realname ? 'public' : 'private',
    location: player.loccountrycode ? 'public' : 'private',
    lastOnline: player.lastlogoff ? 'public' : 'private',
    groups: 'private',
    comments: player.communityvisibilitystate === 3 ? 'public' : 'private',
  };

  const ban = bansResult?.players?.[0] || null;
  const status = personaStatus(player.personastate);
  return {
    steamId: player.steamid,
    personaName: player.personaname || 'Steam 玩家',
    realName: player.realname || null,
    avatar: player.avatarfull || player.avatarmedium || player.avatar || '',
    avatarMedium: player.avatarmedium || player.avatar || '',
    profileUrl: player.profileurl || `${COMMUNITY_ORIGIN}/profiles/${player.steamid}`,
    customUrl: null,
    status: player.personastate,
    statusLabel: status.label,
    statusTone: status.tone,
    stateMessage: player.gameextrainfo ? `正在玩 ${player.gameextrainfo}` : null,
    gameName: player.gameextrainfo || null,
    gameId: player.gameid || null,
    visibility: ({ 1: 'private', 2: 'friends', 3: 'public' })[player.communityvisibilitystate] || 'private',
    visibilityLabel: visibilityLabel(player.communityvisibilitystate),
    createdAt: player.timecreated ? new Date(player.timecreated * 1000).toISOString() : null,
    lastLogoff: player.lastlogoff ? new Date(player.lastlogoff * 1000).toISOString() : null,
    countryCode: player.loccountrycode || null,
    country: countryName(player.loccountrycode),
    stateCode: player.locstatecode || null,
    cityId: player.loccityid || null,
    level,
    levelXp: levelDetails?.xp ?? null,
    badgeCount: levelDetails?.badgeCount ?? null,
    badgeLevel: levelDetails?.badgeLevel ?? null,
    nextLevelXp: levelDetails?.nextLevelXp ?? null,
    recentGames,
    bans: ban ? {
      vacBanned: Boolean(ban.VACBanned),
      numberOfVacBans: Number(ban.NumberOfVACBans) || 0,
      // 游戏封禁（Game Ban）不在 VAC 封禁里，Steam 单独用一个字段统计
      gameBanned: Number(ban.NumberOfGameBans) > 0,
      numberOfGameBans: Number(ban.NumberOfGameBans) || 0,
      daysSinceLastBan: Number(ban.DaysSinceLastBan) || 0,
      communityBanned: Boolean(ban.CommunityBanned),
      tradeBan: String(ban.EconomyBan || 'none') !== 'none',
      economyBan: ban.EconomyBan || 'none',
    } : null,
    // 与公开档案字段保持一致，便于前端统一展示
    vacBanned: ban ? Boolean(ban.VACBanned) : null,
    tradeBanState: ban ? (String(ban.EconomyBan || 'none') !== 'none' ? String(ban.EconomyBan) : 'None') : null,
    source: 'webapi',
    apiUsed: true,
    memberSince: player.timecreated ? new Date(player.timecreated * 1000).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : null,
    location: [countryName(player.loccountrycode), player.locstatecode].filter(Boolean).join(' · ') || null,
    headline: null,
    summary: null,
    hoursPlayed2Wk: recentGames.reduce((sum, game) => sum + (game.playtime2Weeks || 0), 0) / 60,
    primaryGroup: null,
    groupCount: 0,
    limitedAccount: false,
    library,
    libraryCount: library?.count ?? null,
    libraryHours: library?.totalHours ?? null,
    totalPlaytimeMinutes: library?.totalMinutes ?? null,
    privacy,
    title: titleFor(steamId),
  };
}

async function getPublicProfile(steamId, vanity) {
  const identifier = steamId ? `profiles/${steamId}` : `id/${encodeURIComponent(vanity)}`;
  const url = `${COMMUNITY_ORIGIN}/${identifier}/?xml=1&l=english`;
  const { status, text } = await fetchText(url);
  if (status === 404) throw new HttpError(404, '没有找到这个 Steam 玩家', 'PROFILE_NOT_FOUND');
  const profile = parsePublicProfileXml(text, steamId);
  if (!profile) throw new HttpError(404, '没有找到这个 Steam 玩家，或档案不可访问', 'PROFILE_NOT_FOUND');
  return profile;
}

// Valve 员工的 Steam 资料页上会挂一条官方横幅，只有 HTML 页面里才有
// （XML 接口不返回这个标记）。这是 Steam 自己给出的判定，最可靠。
async function detectValveEmployee(steamId) {
  const id = String(steamId || '').trim();
  if (!/^\d{17}$/.test(id)) return false;
  return cached(`valve:${id}`, 12 * 60 * 60 * 1000, async () => {
    try {
      const url = `${COMMUNITY_ORIGIN}/profiles/${id}/`;
      const response = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        signal: AbortSignal.timeout(12000),
        redirect: 'follow',
      });
      if (!response.ok) return false;
      const html = await response.text();
      return html.includes('profile_header_valve_employee') || html.includes('ValveEmployee_80.png');
    } catch {
      return false;
    }
  });
}

async function getProfile(rawInput, key) {
  const parsed = parseProfileInput(rawInput);
  let officialError = null;
  let steamId = parsed.steamId;

  if (key) {
    try {
      if (!steamId && parsed.vanity) steamId = await resolveVanity(parsed.vanity, key);
      const profile = await getProfileFromWebApi(steamId, key);
      profile.isValveEmployee = await detectValveEmployee(profile.steamId);
      return profile;
    } catch (error) {
      officialError = error;
    }
  }

  try {
    const publicProfile = await getPublicProfile(steamId, parsed.vanity);
    if (officialError && key) {
      publicProfile.warning = officialError.code === 'STEAM_API_FORBIDDEN'
        ? 'Steam Web API Key 无效或没有该接口的权限，已切换到公开资料模式。'
        : officialError.status === 403
          ? 'Steam Web API Key 无效或权限不足，已切换到公开资料模式。'
          : `官方 API 暂时不可用（${officialError.message}），已切换到公开资料模式。`;
      publicProfile.apiError = officialError.code || 'WEB_API_ERROR';
    }
    publicProfile.isValveEmployee = await detectValveEmployee(publicProfile.steamId);
    return publicProfile;
  } catch (publicError) {
    if (officialError) throw officialError;
    throw publicError;
  }
}

/* =========================================================
   Steam OpenID 2.0 login + local sessions
   Steam has no OAuth; the official way to sign a user in is
   the Steam OpenID 2.0 provider with a signed checkid_setup
   handshake, verified with the server-side Web API key.
   ========================================================= */
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const OPENID_ENDPOINT = `${COMMUNITY_ORIGIN}/openid/login`;
// Steam validates the claimed_id / identity pair and rejects anything that is
// not a real identity URL ("Invalid claimed_id or identity"). Two details
// matter: the value must use the **http** scheme (Steam's own identity URLs
// are http://steamcommunity.com/openid/id/<SteamID>, an https:// variant is
// refused), and it must be the **generic placeholder** Steam documents —
// 76561197960287930 — or the exact SteamID of the account that is signed in.
// A specific *other* account is rejected, because Steam compares the value
// with the identity of the signed-in user.
//
// The generic identity used by working Steam OpenID clients (SteamDB,
// ProtonDB, SteamGridDB, SteamSets …) is OpenID 2.0's "identifier_select",
// not a SteamID URL:
//
//   openid.claimed_id = http://specs.openid.net/auth/2.0/identifier_select
//   openid.identity   = http://specs.openid.net/auth/2.0/identifier_select
//
// Steam then shows the account picker and returns the real identity
// (https://steamcommunity.com/openid/id/<SteamID>) in the id_res reply.
// A SteamID URL as the claimed_id is rejected with
// "Invalid claimed_id or identity".
//
// STEAM_OPENID_CLAIMED_ID overrides it and is re-read from .env on every
// login, so another form can be tried without a restart.
const DEFAULT_CLAIMED_ID = 'http://specs.openid.net/auth/2.0/identifier_select';
function currentClaimedId() {
  // .env 里的值优先（它是可以在运行期改的），没有才用进程环境变量。
  const fromFile = loadEnvFile({ override: false }).STEAM_OPENID_CLAIMED_ID;
  const value = String(fromFile || process.env.STEAM_OPENID_CLAIMED_ID || DEFAULT_CLAIMED_ID).trim();
  return value;
}
// Steam echoes the identity back as https://steamcommunity.com/openid/id/<SteamID>,
// but accept the http:// form as well.
const steamIdFromIdentity = (value) => {
  const match = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/i.exec(String(value || '').trim());
  return match ? match[1] : '';
};
const SESSION_COOKIE = 'steam_atlas_sid';
const STATE_COOKIE = 'steam_atlas_state';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const AUTH_STATE_TTL_MS = 1000 * 60 * 10;

const authSessions = new Map();
const authStates = new Map();

// The OpenID return_to has to live on the same domain that is registered for
// the Steam Web API key, because Steam signs the response with that key.
// Behind a reverse proxy the public origin comes from the forwarded headers.
function publicOrigin(req) {
  // .env 里的 PUBLIC_ORIGIN 优先，并在运行期重新读取（改完不用重启）。
  const fromFile = loadEnvFile({ override: false }).PUBLIC_ORIGIN;
  const override = fromFile || process.env.PUBLIC_ORIGIN;
  if (override) return String(override).replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
    || req.headers.host
    || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

function parseCookies(req) {  const header = req.headers.cookie || '';
  const jar = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try {
      jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      jar[part.slice(0, index).trim()] = '';
    }
  }
  return jar;
}

function buildOpenIdUrl(returnTo, realm = '') {
  const claimedId = currentClaimedId();
  // Steam 的报错是 "Invalid claimed_id or identity"，有可能它只认其中之一，
  // 所以这两个字段可以单独开关，方便逐种组合试（.env 里改，不用重启）。
  const mode = String(loadEnvFile({ override: false }).STEAM_OPENID_IDENTITY_MODE
    || process.env.STEAM_OPENID_IDENTITY_MODE || 'both').trim().toLowerCase();
  // 字段顺序和 openid.realm 都对齐 SteamDB / ProtonDB / SteamGridDB 的实际请求：
  //   ns → mode → claimed_id → identity → realm → return_to
  const params = new URLSearchParams();
  params.set('openid.ns', OPENID_NS);
  params.set('openid.mode', 'checkid_setup');
  if (mode !== 'identity') params.set('openid.claimed_id', claimedId);
  if (mode !== 'claimed') params.set('openid.identity', claimedId);
  if (realm) params.set('openid.realm', realm);
  params.set('openid.return_to', returnTo);
  return `${OPENID_ENDPOINT}?${params.toString()}`;
}

// OpenID 2.0 signature: HMAC-SHA1 over the signed fields, in the exact order
// listed by openid.signed, each rendered as `field=urlencoded(value)` joined
// by `&`, keyed with the shared secret (the Steam Web API key).
// The OpenID 2.0 spec, Steam's own implementation and the widely used
// reference libraries disagree on how the signed values are escaped, in which
// order they are concatenated, and whether the raw or the decoded query value
// is signed. We therefore compute the HMAC for every plausible variant and
// accept a match on any of them. Every candidate is still HMAC-verified with
// the API key, so accepting several encodings does not weaken the check.
function rawQueryValues(rawUrl) {
  const query = String(rawUrl || '').split('?')[1] || '';
  const out = {};
  for (const part of query.split('&')) {
    if (!part) continue;
    const index = part.indexOf('=');
    const name = index < 0 ? part : part.slice(0, index);
    const value = index < 0 ? '' : part.slice(index + 1);
    try {
      out[decodeURIComponent(name.replace(/\+/g, ' '))] = value;
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function openIdSignatureCandidates(signed, decodedParams, rawParams) {
  const sources = [decodedParams, rawParams];
  const encoders = [
    (value) => encodeURIComponent(value),
    (value) => encodeURIComponent(value).replace(/%2F/g, '/'),
    (value) => encodeURIComponent(value).replace(/%20/g, '+'),
    (value) => value,
  ];
  const orders = [signed, [...signed].sort()];
  const candidates = [];
  for (const source of sources) {
    for (const order of orders) {
      for (const encode of encoders) {
        const payload = order
          .map((field) => `${field}=${encode(source[`openid.${field}`] ?? '')}`)
          .join('&');
        candidates.push(payload);
        candidates.push(`${payload}&`);
      }
    }
  }
  return candidates;
}

function verifyOpenIdSignature(params, apiKey, rawUrl = '') {
  const signed = (params.get('openid.signed') || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!signed.length) throw new HttpError(400, 'OpenID 响应缺少签名信息', 'OPENID_INVALID');
  // Steam signs: signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle
  // — OpenID 2.0 does not sign "ns" (the standard namespace is implied), so it
  // must not be required here.
  for (const field of ['signed', 'claimed_id', 'identity']) {
    if (!signed.includes(field)) throw new HttpError(400, `OpenID 签名缺少 ${field} 字段`, 'OPENID_INVALID');
  }
  const rawParams = rawQueryValues(rawUrl);
  const decoded = {};
  for (const field of signed) decoded[`openid.${field}`] = params.get(`openid.${field}`) || '';

  const actual = Buffer.from(params.get('openid.sig') || '');
  const payloads = openIdSignatureCandidates(signed, decoded, rawParams);
  // The shared secret may be used as raw text or as decoded bytes.
  const keys = [Buffer.from(String(apiKey), 'utf8')];
  if (/^[0-9a-fA-F]{32,}$/.test(String(apiKey))) keys.push(Buffer.from(String(apiKey), 'hex'));
  if (/^[A-Za-z0-9+/=]+$/.test(String(apiKey))) {
    const decodedKey = Buffer.from(String(apiKey), 'base64');
    if (decodedKey.length) keys.push(decodedKey);
  }

  for (const key of keys) {
    for (const payload of payloads) {
      const expected = Buffer.from(crypto.createHmac('sha1', key).update(payload).digest('base64'));
      if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
        console.log('[auth] 签名校验通过');
        return signed;
      }
    }
  }
  console.warn('[auth] 签名校验失败，候选载荷数:', payloads.length * keys.length, 'signed:', signed.join('|'));
  console.warn('[auth] 原始回跳 URL:', String(rawUrl || '').slice(0, 2000));
  throw new HttpError(
    400,
    'OpenID 签名校验失败。Steam 用「回调地址所在域名注册的 Steam Web API Key」给回跳签名，若当前访问域名与 Key 的注册域名不一致就无法通过校验。',
    'OPENID_BAD_SIGNATURE',
  );
}

async function fetchPlayerSummary(steamId, key) {
  const url = `${WEB_API_ORIGIN}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamId)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) {
    throw new HttpError(502, `Steam 上游返回了 ${response.status}`, response.status === 403 ? 'STEAM_API_FORBIDDEN' : 'UPSTREAM_ERROR');
  }
  const data = await response.json();
  return data?.response?.players?.[0] || null;
}

function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  authSessions.set(token, { ...user, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function readSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = authSessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    authSessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function sessionCookie(token, { clear = false, secure = false } = {}) {
  const parts = [`${SESSION_COOKIE}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (clear) parts.push('Max-Age=0');
  else parts.push(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  return parts.join('; ');
}

// The login state is carried in its own cookie as well, so it survives even if
// Steam rewrites the return_to query string on the way back.
function stateCookie(state, { clear = false, secure = false } = {}) {
  const parts = [`${STATE_COOKIE}=${clear ? '' : state}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (clear) parts.push('Max-Age=0');
  else parts.push(`Max-Age=${Math.floor(AUTH_STATE_TTL_MS / 1000)}`);
  return parts.join('; ');
}

// Steam may normalise the return_to URL (trailing slash, reordered query, …),
// so bind it by origin + path and let the state provide the CSRF guarantee.
function sameReturnTarget(a, b) {
  if (a === b) return true;
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

// 取出 origin 里的主机名（不含端口）。
function hostOf(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

/* =========================================================
   Admin backend
   A small password protected area to inspect the server and
   manage the player titles shown next to Steam persona names.
   ========================================================= */
const DATA_DIR = path.join(__dirname, 'data');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const TITLES_FILE = path.join(DATA_DIR, 'titles.json');
const ADMIN_COOKIE = 'steam_atlas_admin';
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const ADMIN_LOGIN_WINDOW_MS = 1000 * 60 * 10;
const ADMIN_MAX_ATTEMPTS = 10;
const ADMIN_ITERATIONS = 120000;

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'steamweb').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'qwerQWER1';

const adminSessions = new Map();
const adminAttempts = new Map();

function hashPassword(password, salt, iterations = ADMIN_ITERATIONS) {
  return crypto.pbkdf2Sync(String(password), salt, iterations, 64, 'sha512').toString('hex');
}

function ensureAdminCredential() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const salt = crypto.randomBytes(16).toString('hex');
    const payload = {
      username: ADMIN_USERNAME,
      salt,
      iterations: ADMIN_ITERATIONS,
      hash: hashPassword(ADMIN_PASSWORD, salt),
      source: 'env',
      updatedAt: new Date().toISOString(),
    };
    if (!existsSync(ADMIN_FILE)) {
      writeFileSync(ADMIN_FILE, `${JSON.stringify(payload, null, 2)}\n`);
      return;
    }
    let current = null;
    try { current = JSON.parse(readFileSync(ADMIN_FILE, 'utf8')); } catch { current = null; }
    if (!current || !current.hash) {
      writeFileSync(ADMIN_FILE, `${JSON.stringify(payload, null, 2)}\n`);
      return;
    }
    // 管理员在后台自己改过密码（source = ui）时，以后台的为准，
    // 环境变量只在凭据仍然来自环境变量（source = env）时才会覆盖。
    const changedInUi = current.source === 'ui';
    if (changedInUi) return;
    const envPasswordChanged = !process.env.ADMIN_PASSWORD
      || !verifyAdminCredentials(current.username, ADMIN_PASSWORD);
    if (current.username !== ADMIN_USERNAME || envPasswordChanged) {
      writeFileSync(ADMIN_FILE, `${JSON.stringify(payload, null, 2)}\n`);
    }
  } catch (error) {
    console.error('[admin] 无法写入管理员凭据文件:', error?.message || error);
  }
}

function verifyAdminCredentials(username, password) {
  try {
    const data = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
    if (String(username || '') !== String(data.username || '')) return false;
    const candidate = Buffer.from(hashPassword(password || '', data.salt, data.iterations || ADMIN_ITERATIONS), 'hex');
    const expected = Buffer.from(String(data.hash || ''), 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

// 修改管理员密码：必须先验证当前密码，再用新盐重新哈希写入。
// 返回 { username }，失败时抛出 HttpError。
function changeAdminPassword(currentPassword, newPassword) {
  let data;
  try {
    data = JSON.parse(readFileSync(ADMIN_FILE, 'utf8'));
  } catch {
    throw new HttpError(500, '管理员凭据文件不可读', 'ADMIN_FILE_ERROR');
  }
  if (!verifyAdminCredentials(data.username, currentPassword)) {
    throw new HttpError(401, '当前密码不正确', 'ADMIN_BAD_CREDENTIALS');
  }
  const next = String(newPassword || '');
  if (next.length < 8) throw new HttpError(400, '新密码至少 8 位', 'ADMIN_WEAK_PASSWORD');
  if (next.length > 128) throw new HttpError(400, '新密码过长（最多 128 位）', 'ADMIN_WEAK_PASSWORD');
  if (next === String(currentPassword)) throw new HttpError(400, '新密码不能与当前密码相同', 'ADMIN_WEAK_PASSWORD');
  if (!/[A-Za-z]/.test(next) || !/\d/.test(next)) {
    throw new HttpError(400, '新密码需要同时包含字母和数字', 'ADMIN_WEAK_PASSWORD');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const payload = {
    username: data.username,
    salt,
    iterations: ADMIN_ITERATIONS,
    hash: hashPassword(next, salt),
    source: 'ui',
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(ADMIN_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  return { username: payload.username };
}

function adminAttemptBlocked(ip) {
  const record = adminAttempts.get(ip);
  if (!record) return false;
  if (Date.now() - record.first > ADMIN_LOGIN_WINDOW_MS) {
    adminAttempts.delete(ip);
    return false;
  }
  return record.count >= ADMIN_MAX_ATTEMPTS;
}

function noteAdminAttempt(ip, failed) {
  if (!failed) { adminAttempts.delete(ip); return; }
  const record = adminAttempts.get(ip);
  if (!record || Date.now() - record.first > ADMIN_LOGIN_WINDOW_MS) {
    adminAttempts.set(ip, { count: 1, first: Date.now() });
    return;
  }
  record.count += 1;
}

function createAdminSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, { username, createdAt: Date.now(), expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
  return token;
}

function readAdminSession(req) {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function adminCookie(token, { clear = false } = {}) {
  const parts = [`${ADMIN_COOKIE}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (clear) parts.push('Max-Age=0');
  else parts.push(`Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`);
  return parts.join('; ');
}

function requireAdmin(req) {
  const session = readAdminSession(req);
  if (!session) throw new HttpError(401, '需要管理员登录', 'ADMIN_UNAUTHORIZED');
  return session;
}

function loadTitles() {
  try {
    if (!existsSync(TITLES_FILE)) return new Map(DEFAULT_PLAYER_TITLES.map((item) => [item.steamId, item]));
    const raw = JSON.parse(readFileSync(TITLES_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw?.titles;
    const map = new Map();
    for (const item of Array.isArray(list) ? list : []) {
      const steamId = String(item?.steamId || '').trim();
      const label = String(item?.label || '').trim();
      if (!/^\d{17}$/.test(steamId) || !label) continue;
      map.set(steamId, {
        id: String(item.id || label.toLowerCase().replace(/\s+/g, '-')).slice(0, 32),
        steamId,
        label: label.slice(0, 24),
        color: ['crimson', 'blue', 'gold'].includes(item.color) ? item.color : 'crimson',
        priority: Number(item.priority) || 0,
      });
    }
    return map.size ? map : new Map(DEFAULT_PLAYER_TITLES.map((item) => [item.steamId, item]));
  } catch {
    return new Map(DEFAULT_PLAYER_TITLES.map((item) => [item.steamId, item]));
  }
}

function saveTitles(list) {
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const steamId = String(item?.steamId || '').trim();
    const label = String(item?.label || '').trim();
    if (!/^\d{17}$/.test(steamId)) throw new HttpError(400, `SteamID「${steamId || '(空)'}」格式不正确`, 'INVALID_TITLE');
    if (!label) throw new HttpError(400, '称号名称不能为空', 'INVALID_TITLE');
    map.set(steamId, {
      id: String(item.id || label.toLowerCase().replace(/\s+/g, '-')).slice(0, 32),
      steamId,
      label: label.slice(0, 24),
      color: ['crimson', 'blue', 'gold'].includes(item.color) ? item.color : 'crimson',
      priority: Number(item.priority) || 0,
    });
  }
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const payload = [...map.values()].sort((a, b) => b.priority - a.priority);
  writeFileSync(TITLES_FILE, `${JSON.stringify({ titles: payload }, null, 2)}\n`);
  playerTitles = map;
  return payload;
}

function readJsonBody(req, { limit = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大', 'PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) { resolve({}); return; }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON', 'INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500 && !(error instanceof HttpError)) {
    console.error('[server] unexpected error:', error?.message || error);
  }
  sendJson(res, status, {
    error: status === 500 ? '服务器发生了意外错误，请稍后重试' : error.message,
    code: error.code || 'INTERNAL_ERROR',
  });
}

const rateBuckets = new Map();
function rateLimited(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.reset < now) {
    rateBuckets.set(ip, { count: 1, reset: now + 60_000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > 180;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { decoded = '/'; }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const noCache = ['.html', '.js', '.mjs', '.css'].includes(ext);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600',
      'Content-Length': data.length,
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end(); else res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>404</title><body style="background:#080b10;color:#e8eef6;font-family:sans-serif;padding:48px"><h1>404</h1><p>页面不存在。</p><a href="/" style="color:#67e8d5">返回首页</a>');
  }
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
}

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);
  const started = Date.now();
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';
  const postAllowed = method === 'POST' && (
    pathname === '/api/auth/logout'
    || pathname === '/api/admin/login'
    || pathname === '/api/admin/logout'
    || pathname === '/api/admin/password'
  );
  const putAllowed = method === 'PUT' && pathname === '/api/admin/titles';

  if (!['GET', 'HEAD'].includes(method) && !postAllowed && !putAllowed) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    if (pathname.startsWith('/api/')) {
      if (rateLimited(req)) {
        sendJson(res, 429, { error: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED' });
        return;
      }

      if (pathname === '/api/config') {
        sendJson(res, 200, {
          version: APP_VERSION,
          regions: REGIONS,
          hasServerKey: Boolean(SERVER_KEY),
          defaults: { region: 'cn', language: STORE_LANGUAGE },
        });
        return;
      }

      if (pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          version: APP_VERSION,
          serverKey: Boolean(SERVER_KEY),
          uptime: Math.round(process.uptime()),
          time: new Date().toISOString(),
        });
        return;
      }

      if (pathname === '/api/search') {
        const cc = String(url.searchParams.get('cc') || 'cn').toLowerCase();
        const query = url.searchParams.get('q') || '';
        if (!REGION_BY_CC.has(cc)) throw new HttpError(400, '未知的区服代码', 'INVALID_REGION');
        const result = await searchGames(query, cc);
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/featured') {
        const cc = String(url.searchParams.get('cc') || 'cn').toLowerCase();
        if (!REGION_BY_CC.has(cc)) throw new HttpError(400, '未知的区服代码', 'INVALID_REGION');
        const result = await getFeatured(cc);
        sendJson(res, 200, result);
        return;
      }

      const appMatch = pathname.match(/^\/api\/app\/(\d{1,8})$/);
      if (appMatch) {
        const appid = parseAppid(appMatch[1]);
        const cc = String(url.searchParams.get('cc') || 'cn').toLowerCase();
        if (!REGION_BY_CC.has(cc)) throw new HttpError(400, '未知的区服代码', 'INVALID_REGION');
        const game = await resolveAppInfo(appid, cc);
        sendJson(res, 200, game);
        return;
      }

      const priceMatch = pathname.match(/^\/api\/prices\/(\d{1,8})$/);
      if (priceMatch) {
        const appid = parseAppid(priceMatch[1]);
        const result = await getRegionPrices(appid);
        sendJson(res, 200, result);
        return;
      }

      const dlcMatch = pathname.match(/^\/api\/dlc\/(\d{1,8})$/);
      if (dlcMatch) {
        const appid = parseAppid(dlcMatch[1]);
        const cc = String(url.searchParams.get('cc') || 'cn').toLowerCase();
        if (!REGION_BY_CC.has(cc)) throw new HttpError(400, '未知的区服代码', 'INVALID_REGION');
        const result = await getDlcList(appid, cc, STORE_LANGUAGE);
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/profile') {
        const query = url.searchParams.get('id') || '';
        const profile = await getProfile(query, SERVER_KEY);
        sendJson(res, 200, profile);
        return;
      }

      if (pathname === '/api/auth/login') {
        const state = crypto.randomBytes(16).toString('hex');
        const origin = publicOrigin(req);
        // Steam 官方示例里的 return_to 是干净地址（不带查询串），这里保持一致，
        // 防 CSRF 的 state 放在 Cookie 里随回跳带回来。
        const returnTo = new URL('/api/auth/callback', origin);
        // openid.realm：SteamDB / ProtonDB / SteamGridDB 都会带，这里也带上本站地址。
        const realmSetting = String(loadEnvFile({ override: false }).STEAM_OPENID_REALM
          || process.env.STEAM_OPENID_REALM || 'on').trim().toLowerCase();
        const realm = realmSetting === 'off' ? '' : origin;
        authStates.set(state, { returnTo: returnTo.toString(), origin, createdAt: Date.now() });
        res.writeHead(302, {
          Location: buildOpenIdUrl(returnTo.toString(), realm),
          // The state travels in a cookie: it survives Steam rewriting the
          // return_to query string, and a SameSite=Lax cookie is still sent on
          // the top-level redirect back from Steam.
          'Set-Cookie': stateCookie(state, { secure: origin.startsWith('https://') }),
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }

      if (pathname === '/api/auth/callback') {
        const rawReturnTo = url.searchParams.get('openid.return_to') || '';
        // Steam echoes openid.return_to verbatim, but it may append its own
        // query string with `?` instead of `&`, or drop it entirely. Collect
        // every plausible spelling of our state and use the first one we
        // actually issued. The state cookie is the most reliable source.
        const stateCandidates = [];
        const cookieState = parseCookies(req)[STATE_COOKIE] || '';
        if (cookieState) stateCandidates.push(cookieState);
        const directState = url.searchParams.get('state') || '';
        if (directState) {
          stateCandidates.push(directState);
          const cut = directState.split('?')[0];
          if (cut && cut !== directState) stateCandidates.push(cut);
        }
        if (rawReturnTo) {
          try {
            const fromReturnTo = new URL(rawReturnTo).searchParams.get('state') || '';
            if (fromReturnTo) stateCandidates.push(fromReturnTo);
          } catch { /* malformed return_to */ }
        }
        let state = '';
        for (const candidate of stateCandidates) {
          if (authStates.has(candidate)) { state = candidate; break; }
        }
        if (!state) state = stateCandidates[0] || '';
        const pending = authStates.get(state);
        authStates.delete(state);
        const fail = (message, code) => {
          console.warn(`[auth] login failed: ${code || 'UNKNOWN'} — ${message}`);
          const target = new URL('/', publicOrigin(req));
          target.searchParams.set('auth', 'error');
          target.searchParams.set('reason', message);
          if (code) target.searchParams.set('code', code);
          res.writeHead(302, {
            Location: target.toString(),
            'Set-Cookie': stateCookie('', { clear: true, secure: publicOrigin(req).startsWith('https://') }),
            'Cache-Control': 'no-store',
          });
          res.end();
        };

        // Log exactly what Steam sent so a failing handshake can be diagnosed.
        console.log('[auth] openid callback', {
          mode: url.searchParams.get('openid.mode'),
          claimed_id: url.searchParams.get('openid.claimed_id'),
          identity: url.searchParams.get('openid.identity'),
          ns: url.searchParams.get('openid.ns'),
          return_to: rawReturnTo,
          signed: url.searchParams.get('openid.signed'),
          sig_length: (url.searchParams.get('openid.sig') || '').length,
          state_source: cookieState ? 'cookie' : (directState ? 'query' : 'none'),
          state_matched: Boolean(pending),
          state_candidates: stateCandidates.length,
        });
        // Steam 的错误回跳往往带额外参数，全部记下来便于定位
        const extraParams = [...url.searchParams.entries()]
          .filter(([name]) => name.startsWith('openid.') && !['openid.mode', 'openid.claimed_id',
            'openid.identity', 'openid.ns', 'openid.return_to', 'openid.signed', 'openid.sig',
            'openid.sig_alg', 'openid.op_endpoint'].includes(name));
        if (extraParams.length) {
          console.warn('[auth] Steam 附带的错误参数:', Object.fromEntries(extraParams));
        }

        if (!pending || Date.now() - pending.createdAt > AUTH_STATE_TTL_MS) {
          fail('登录请求已过期，请重新发起登录', 'OPENID_STATE_EXPIRED');
          return;
        }
        if (url.searchParams.get('openid.mode') !== 'id_res') {
          // Steam 只有在「回调域名已登记在 API Key 里」时才会走完握手并回传 id_res。
          // 否则它会回跳 openid.mode=error / cancel（有时带 openid.error 说明原因）。
          const origin = publicOrigin(req);
          const host = hostOf(origin);
          const callbackUrl = `${origin}/api/auth/callback`;
          const mode = url.searchParams.get('openid.mode') || 'unknown';
          const steamError = url.searchParams.get('openid.error') || '';
          const steamErrorText = url.searchParams.get('openid.error_description')
            || url.searchParams.get('openid.error_message') || '';
          const looksLikeClaimIdProblem = /claimed_id|identity/i.test(steamError);
          // Steam 只接受真正的域名，IP 和 localhost 都不行
          const isIpLike = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost' || host === '::1';
          const looksLikeDomain = !isIpLike
            && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host);
          const isHttps = origin.startsWith('https://');
          const hints = [];
          if (mode === 'error') {
            hints.push('Steam 拒绝了这次登录请求（openid.mode=error）');
          } else if (mode === 'cancel') {
            hints.push('这次登录在 Steam 上被取消或未通过授权');
          }
          if (looksLikeClaimIdProblem) {
            hints.push(`Steam 拒绝了身份校验（Invalid claimed_id or identity）：claimed_id 必须是 OpenID 2.0 的通用身份 http://specs.openid.net/auth/2.0/identifier_select（当前用的是 ${currentClaimedId()}）—— Steam 收到它才会弹账号选择并回传真实身份`);
          }
          if (!looksLikeDomain) {
            hints.push('Steam 不接受 IP 作为回调域名，请改用域名访问本站');
          }
          if (!isHttps) {
            hints.push('回调地址必须是 https，Steam 会拒绝 http 的回跳地址');
          }
          if (!looksLikeClaimIdProblem) {
            hints.push(`请到 steamcommunity.com/dev/apikey 把「${host}」登记到这个 API Key 的 Website / Domain 字段`);
          }
          if (!isHttps) {
            hints.push('如果浏览器里用的是 https 地址，请让反向代理转发 X-Forwarded-Proto: https，或设置 PUBLIC_ORIGIN=https://' + host);
          }
          const reason = steamError
            ? `Steam 的原始错误：${steamError}${steamErrorText ? `（${steamErrorText}）` : ''}`
            : '';
          fail(
            `Steam 没有完成 OpenID 握手：${hints.join('；')}。${reason}（当前回调地址 ${callbackUrl}）`,
            'OPENID_INVALID',
          );
          return;
        }
        if (!SERVER_KEY) {
          fail('服务端未配置 Steam Web API Key，无法校验登录', 'STEAM_KEY_MISSING');
          return;
        }

        const claimedId = url.searchParams.get('openid.claimed_id') || '';
        const identity = url.searchParams.get('openid.identity') || '';
        const returnTo = url.searchParams.get('openid.return_to') || '';
        // 按 SteamID 比对，http/https 两种写法都接受
        const claimedSteamId = steamIdFromIdentity(claimedId);
        const identitySteamId = steamIdFromIdentity(identity);
        if (!claimedSteamId || !identitySteamId || claimedSteamId !== identitySteamId) {
          console.warn('[auth] 身份校验失败:', { claimed_id: claimedId, identity });
          fail(
            `OpenID 身份校验失败（claimed_id=${claimedId || '空'}，identity=${identity || '空'}）`,
            'OPENID_INVALID',
          );
          return;
        }
        if (returnTo && !sameReturnTarget(returnTo, pending.returnTo)) {
          fail('OpenID 返回地址校验失败', 'OPENID_RETURN_MISMATCH');
          return;
        }
        try {
          verifyOpenIdSignature(url.searchParams, SERVER_KEY, req.url);
        } catch (error) {
          fail(error.message || 'OpenID 签名校验失败', error.code || 'OPENID_BAD_SIGNATURE');
          return;
        }

        const steamId = claimedSteamId;
        if (!/^\d{17}$/.test(steamId)) {
          fail('无法从 OpenID 响应中解析 SteamID', 'OPENID_INVALID');
          return;
        }

        let player = null;
        try {
          player = await fetchPlayerSummary(steamId, SERVER_KEY);
        } catch (error) {
          fail(error.message || '无法读取 Steam 账号信息', error.code || 'UPSTREAM_ERROR');
          return;
        }
        if (!player) {
          fail('Steam 未返回该账号的信息', 'OPENID_UNKNOWN_USER');
          return;
        }

        const token = createSession({
          steamId,
          personaName: player.personaname || 'Steam 玩家',
          realName: player.realname || null,
          avatar: player.avatarfull || player.avatarmedium || '',
          profileUrl: player.profileurl || `${COMMUNITY_ORIGIN}/profiles/${steamId}`,
          visibility: parseVisibility(null, player.communityvisibilitystate),
        });
        const target = new URL('/', publicOrigin(req));
        target.searchParams.set('auth', 'ok');
        res.writeHead(302, {
          Location: target.toString(),
          'Set-Cookie': [
            sessionCookie(token, { secure: target.origin.startsWith('https://') }),
            stateCookie('', { clear: true, secure: target.origin.startsWith('https://') }),
          ],
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }

      if (pathname === '/api/auth/debug') {
        const origin = publicOrigin(req);
        let hostname = origin;
        try { hostname = new URL(origin).hostname; } catch { /* keep raw */ }
        const isHttps = origin.startsWith('https://');
        const isIpLike = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname === 'localhost';
        const problems = [];
        if (!isHttps) {
          problems.push('回调地址不是 https：Steam 会拒绝 http 的回跳地址。反向代理需要转发 X-Forwarded-Proto: https，或给服务端设置 PUBLIC_ORIGIN=https://' + hostname);
        }
        if (isIpLike) {
          problems.push('当前是 IP / localhost：Steam 不接受 IP 作为回调域名，需要用域名访问本站');
        }
        problems.push(`请在 steamcommunity.com/dev/apikey 把「${hostname}」登记到这个 API Key 的 Website / Domain 字段`);
        sendJson(res, 200, {
          callbackOrigin: origin,
          callbackUrl: `${origin}/api/auth/callback`,
          hostname,
          https: isHttps,
          claimedId: currentClaimedId(),
          serverKey: Boolean(SERVER_KEY),
          serverKeyConfigured: Boolean(SERVER_KEY),
          publicOriginOverride: process.env.PUBLIC_ORIGIN || null,
          problems,
          hint: 'Steam 用「回调地址域名注册的 API Key」签名回跳。'
            + '请在 steamcommunity.com/dev/apikey 确认 Key 的 Website 域名与上面的 hostname 一致，'
            + '并通过该域名访问本站（反向代理时设置 PUBLIC_ORIGIN 或转发 x-forwarded-host / x-forwarded-proto）。',
        });
        return;
      }

      if (pathname === '/api/auth/session') {        const session = readSession(req);
        sendJson(res, 200, {
          authenticated: Boolean(session),
          user: session
            ? {
                steamId: session.steamId,
                personaName: session.personaName,
                realName: session.realName,
                avatar: session.avatar,
                profileUrl: session.profileUrl,
                visibility: session.visibility,
              }
            : null,
        });
        return;
      }

      if (pathname === '/api/auth/logout') {
        const session = readSession(req);
        if (session) authSessions.delete(session.token);
        res.setHeader('Set-Cookie', sessionCookie('', { clear: true }));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/auth/me') {
        const session = readSession(req);
        if (!session) throw new HttpError(401, '尚未登录 Steam 账号', 'NOT_AUTHENTICATED');
        const profile = await getProfile(session.steamId, SERVER_KEY);
        sendJson(res, 200, { ...profile, session: { steamId: session.steamId, personaName: session.personaName } });
        return;
      }

      if (pathname === '/api/admin/session') {
        const session = readAdminSession(req);
        sendJson(res, 200, { authenticated: Boolean(session), username: session?.username || null });
        return;
      }

      if (pathname === '/api/admin/login') {
        const ip = req.socket.remoteAddress || 'unknown';
        if (adminAttemptBlocked(ip)) {
          throw new HttpError(429, '登录尝试过多，请稍后再试', 'ADMIN_RATE_LIMITED');
        }
        const body = await readJsonBody(req);
        const ok = verifyAdminCredentials(body.username, body.password);
        noteAdminAttempt(ip, !ok);
        if (!ok) {
          console.warn(`[admin] 登录失败，来源 ${ip}`);
          throw new HttpError(401, '用户名或密码错误', 'ADMIN_BAD_CREDENTIALS');
        }
        const token = createAdminSession(String(body.username));
        res.setHeader('Set-Cookie', adminCookie(token));
        console.log(`[admin] ${body.username} 已登录，来源 ${ip}`);
        sendJson(res, 200, { ok: true, username: String(body.username) });
        return;
      }

      if (pathname === '/api/admin/password') {
        const session = requireAdmin(req);
        if (method !== 'POST') throw new HttpError(405, '仅支持 POST', 'METHOD_NOT_ALLOWED');
        const body = await readJsonBody(req);
        const result = changeAdminPassword(body.currentPassword ?? body.current, body.newPassword ?? body.new);
        // 改密后踢掉其它已登录的管理员会话（当前会话保留）
        for (const [token, value] of adminSessions) {
          if (token !== session.token) adminSessions.delete(token);
        }
        console.log(`[admin] ${result.username} 修改了登录密码`);
        sendJson(res, 200, { ok: true, username: result.username });
        return;
      }

      if (pathname === '/api/admin/logout') {
        const session = readAdminSession(req);
        if (session) adminSessions.delete(session.token);
        res.setHeader('Set-Cookie', adminCookie('', { clear: true }));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/admin/stats') {
        requireAdmin(req);
        sendJson(res, 200, {
          version: APP_VERSION,
          uptime: Math.round(process.uptime()),
          serverKey: Boolean(SERVER_KEY),
          serverKeyFingerprint: SERVER_KEY ? `****${SERVER_KEY.slice(-6).toUpperCase()}` : null,
          regions: REGIONS.length,
          cachedEntries: cache.size,
          pendingFetches: pendingFetches.size,
          steamSessions: authSessions.size,
          adminSessions: adminSessions.size,
          titles: playerTitles.size,
          node: process.version,
          platform: process.platform,
          startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
        });
        return;
      }

      if (pathname === '/api/admin/titles') {
        requireAdmin(req);
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          const saved = saveTitles(body.titles || body.list || []);
          sendJson(res, 200, { ok: true, titles: saved });
          return;
        }
        sendJson(res, 200, { titles: [...playerTitles.values()].sort((a, b) => b.priority - a.priority) });
        return;
      }

      throw new HttpError(404, 'API 路由不存在', 'NOT_FOUND');
    }

    await serveStatic(req, res, pathname);
  } catch (error) {
    if (pathname.startsWith('/api/')) {
      sendError(res, error);
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
    }
  } finally {
    if (pathname.startsWith('/api/')) {
      console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.listen(PORT, HOST, () => {
  playerTitles = loadTitles();
  ensureAdminCredential();
  watchStoredKey();
  const indexed = appIndex.load();
  console.log(`\n  Steam Atlas  http://${HOST}:${PORT}`);
  console.log(`  Regions ${REGIONS.length} · Server API key ${SERVER_KEY ? `configured (****${SERVER_KEY.slice(-6).toUpperCase()})` : 'not configured'} · v${APP_VERSION}`);
  console.log(`  Titles ${playerTitles.size} · Admin ${ADMIN_USERNAME} (change with ADMIN_USERNAME / ADMIN_PASSWORD)`);
  console.log(`  App index ${indexed} entries (next appid ${appIndex.next})\n`);
  startIndexScan();
});

/* ---------------------- 应用名称索引（下架游戏可搜索） ---------------------- */

// 商店搜索只收录仍在售的游戏。appindex 会扫描 Steam 的 App ID 空间，
// 把「App ID → 名称」存成索引，已下架但资料仍在的游戏就能被搜到。
const appIndex = new AppIndex();
let indexScanRunning = false;
let indexScanAbort = null;

async function startIndexScan() {
  if (indexScanRunning) return;
  if (String(process.env.STEAM_INDEX_SCAN || '1') === '0') return;
  indexScanRunning = true;
  indexScanAbort = new AbortController();
  console.log('[index] 后台扫描 App ID 空间（STEAM_INDEX_SCAN=0 可关闭）…');
  try {
    const result = await scanAppIndex({
      signal: indexScanAbort.signal,
      workers: 3,
      onProgress: ({ cursor, size }) => {
        if (cursor % 100000 === 0) console.log(`[index] 已扫到 App ID ${cursor}，索引 ${size} 条`);
      },
    });
    if (result.skipped) {
      console.log('[index] 其它进程正在扫描，稍后重试');
    } else {
      console.log(`[index] 扫描结束：新增 ${result.added}，索引共 ${result.count} 条`);
    }
    // 重新载入内存索引，让新收录的名字立刻可搜
    appIndex.load();
  } catch (error) {
    console.warn('[index] 扫描出错:', error?.message || error);
  } finally {
    indexScanRunning = false;
    // 被别的进程占用（或中断）时，过一会儿再接着扫。
    setTimeout(startIndexScan, 10 * 60 * 1000).unref();
  }
}

// 索引可能由命令行进程在写，定期重新载入内存里的那份。
setInterval(() => {
  try {
    const size = appIndex.load();
    if (size) console.log(`[index] 已重载索引：${size} 条`);
  } catch { /* ignore */ }
}, 5 * 60 * 1000).unref();

function shutdown(signal) {
  console.log(`\n${signal} received, closing server…`);
  try { indexScanAbort?.abort(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 4000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
