import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Optional .env support so `node server.mjs` is enough.
const envFile = path.join(__dirname, '.env');
if (existsSync(envFile)) {
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
    if (!(key in process.env)) process.env[key] = value;
  }
}

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

const SERVER_KEY = (process.env.STEAM_API_KEY || decryptStoredKey() || '').trim();
const APP_VERSION = '1.0.8';

// Site titles shown after the Steam persona name. Keys are SteamID64 strings.
// Add or remove entries here; the client only renders what the server returns.
const PLAYER_TITLES = new Map([
  ['76561199473775554', { id: 'owner', label: 'Owner', color: 'crimson', priority: 100 }],
]);

function titleFor(steamId) {
  const title = PLAYER_TITLES.get(String(steamId || ''));
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
const STORE_HEADERS = {
  'User-Agent': 'SteamAtlas/1.0 (+local data explorer; contact: local-user)',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Cookie: 'birthtime=628473600; lastagecheckage=1-January-1990; wants_mature_content=1; mature_content=1',
};
const TEXT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
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

async function fetchJson(url, { timeout = 12000, retries = 1, headers = STORE_HEADERS } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
      if (!response.ok) {
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
    dlc: (data.dlc || []).slice(0, 12).map((id) => ({ appid: Number(id) })),
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

async function getAppData(appid, cc, language = STORE_LANGUAGE, { timeout = 12000, retries = 1 } = {}) {
  const region = REGION_BY_CC.get(cc) || REGION_BY_CC.get('us');
  const key = `app:${appid}:${region.cc}:${language}`;
  return cached(key, 10 * 60 * 1000, async () => {
    const url = `${STORE_ORIGIN}/api/appdetails?appids=${encodeURIComponent(appid)}&cc=${region.cc}&l=${language}`;
    const json = await fetchJson(url, { timeout, retries });
    const result = json?.[String(appid)];
    if (!result || result.success !== true || !result.data) {
      throw new HttpError(404, '没有找到这款游戏，或该地区暂不提供', 'APP_NOT_FOUND');
    }
    return normalizeApp(appid, result.data, region);
  });
}

function parseAppid(value) {
  const appid = Number(value);
  if (!Number.isInteger(appid) || appid <= 0 || appid > 99999999) {
    throw new HttpError(400, 'App ID 格式不正确', 'INVALID_APPID');
  }
  return appid;
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
      daysSinceLastBan: Number(ban.DaysSinceLastBan) || 0,
      communityBanned: Boolean(ban.CommunityBanned),
      tradeBan: String(ban.EconomyBan || 'none') !== 'none',
      economyBan: ban.EconomyBan || 'none',
    } : null,
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

async function getProfile(rawInput, key) {
  const parsed = parseProfileInput(rawInput);
  let officialError = null;
  let steamId = parsed.steamId;

  if (key) {
    try {
      if (!steamId && parsed.vanity) steamId = await resolveVanity(parsed.vanity, key);
      return await getProfileFromWebApi(steamId, key);
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
    return publicProfile;
  } catch (publicError) {
    if (officialError) throw officialError;
    throw publicError;
  }
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

  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
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
        const game = await getAppData(appid, cc, STORE_LANGUAGE);
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

      if (pathname === '/api/profile') {
        const query = url.searchParams.get('id') || '';
        const profile = await getProfile(query, SERVER_KEY);
        sendJson(res, 200, profile);
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
  console.log(`\n  Steam Atlas  http://${HOST}:${PORT}`);
  console.log(`  Regions ${REGIONS.length} · Server API key ${SERVER_KEY ? 'configured' : 'not configured'} · v${APP_VERSION}\n`);
});

function shutdown(signal) {
  console.log(`\n${signal} received, closing server…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 4000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
