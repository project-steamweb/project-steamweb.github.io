// Steam Atlas 助手 — background service worker.
// 所有 Steam 请求都在这里发出：扩展的 host_permissions 让这些请求绕过
// 页面的 CORS 限制，Steam Web API Key 只保存在本机 chrome.storage.local，
// 不会发送给本站或任何第三方。

const WEB_API = 'https://api.steampowered.com';
const STORE_API = 'https://store.steampowered.com';

async function readSettings() {
  const stored = await chrome.storage.local.get(['steamApiKey', 'detectedSteamId']);
  return {
    apiKey: (stored.steamApiKey || '').trim(),
    detectedSteamId: stored.detectedSteamId || '',
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Steam 返回了 HTTP ${response.status}`);
  return response.json();
}

async function requireKey() {
  const { apiKey } = await readSettings();
  if (!apiKey) throw new Error('请先在「账号」标签填写自己的 Steam Web API Key');
  return apiKey;
}

// Steam 商店搜索返回的 price 形如 { currency: 'CNY', initial: 29800, final: 29800 }，
// 单位是分；少数情况下会直接返回数字。
function normalizePrice(price) {
  if (!price) return null;
  if (typeof price === 'number') return { currency: 'CNY', final: price / 100, initial: price / 100, discount: 0 };
  const final = Number(price.final);
  const initial = Number(price.initial ?? price.final);
  if (!Number.isFinite(final)) return null;
  return {
    currency: price.currency || 'CNY',
    final: final / 100,
    initial: Number.isFinite(initial) ? initial / 100 : final / 100,
    discount: Number(price.discount_percent) || 0,
  };
}

const handlers = {
  async search({ term }) {
    const query = String(term || '').trim();
    if (!query) return [];
    const url = `${STORE_API}/api/storesearch/?term=${encodeURIComponent(query)}&l=schinese&cc=CN`;
    const data = await fetchJson(url);
    return (data.items || []).slice(0, 15).map((item) => ({
      appid: item.id,
      name: item.name,
      // Steam returns price as { currency, initial, final } in cents.
      price: normalizePrice(item.price),
      metacritic: item.metascore || null,
      image: item.tiny_image || '',
    }));
  },

  async appdetails({ appid }) {
    const url = `${STORE_API}/api/appdetails?appids=${encodeURIComponent(appid)}&l=schinese&cc=CN`;
    const data = await fetchJson(url);
    const app = data?.[String(appid)];
    if (!app?.success) throw new Error('没有找到该游戏');
    const detail = app.data || {};
    return {
      appid: Number(appid),
      name: detail.name || '',
      header: detail.header_image || '',
      background: detail.background_raw || detail.background || '',
      description: detail.short_description || '',
      developers: detail.developers || [],
      metacritic: detail.metacritic?.score || null,
      price: detail.price_overview || null,
    };
  },

  async summary({ steamId }) {
    const key = await requireKey();
    const url = `${WEB_API}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamId)}`;
    const data = await fetchJson(url);
    const player = data?.response?.players?.[0];
    if (!player) throw new Error('Steam 没有返回该账号的资料');
    return player;
  },

  async resolve({ vanity }) {
    const key = await requireKey();
    const url = `${WEB_API}/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(key)}&vanityurl=${encodeURIComponent(vanity)}`;
    const data = await fetchJson(url);
    return data?.response?.steamid || null;
  },

  async owned({ steamId }) {
    const key = await requireKey();
    const url = `${WEB_API}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamId)}&include_appinfo=1&include_played_free_games=1`;
    const data = await fetchJson(url);
    const games = data?.response?.games || [];
    return {
      count: data?.response?.game_count ?? games.length,
      totalMinutes: games.reduce((sum, game) => sum + (game.playtime_forever || 0), 0),
      games: games
        .slice()
        .sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0))
        .slice(0, 30)
        .map((game) => ({
          appid: game.appid,
          name: game.name,
          minutes: game.playtime_forever || 0,
          hours: Math.round((game.playtime_forever || 0) / 6) / 10,
          header: `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/header.jpg`,
        })),
    };
  },

  async recent({ steamId }) {
    const key = await requireKey();
    const url = `${WEB_API}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamId)}&count=20`;
    const data = await fetchJson(url);
    return (data?.response?.games || []).map((game) => ({
      appid: game.appid,
      name: game.name,
      minutes: game.playtime_forever || 0,
      hours: Math.round((game.playtime_forever || 0) / 6) / 10,
      weeks: game.playtime_2_weeks || 0,
      header: `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/header.jpg`,
    }));
  },

  async level({ steamId }) {
    const key = await requireKey();
    const url = `${WEB_API}/IPlayerService/GetSteamLevel/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamId)}`;
    const data = await fetchJson(url);
    return data?.response?.player_level ?? null;
  },

  async bans({ steamId }) {
    const key = await requireKey();
    // GetPlayerBans uses the plural `steamids` parameter.
    const url = `${WEB_API}/ISteamUser/GetPlayerBans/v1/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamId)}`;
    const data = await fetchJson(url);
    return data?.players?.[0] || null;
  },

  async detected({ steamId }) {
    if (steamId) await chrome.storage.local.set({ detectedSteamId: steamId });
    const settings = await readSettings();
    return settings.detectedSteamId;
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: '未知的消息类型' });
    return false;
  }
  handler(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
