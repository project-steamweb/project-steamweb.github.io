/* =========================================================
   Steam Atlas — client application
   ========================================================= */
const view = document.querySelector('#view');
const breadcrumbEl = document.querySelector('#breadcrumb');
const lightbox = document.querySelector('#lightbox');
const lightboxImage = document.querySelector('#lightbox-image');
const lightboxCaption = document.querySelector('#lightbox-caption');
const regionPopover = document.querySelector('#region-popover');
const regionListEl = document.querySelector('#region-list');
const toastRegion = document.querySelector('#toast-region');
const sidebar = document.querySelector('#sidebar');
const sidebarScrim = document.querySelector('#sidebar-scrim');

const STORAGE = {
  region: 'steam-atlas:region',
  recentGames: 'steam-atlas:recent-games',
  recentProfiles: 'steam-atlas:recent-profiles',
};

const state = {
  config: null,
  regions: [],
  region: localStorage.getItem(STORAGE.region) || 'cn',
  serverKey: false,
  route: null,
  renderToken: 0,
  abortController: null,
  featured: null,
  featuredCache: new Map(),
  heroIndex: 0,
  trendingTab: 'topSellers',
  recentGames: readJson(STORAGE.recentGames, []),
  recentProfiles: readJson(STORAGE.recentProfiles, []),
  currentGame: null,
  currentProfile: null,
  session: null,
};

/* =========================================================
   Utilities
   ========================================================= */
function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be unavailable */ }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value), window.location.origin);
    if (url.protocol === 'https:' || url.protocol === 'http:') return escapeHtml(url.href);
  } catch { /* invalid URL */ }
  return '';
}

function icon(name, className = '') {
  return `<svg${className ? ` class="${className}"` : ''} aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function fallbackAvatar(name) {
  const letter = (String(name || 'S').trim()[0] || 'S').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#17332f"/><stop offset="1" stop-color="#0b1520"/></linearGradient></defs><rect width="240" height="240" fill="url(#g)"/><circle cx="120" cy="120" r="83" fill="none" stroke="#6ee7c8" stroke-opacity=".28"/><text x="120" y="145" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="84" font-weight="600" fill="#a8f5e2">${escapeHtml(letter)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

function prettyDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function prettyDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function hoursLabel(minutes) {
  const hours = (Number(minutes) || 0) / 60;
  if (hours < 0.1) return '不足 0.1 小时';
  return `${hours.toFixed(hours >= 10 ? 0 : 1)} 小时`;
}

function totalHours(value) {
  const hours = Number(value) || 0;
  return hours >= 100 ? `${Math.round(hours)} 小时` : `${hours.toFixed(1)} 小时`;
}

function currentRegion() {
  return state.regions.find((region) => region.cc === state.region) || state.regions[0] || {
    cc: 'cn', code: 'CN', name: '中国', currency: 'CNY', currencyName: '人民币',
  };
}

function regionByCc(cc) {
  return state.regions.find((region) => region.cc === cc) || null;
}

function regionPath(cc) {
  return state.regions.find((region) => region.cc === cc) || null;
}

function gamePath(appid, focus = '') {
  return `#/game/${appid}${focus ? `?focus=${focus}` : ''}`;
}

function searchPath(query) {
  return `#/search?q=${encodeURIComponent(query)}`;
}

function profilePath(query) {
  return `#/profile/${encodeURIComponent(query)}`;
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

async function api(path, { signal, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body != null) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(path, { headers, signal, method, body, credentials: 'same-origin' });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error('无法连接本地 Steam Atlas 服务，请确认服务正在运行。');
  }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const message = data?.error || `请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    error.code = data?.code || '';
    throw error;
  }
  return data;
}

function toast(message, type = 'success') {
  const element = document.createElement('div');
  element.className = `toast${type === 'error' ? ' error' : ''}`;
  element.innerHTML = `${icon(type === 'error' ? 'alert' : 'check')}<span>${escapeHtml(message)}</span>`;
  toastRegion.append(element);
  // 错误提示往往包含要照着做的操作，多留一会儿
  const life = type === 'error' ? 11000 : 3800;
  setTimeout(() => {
    element.classList.add('out');
    setTimeout(() => element.remove(), 220);
  }, life);
}

async function copyText(value) {
  const text = String(value || '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
      toast('已复制到剪贴板');
    } catch {
      toast('复制失败，请手动选择文本', 'error');
    } finally {
      area.remove();
    }
  }
}

function bindImageFallbacks(root = document) {
  root.querySelectorAll('img[data-fallback]').forEach((image) => {
    if (image.dataset.fallbackBound) return;
    image.dataset.fallbackBound = '1';
    image.addEventListener('error', () => {
      image.classList.add('is-broken');
    }, { once: true });
  });
}

function setView(html) {
  view.innerHTML = html;
  view.setAttribute('aria-busy', 'false');
  bindSearchForms(view);
  bindProfileForm(view);
  bindImageFallbacks(view);
}

function setBreadcrumb(parts) {
  breadcrumbEl.innerHTML = parts.map((part, index) => {
    const content = escapeHtml(part.label);
    const separator = index > 0 ? `<span class="sep">/</span>` : '';
    if (part.href && index < parts.length - 1) {
      return `${separator}<a href="${escapeHtml(part.href)}">${content}</a>`;
    }
    return `${separator}<span class="${index === parts.length - 1 ? 'current' : ''}">${content}</span>`;
  }).join('');
}

function updateActiveNav(name) {
  document.querySelectorAll('.nav-item[data-nav]').forEach((item) => {
    item.classList.toggle('active', item.dataset.nav === name);
  });
}

/* =========================================================
   Routing
   ========================================================= */
function parseRoute() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const params = new URLSearchParams(queryPart || '');
  const segments = pathPart.split('/').filter(Boolean);

  if (!segments.length) return { name: 'home' };

  if (segments[0] === 'game' && /^\d{1,8}$/.test(segments[1] || '')) {
    return { name: 'game', appid: Number(segments[1]), focus: params.get('focus') || '' };
  }
  if (segments[0] === 'prices') {
    if (/^\d{1,8}$/.test(segments[1] || '')) {
      return { name: 'game', appid: Number(segments[1]), focus: 'prices' };
    }
    return { name: 'prices' };
  }
  if (segments[0] === 'profile') {
    const query = decodeURIComponent(segments.slice(1).join('/') || '');
    return { name: 'profile', query: query || '' };
  }
  if (segments[0] === 'search') {
    return { name: 'search', query: params.get('q') || '' };
  }
  if (segments[0] === 'admin') {
    return { name: 'admin' };
  }
  return { name: 'notfound' };
}

async function renderRoute() {
  const token = ++state.renderToken;
  if (state.abortController) state.abortController.abort();
  const controller = new AbortController();
  state.abortController = controller;
  const route = parseRoute();
  state.route = route;

  closeSuggestPanels();
  closeRegionPopover();
  closeSidebar();

  switch (route.name) {
    case 'home':
      updateActiveNav('home');
      setBreadcrumb([{ label: '探索' }]);
      await renderHome(route, token, controller.signal);
      break;
    case 'game':
      updateActiveNav('');
      setBreadcrumb([{ label: '探索', href: '#/' }, { label: '游戏资料' }]);
      await renderGame(route, token, controller.signal);
      break;
    case 'search':
      updateActiveNav('');
      setBreadcrumb([{ label: '探索', href: '#/' }, { label: '搜索' }]);
      await renderSearch(route, token, controller.signal);
      break;
    case 'profile':
      updateActiveNav('profile');
      setBreadcrumb([{ label: '玩家档案', href: '#/profile' }, ...(route.query ? [{ label: '查询结果' }] : [])]);
      await renderProfile(route, token, controller.signal);
      break;
    case 'prices':
      updateActiveNav('prices');
      setBreadcrumb([{ label: '探索', href: '#/' }, { label: '全球区价' }]);
      await renderPricesLanding(token, controller.signal);
      break;
    case 'admin':
      updateActiveNav('');
      setBreadcrumb([{ label: '探索', href: '#/' }, { label: '管理后台' }]);
      await renderAdmin(token, controller.signal);
      break;
    default:
      updateActiveNav('');
      setBreadcrumb([{ label: '404' }]);
      setView(notFoundPage());
  }

  if (route.name !== 'game' || route.focus !== 'prices') {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}

/* =========================================================
   Shared UI blocks
   ========================================================= */
function heroCopy() {
  return `
    <div class="hero-copy">
      <span class="eyebrow">STEAM DATA EXPLORER</span>
      <h1>世界很大，<br>价格<span class="accent-line">不止一个</span>。</h1>
      <p class="hero-sub">从一个入口查询 <strong>Steam 游戏资料</strong>、<strong>全球 16 个区服的定价</strong>，以及玩家的公开档案。数据直连 Steam，无需登录。</p>
      <div class="hero-search">
        <form class="js-search-form" role="search" autocomplete="off">
          <div class="search-shell">
            ${icon('search')}
            <input name="q" type="search" placeholder="输入游戏名，或 Steam App ID…" aria-label="搜索 Steam 游戏">
            <button class="search-submit" type="submit" aria-label="搜索">${icon('arrow-right')}</button>
          </div>
          <div class="suggest-panel" hidden></div>
        </form>
        <div class="quick-searches">
          <span>试试</span>
          <button type="button" data-quick-search="艾尔登法环">艾尔登法环</button>
          <button type="button" data-quick-search="赛博朋克 2077">赛博朋克 2077</button>
          <button type="button" data-quick-search="哈迪斯 II">哈迪斯 II</button>
          <button type="button" data-quick-search="空洞骑士：丝之歌">丝之歌</button>
        </div>
      </div>
      <div class="hero-proof">
        <span>${icon('globe')}16 区服价格</span>
        <span>${icon('database')}Steam 公开数据</span>
        <span>${icon('key')}API Key 可选</span>
      </div>
    </div>`;
}

function featureStrip() {
  const features = [
    {
      index: '01 / GAME DATA',
      icon: 'gamepad',
      title: '游戏资料库',
      copy: '商店详情、截图、类型、发行日期与评价数据，一次读完。',
      href: searchPath('艾尔登法环'),
      label: '开始探索',
    },
    {
      index: '02 / REGIONAL PRICES',
      icon: 'globe',
      title: '全球区价',
      copy: '16 个区服的本地定价，统一折算人民币，横向比较一目了然。',
      href: '#/prices',
      label: '打开比价',
    },
    {
      index: '03 / PLAYER PROFILE',
      icon: 'user',
      title: '玩家档案',
      copy: 'SteamID、个性域名或主页链接，公开资料即刻呈现。',
      href: '#/profile',
      label: '查询玩家',
    },
  ];
  return `
    <section class="feature-strip" aria-label="核心功能">
      ${features.map((feature) => `
        <a class="feature-item" href="${feature.href}">
          <div class="feature-kicker"><span>${feature.index}</span>${icon(feature.icon)}</div>
          <h3>${feature.title}</h3>
          <p>${feature.copy}</p>
          <span class="arrow-link">${feature.label}${icon('arrow-up-right')}</span>
        </a>`).join('')}
    </section>`;
}

function priceText(price, isFree = false) {
  if (isFree || (price && Number(price.final) === 0)) return '免费';
  if (!price) return '暂未定价';
  return price.finalFormatted || '—';
}

function dlcPanel(data) {
  const items = data?.items || [];
  const total = Number(data?.total) || items.length;
  if (!items.length) {
    return `
      <section class="panel content-panel">
        <div class="panel-title-row"><h2>可下载内容</h2><span>DLC</span></div>
        <p class="dlc-empty">Steam 未公开该游戏的可下载内容列表（DLC 关系由发行商在商店后台配置，部分游戏不提供）。</p>
      </section>`;
  }
  return `
    <section class="panel content-panel">
      <div class="panel-title-row"><h2>可下载内容</h2><span>DLC · ${items.length}${total > items.length ? ` / ${total}` : ''}</span></div>
      <div class="dlc-list">
        ${items.map((item) => `
          <div class="dlc-row">
            ${safeUrl(item.header) ? `<img src="${safeUrl(item.header)}" alt="${escapeHtml(item.name)} 封面" loading="lazy" data-fallback>` : '<span class="dlc-thumb"></span>'}
            <span class="dlc-copy">
              <b>${escapeHtml(item.name)}</b>
              <small>${item.releaseDate ? escapeHtml(item.releaseDate) : '发售日期未知'}</small>
            </span>
            <span class="dlc-price">
              ${item.free
                ? '<span class="free">免费</span>'
                : `<b>${escapeHtml(priceText(item.price))}</b>${item.price?.discountPercent ? `<s>${escapeHtml(item.price.initialFormatted)}</s>` : ''}`}
            </span>
            <span class="dlc-actions">
              <a href="${gamePath(item.appid)}" title="查看该 DLC 的资料页">详情</a>
              <a href="${escapeHtml(item.storeUrl)}" target="_blank" rel="noopener noreferrer" title="在 Steam 商店打开">商店</a>
            </span>
          </div>`).join('')}
      </div>
    </section>`;
}

function dlcSkeleton() {
  return `
    <section class="panel content-panel">
      <div class="panel-title-row"><h2>可下载内容</h2><span>DLC</span></div>
      <div class="dlc-list">
        ${Array.from({ length: 3 }).map(() => `
          <div class="dlc-row"><span class="skeleton" style="width:72px;height:34px;border-radius:6px"></span>
          <span class="dlc-copy"><span class="skeleton sk-line" style="width:58%"></span><span class="skeleton sk-line" style="width:32%;height:8px"></span></span>
          <span class="skeleton sk-line" style="width:56px"></span></div>`).join('')}
      </div>
    </section>`;
}

function platformMarkup(platforms = {}) {
  const tags = [];
  if (platforms?.windows) tags.push('<span class="platform-mini">WIN</span>');
  if (platforms?.mac) tags.push('<span class="platform-mini">MAC</span>');
  if (platforms?.linux) tags.push('<span class="platform-mini">LNX</span>');
  return tags.length ? `<span class="platforms">${tags.join('')}</span>` : '';
}

function steamRunUrl(appid) {
  return `steam://run/${appid}`;
}

function steamStoreUrl(appid) {
  return `steam://store/${appid}`;
}

function gameCard(game, index, { rank = false } = {}) {
  const image = safeUrl(game.image || game.headerImage);
  const discount = Number(game.discountPercent || game.price?.discountPercent || 0);
  const free = game.isFree || game.price?.isFree || (game.price && Number(game.price.final) === 0);
  const initial = game.price?.initialFormatted;
  const showInitial = discount > 0 && initial && game.price?.initial > game.price?.final;
  const name = escapeHtml(game.name);
  return `
    <div class="game-card" style="--i:${index}">
      <div class="game-cover">
        ${image ? `<img src="${image}" alt="${name} 封面" loading="lazy">` : ''}
        <a class="card-hit" href="${gamePath(game.appid)}" aria-label="${name} 详情"></a>
        ${rank ? `<span class="rank-number">${String(index + 1).padStart(2, '0')}</span>` : ''}
        ${discount > 0 ? `<span class="discount-flag">−${discount}%</span>` : free ? '<span class="free-flag discount-flag">FREE</span>' : ''}
        <a class="card-launch" href="${steamRunUrl(game.appid)}" title="用 Steam 客户端启动 ${name}" aria-label="用 Steam 客户端启动 ${name}">${icon('gamepad')}</a>
      </div>
      <div class="game-card-body">
        <h3 class="game-card-title"><a href="${gamePath(game.appid)}">${name}</a></h3>
        <div class="game-card-meta">
          <span class="price-row">
            ${game.unlisted ? '<span class="unlisted-flag">已下架</span>' : free ? '<span class="free">免费游玩</span>' : `<b>${escapeHtml(priceText(game.price))}</b>${showInitial ? `<s>${escapeHtml(initial)}</s>` : ''}`}
          </span>
          ${game.metascore ? `<span class="metascore">${escapeHtml(game.metascore)}</span>` : platformMarkup(game.platforms)}
        </div>
      </div>
    </div>`;
}

function gameGrid(games, { rank = false, className = '' } = {}) {
  return `<div class="game-grid ${className}">${games.map((game, index) => gameCard(game, index, { rank })).join('')}</div>`;
}

function skeletonCards(count = 5) {
  return Array.from({ length: count }).map(() => `
    <div class="game-card">
      <div class="skeleton" style="aspect-ratio:460/215;border-radius:11px"></div>
      <div class="game-card-body"><div class="skeleton sk-line" style="width:75%"></div><div class="skeleton sk-line" style="width:35%;height:9px"></div></div>
    </div>`).join('');
}

function errorPanel(title, message, { retry = false } = {}) {
  return `
    <div class="panel error-panel">
      <div class="error-icon">${icon('alert')}</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="game-actions" style="justify-content:center">
        ${retry ? `<button class="button primary" type="button" data-action="reload">${icon('refresh')}重新加载</button>` : ''}
        <a class="button ghost" href="#/">${icon('arrow-left')}返回探索</a>
      </div>
    </div>`;
}

/* =========================================================
   Home
   ========================================================= */
function homeSkeleton() {
  return `
    <div class="page">
      <section class="hero">
        ${heroCopy()}
        <div class="hero-stage">
          <div class="skeleton" style="height:470px;border-radius:24px"></div>
        </div>
      </section>
      ${featureStrip()}
      <section class="trending-section">
        <div class="section-head">
          <div><span class="eyebrow">DISCOVER</span><h2>正在流行</h2></div>
        </div>
        <div class="game-grid">${skeletonCards(5)}</div>
      </section>
    </div>`;
}

function heroStage(featured) {
  const items = [...(featured?.topSellers || []), ...(featured?.newReleases || [])].slice(0, 4);
  const game = items[state.heroIndex % Math.max(items.length, 1)] || null;
  const region = currentRegion();
  if (!game) {
    return `
      <div class="hero-art">
        <div style="position:absolute;inset:0;background:radial-gradient(circle at 65% 30%, rgba(110,231,200,.17), transparent 45%),linear-gradient(140deg,#16242c,#0b1118)"></div>
        <div class="hero-art-top"><span class="hero-status"><span class="dot"></span>STEAM ATLAS</span><span class="hero-coordinate">REGION ${region.code}<br>LIVE DATA</span></div>
        <div class="hero-art-copy">
          <span class="eyebrow">START EXPLORING</span>
          <h2>选择一个世界，<br>查看它的价格。</h2>
          <div class="hero-art-bottom"><div class="hero-price"><b>16</b><small>REGIONS</small></div><a class="hero-enter" href="#/prices">打开比价 ${icon('arrow-right')}</a></div>
        </div>
      </div>`;
  }
  const image = safeUrl(game.headerImage || game.image);
  const discount = Number(game.discountPercent || game.price?.discountPercent || 0);
  const free = game.price?.isFree || (game.price && Number(game.price.final) === 0);
  return `
    <div class="hero-art">
      ${image ? `<img class="hero-bg" src="${image}" alt="${escapeHtml(game.name)}">` : ''}
      <div class="hero-art-top">
        <span class="hero-status"><span class="dot"></span>LIVE TOP SELLER</span>
        <span class="hero-coordinate">REGION ${region.code} · ${region.currency}<br>STEAM STORE DATA</span>
      </div>
      <div class="hero-art-copy">
        <span class="eyebrow">TOP SELLER / ${escapeHtml(game.appid)}</span>
        <h2>${escapeHtml(game.name)}</h2>
        <div class="hero-art-bottom">
          <div class="hero-price">
            <b>${escapeHtml(free ? '免费' : priceText(game.price))}</b>
            ${discount > 0 && game.price?.initialFormatted ? `<s>${escapeHtml(game.price.initialFormatted)}</s>` : ''}
            <small>${escapeHtml(region.code)} PRICE</small>
          </div>
          <a class="hero-enter" href="${gamePath(game.appid)}">查看资料 ${icon('arrow-up-right')}</a>
          <a class="hero-enter hero-launch" href="${steamRunUrl(game.appid)}" title="用 Steam 客户端启动 ${escapeHtml(game.name)}">启动 ${icon('gamepad')}</a>
        </div>
      </div>
    </div>
    <div class="hero-picks" aria-label="切换精选游戏">
      ${items.map((item, index) => `
        <button class="hero-pick ${index === state.heroIndex % items.length ? 'active' : ''}" type="button" data-hero-pick="${index}" aria-label="查看 ${escapeHtml(item.name)}">
          ${safeUrl(item.smallImage || item.image) ? `<img src="${safeUrl(item.smallImage || item.image)}" alt="" loading="lazy">` : ''}
          <span>${escapeHtml(item.name)}</span>
        </button>`).join('')}
    </div>`;
}

function homePage(featured) {
  const tabs = {
    topSellers: { label: '热销榜', items: featured.topSellers || [], rank: true },
    newReleases: { label: '新品', items: featured.newReleases || [], rank: false },
    specials: { label: '特惠', items: featured.specials || [], rank: false },
  };
  const active = tabs[state.trendingTab] || tabs.topSellers;
  return `
    <div class="page">
      <section class="hero">
        ${heroCopy()}
        <div class="hero-stage">${heroStage(featured)}</div>
      </section>
      ${featureStrip()}
      <section class="trending-section">
        <div class="section-head">
          <div>
            <span class="eyebrow">DISCOVER / ${escapeHtml(currentRegion().code)}</span>
            <h2>正在流行</h2>
            <p>来自 Steam ${escapeHtml(currentRegion().name)}区的实时榜单</p>
          </div>
          <div class="tab-switcher" role="tablist" aria-label="榜单类型">
            ${Object.entries(tabs).map(([key, tab]) => `<button type="button" role="tab" aria-selected="${key === state.trendingTab}" data-trending-tab="${key}" class="${key === state.trendingTab ? 'active' : ''}">${tab.label}</button>`).join('')}
          </div>
        </div>
        <div id="trending-grid">
          ${active.items.length ? gameGrid(active.items.slice(0, 10), { rank: active.rank }) : `<div class="empty-inline">这个榜单暂时没有数据。</div>`}
        </div>
      </section>
      ${pricePromo()}
    </div>`;
}

function pricePromo() {
  const region = currentRegion();
  const picks = state.regions.slice(0, 8);
  return `
    <section class="price-promo">
      <div class="price-promo-copy">
        <span class="eyebrow">REGIONAL PRICE INDEX</span>
        <h2>同一款游戏，<br>在不同区服值多少钱？</h2>
        <p>Steam Atlas 会同时读取 16 个区服的商店定价，并用公开汇率折算成人民币。低价不总是等于可买，但值得先看清楚。</p>
        <a class="button primary" href="#/prices">${icon('globe')}打开全球比价 ${icon('arrow-right')}</a>
      </div>
      <div class="region-mosaic" aria-label="覆盖区服">
        ${picks.map((item) => `
          <div class="region-tile ${item.cc === region.cc ? 'highlight' : ''}">
            <b>${escapeHtml(item.code)}</b>
            <span>${escapeHtml(item.currency)}</span>
          </div>`).join('')}
      </div>
    </section>`;
}

async function getFeatured(cc, signal) {
  const cached = state.featuredCache.get(cc);
  if (cached && cached.expires > Date.now()) return cached.value;
  const data = await api(`/api/featured?cc=${encodeURIComponent(cc)}`, { signal });
  state.featuredCache.set(cc, { value: data, expires: Date.now() + 5 * 60 * 1000 });
  return data;
}

async function renderHome(route, token, signal) {
  const region = currentRegion();
  const cached = state.featuredCache.get(region.cc);
  if (!cached || cached.expires <= Date.now()) setView(homeSkeleton());
  try {
    const featured = await getFeatured(region.cc, signal);
    if (token !== state.renderToken) return;
    state.featured = featured;
    setView(homePage(featured));
  } catch (error) {
    if (isAbortError(error) || token !== state.renderToken) return;
    setView(`
      <div class="page">
        <section class="hero">${heroCopy()}<div class="hero-stage">${heroStage(null)}</div></section>
        ${featureStrip()}
        ${errorPanel('榜单加载失败', error.message, { retry: true })}
      </div>`);
  }
}

/* =========================================================
   Search page
   ========================================================= */
function searchPage(data, query) {
  const results = data.results || [];
  return `
    <div class="page">
      <div class="page-head">
        <div>
          <span class="eyebrow">SEARCH / ${escapeHtml(currentRegion().code)}</span>
          <h1>搜索结果</h1>
          <p>${query ? `关于 “${escapeHtml(query)}” 的匹配结果。` : '输入游戏名称或 App ID 开始搜索。'} 价格来自 Steam ${escapeHtml(currentRegion().name)}区。标记「已下架」的结果来自 Steam 仍保留资料的已下架游戏。</p>
        </div>
        <div class="page-head-side"><b>${String(results.length).padStart(2, '0')}</b>TITLES FOUND</div>
      </div>
      ${results.length ? `
        <div class="search-summary">
          <h2><b>${escapeHtml(query)}</b> 的搜索结果</h2>
          <p>${escapeHtml(currentRegion().currency)} PRICING</p>
        </div>
        ${gameGrid(results, { className: 'search-grid' })}` : `
        <div style="margin-top:24px">
          <div class="empty-state">
            <div class="empty-icon">${icon('search')}</div>
            <h2>没有找到匹配的游戏</h2>
            <p>试试更短的关键词、英文原名，或直接输入 Steam App ID。也可以确认当前区服是否有该商品。</p>
            <a class="button primary" href="#/">${icon('arrow-left')}返回探索</a>
          </div>
        </div>`}
    </div>`;
}

async function renderSearch(route, token, signal) {
  const query = route.query.trim();
  if (!query) {
    setView(`
      <div class="page">
        <div class="empty-state">
          <div class="empty-icon">${icon('search')}</div>
          <h2>输入一个游戏名</h2>
          <p>支持中文名、英文名或 Steam App ID。</p>
          <a class="button primary" href="#/">去搜索</a>
        </div>
      </div>`);
    return;
  }
  setView(`<div class="page"><div class="skeleton sk-title"></div><div class="game-grid">${skeletonCards(5)}</div></div>`);
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}&cc=${encodeURIComponent(currentRegion().cc)}`, { signal });
    if (token !== state.renderToken) return;
    setView(searchPage(data, query));
    setBreadcrumb([{ label: '探索', href: '#/' }, { label: `搜索：${query}` }]);
  } catch (error) {
    if (isAbortError(error) || token !== state.renderToken) return;
    setView(`<div class="page">${errorPanel('搜索失败', error.message, { retry: true })}</div>`);
  }
}

/* =========================================================
   Game page
   ========================================================= */
function gameSkeleton() {
  return `
    <div class="page">
      <div class="skeleton" style="height:470px;border-radius:28px;margin-bottom:20px"></div>
      <div class="skeleton" style="height:360px;border-radius:20px"></div>
    </div>`;
}

function priceSkeleton() {
  return `
    <section class="panel price-board" id="price-board" aria-busy="true">
      <div class="price-board-head">
        <div><span class="skeleton sk-line" style="width:110px"></span><div class="skeleton sk-title" style="height:26px;width:220px"></div></div>
      </div>
      <div class="price-summary">${Array.from({ length: 4 }).map(() => '<div class="summary-cell"><div class="skeleton sk-line" style="width:50%"></div><div class="skeleton sk-line" style="height:22px;width:65%"></div></div>').join('')}</div>
      ${Array.from({ length: 5 }).map(() => '<div class="skeleton sk-line" style="height:30px"></div>').join('')}
    </section>`;
}

function gameSpotlight(app) {
  const region = app.region || currentRegion();
  const price = app.price;
  const free = app.isFree;
  const discount = Number(price?.discountPercent || 0);
  return `
    <aside class="spotlight">
      <div class="spotlight-head">
        <span class="spotlight-label">${escapeHtml(region.name.toUpperCase())} · ${escapeHtml(price?.currency || region.currency)}</span>
        ${discount > 0 ? `<span class="badge accent">−${discount}%</span>` : free ? `<span class="badge blue">FREE</span>` : ''}
      </div>
      <div class="spotlight-price">
        <b>${escapeHtml(free ? '免费' : priceText(price))}</b>
        ${!free && price ? `<span class="currency">${escapeHtml(price.currency)}</span>` : ''}
      </div>
      <div class="spotlight-sub">
        ${discount > 0 && price?.initialFormatted ? `<s>${escapeHtml(price.initialFormatted)}</s><span>当前折扣</span>` : '<span>当前区服商店定价</span>'}
      </div>
      <a class="button primary" href="${escapeHtml(app.storeUrl)}" target="_blank" rel="noopener noreferrer">${icon('external')}前往 Steam 商店</a>
      <a class="button ghost" href="${steamRunUrl(app.appid)}" style="width:100%;margin-top:7px;border-color:var(--line)" title="使用本机 Steam 客户端启动">${icon('gamepad')}用 Steam 客户端启动</a>
      <button class="button ghost" type="button" data-action="scroll-prices" style="width:100%;margin-top:7px;border-color:var(--line)">${icon('globe')}查看全球 16 区价格</button>
      <p class="spotlight-note">价格随 Steam 促销与地区政策变化，以商店结算页为准。</p>
      <div class="spotlight-divider"></div>
      <a class="spotlight-link" href="https://store.steampowered.com/app/${app.appid}/" target="_blank" rel="noopener noreferrer">
        <span>STORE PAGE · APP ${app.appid}</span>${icon('arrow-up-right')}
      </a>
      <a class="spotlight-link" href="${steamStoreUrl(app.appid)}" title="在 Steam 客户端中打开商店页">
        <span>客户端商店页</span>${icon('gamepad')}
      </a>
    </aside>`;
}

function requirementBlock(label, text) {
  if (!text) return '';
  return `
    <div class="requirement-block">
      <h4>${escapeHtml(label)}</h4>
      ${text.split('\n').map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        const bullet = trimmed.startsWith('•');
        return `<p class="${bullet ? 'req-line' : 'req-title'}">${escapeHtml(bullet ? trimmed.slice(1).trim() : trimmed)}</p>`;
      }).join('')}
    </div>`;
}

function availabilityBanner(app) {
  if (!app?.availability || app.availability === 'store') return '';
  const tone = app.availability === 'store-region' ? 'blue' : 'orange';
  const titles = {
    'store-region': '区服回退',
    webapi: 'Steam Web API',
    appinfo: 'Steam appinfo',
  };  return `
    <section class="availability-banner ${tone}">
      <div class="availability-head">
        <span class="availability-tag">${escapeHtml(titles[app.availability] || app.availability)}</span>
        <b>${escapeHtml(app.name)}</b>
      </div>
      <p>${escapeHtml(app.note || '该游戏未在当前区服的商店公开，以下为可获取到的资料。')}</p>
      ${app.fallbackRegion ? `<small>数据区服：${escapeHtml(app.fallbackRegion.name)} · ${escapeHtml(app.fallbackRegion.code)}</small>` : ''}
    </section>`;
}

function gameLinksPanel(app) {
  const links = Array.isArray(app.links) ? app.links : [];
  if (!links.length) return '';
  const groups = new Map();
  for (const link of links) {
    const key = link.platform || 'link';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(link);
  }
  return `
    <section class="panel content-panel">
      <div class="panel-title-row"><h2>相关链接</h2><span>LINKS · ${links.length}</span></div>
      <div class="link-cloud">
        ${links.map((link) => `
          <a class="link-chip" href="${safeUrl(link.url) || '#'}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(link.label || link.platform)}">
            ${icon('external')}<span>${escapeHtml(link.label || link.platform)}</span>
          </a>`).join('')}
      </div>
    </section>`;
}

function gamePage(app) {
  const region = currentRegion();
  const image = safeUrl(app.backgroundImage || app.headerImage);
  const short = app.shortDescription || '';
  const typeLabels = { game: '游戏', dlc: 'DLC', demo: 'Demo', mod: '模组', soundtrack: '原声带', video: '影片', series: '系列' };
  const fullgame = app.fullgame;
  const platforms = app.platforms || {};
  const platformLabels = [
    platforms.windows ? `<span class="platform-pill">${icon('monitor')}Windows</span>` : '',
    platforms.mac ? '<span class="platform-pill">macOS</span>' : '',
    platforms.linux ? '<span class="platform-pill">Linux</span>' : '',
  ].filter(Boolean).join('');
  const achievement = app.achievements;
  const requirements = app.platformRequirements || {};
  const requirementKeys = [
    { key: 'windows', label: 'Windows 最低配置' },
    { key: 'windowsRec', label: 'Windows 推荐配置' },
    { key: 'mac', label: 'macOS 最低配置' },
    { key: 'linux', label: 'Linux 最低配置' },
  ];
  const requirementTexts = {
    windows: requirements.windows,
    windowsRec: app.platformRequirementsRecommended?.windows,
    mac: requirements.mac,
    linux: requirements.linux,
  };
  const packageList = Array.isArray(app.packages) ? app.packages : [];
  return `
    <div class="page game-page">
      <div class="game-breadcrumb">
        <a href="#/">探索</a>${icon('chevron-right')}<a href="#/prices">全球区价</a>${icon('chevron-right')}<span>${escapeHtml(app.name)}</span>
      </div>
      <section class="game-hero">
        ${image ? `<img class="game-hero-bg" src="${image}" alt="" data-fallback>` : ''}
        <div class="game-hero-inner">
          <div class="game-hero-copy">
            ${fullgame?.appid ? `
            <a class="basegame-link" href="${gamePath(fullgame.appid)}" title="查看本体游戏 ${escapeHtml(fullgame.name || '')}">
              ${icon('arrow-left')}<span>《${escapeHtml(fullgame.name || `App ${fullgame.appid}`)}》的可下载内容</span>
            </a>` : ''}
            <div class="game-hero-badges">
              <span class="badge accent">${escapeHtml(typeLabels[app.type] || '游戏')}</span>
              ${app.comingSoon ? '<span class="badge orange">即将推出</span>' : app.releaseDate ? `<span class="badge">${escapeHtml(app.releaseDate)}</span>` : ''}
              ${app.metacritic?.score ? `<span class="badge blue">MC ${app.metacritic.score}</span>` : ''}
              ${app.requiredAge ? `<span class="badge red">${app.requiredAge}+</span>` : ''}
            </div>
            <h1 class="game-title">${escapeHtml(app.name)}</h1>
            ${short ? `<p class="game-short">${escapeHtml(short)}</p>` : ''}
            <div class="game-meta-row">
              ${app.developers?.length ? `<span>${icon('users')}<b>${escapeHtml(app.developers.join(' / '))}</b></span>` : ''}
              ${app.publishers?.length ? `<span>发行：${escapeHtml(app.publishers.join(' / '))}</span>` : ''}
              ${app.recommendations ? `<span>${icon('star')}${formatNumber(app.recommendations)} 条评价</span>` : ''}
              ${achievement?.total ? `<span>${icon('trophy')}${formatNumber(achievement.total)} 项成就</span>` : ''}
              ${platformLabels ? `<span>${platformLabels}</span>` : ''}
            </div>
            <div class="game-actions">
              <a class="button primary" href="${escapeHtml(app.storeUrl)}" target="_blank" rel="noopener noreferrer">${icon('external')}Steam 商店</a>
              <a class="button" href="${steamRunUrl(app.appid)}" title="使用本机 Steam 客户端启动《${escapeHtml(app.name)}》">${icon('gamepad')}启动游戏</a>
              <button class="button" type="button" data-copy="${escapeHtml(`${window.location.origin}/#/game/${app.appid}`)}">${icon('copy')}复制链接</button>
            </div>
          </div>
          ${gameSpotlight(app)}
        </div>
      </section>

      <div id="price-board-slot">${priceSkeleton()}</div>

      ${availabilityBanner(app)}

      <div class="game-layout">
        <div class="content-stack">
          <section class="panel content-panel">
            <div class="panel-title-row"><h2>关于这款游戏</h2><span>ABOUT</span></div>
            <p class="about-text clamped" id="about-text">${escapeHtml(app.about || short || '暂无简介。')}</p>
            <button class="about-toggle" type="button" data-action="toggle-about">展开完整简介</button>
            <div class="tag-list">
              ${(app.genres || []).map((genre) => `<span class="tag">${escapeHtml(genre)}</span>`).join('')}
              ${(app.categories || []).slice(0, 6).map((category) => `<span class="tag">${escapeHtml(category)}</span>`).join('')}
            </div>
          </section>

          ${gameLinksPanel(app)}

          ${app.screenshots?.length ? `
          <section class="panel content-panel">
            <div class="panel-title-row"><h2>画面</h2><span>${String(app.screenshots.length).padStart(2, '0')} SHOTS</span></div>
            <div class="gallery-grid">
              ${app.screenshots.slice(0, 7).map((shot, index) => `
                <button class="gallery-item" type="button" data-lightbox="${safeUrl(shot.full)}" data-caption="${escapeHtml(app.name)} · ${index + 1}">
                  <img src="${safeUrl(shot.thumbnail)}" alt="${escapeHtml(app.name)} 截图 ${index + 1}" loading="lazy">
                </button>`).join('')}
            </div>
          </section>` : ''}

          ${app.movies?.length ? `
          <section class="panel content-panel">
            <div class="panel-title-row"><h2>宣传片</h2><span>TRAILERS · ${app.movies.length}</span></div>
            <div class="movie-grid">
              ${app.movies.map((movie) => `
                <a class="movie-card" href="${safeUrl(movie.url)}" target="_blank" rel="noopener noreferrer">
                  <img src="${safeUrl(movie.thumbnail)}" alt="${escapeHtml(movie.name)}" loading="lazy" data-fallback>
                  <span class="movie-play">${icon('play')}</span>
                  <span class="movie-copy"><b>${escapeHtml(movie.name)}</b><small>在 Steam 商店播放</small></span>
                </a>`).join('')}
            </div>
          </section>` : ''}

          ${achievement?.total ? `
          <section class="panel content-panel">
            <div class="panel-title-row"><h2>成就</h2><span>ACHIEVEMENTS · ${formatNumber(achievement.total)}</span></div>
            ${achievement.highlighted?.length ? `
            <div class="achievement-grid">
              ${achievement.highlighted.map((item) => `
                <div class="achievement-card ${item.hidden ? 'is-hidden' : ''}">
                  ${safeUrl(item.icon) ? `<img src="${safeUrl(item.icon)}" alt="" loading="lazy" data-fallback>` : `<span class="achievement-placeholder">${icon('trophy')}</span>`}
                  <span><b>${escapeHtml(item.name)}</b><small>${item.hidden ? '隐藏成就' : escapeHtml(item.description || 'Steam 成就')}</small></span>
                </div>`).join('')}
            </div>` : ''}
            <p class="achievement-note">共 ${formatNumber(achievement.total)} 项成就，展示 Steam 首页推荐的部分成就。</p>
          </section>` : ''}

          ${app.dlc?.length ? `<div id="dlc-slot">${dlcSkeleton()}</div>` : ''}

          ${requirementKeys.some((item) => requirementTexts[item.key]) ? `
          <section class="panel content-panel">
            <div class="panel-title-row"><h2>配置要求</h2><span>REQUIREMENTS</span></div>
            <div class="requirement-grid">
              ${requirementKeys.map((item) => requirementBlock(item.label, requirementTexts[item.key])).join('')}
            </div>
          </section>` : ''}

          <section class="panel content-panel">
            <div class="panel-title-row"><h2>游戏信息</h2><span>DETAILS</span></div>
            <dl class="detail-list">
              <div class="detail-row"><dt>发行日期</dt><dd>${escapeHtml(app.releaseDate || '—')}</dd></div>
              <div class="detail-row"><dt>开发商</dt><dd>${escapeHtml(app.developers?.join(' / ') || '—')}</dd></div>
              <div class="detail-row"><dt>发行商</dt><dd>${escapeHtml(app.publishers?.join(' / ') || '—')}</dd></div>
              <div class="detail-row"><dt>类型</dt><dd>${escapeHtml(app.genres?.join(' / ') || '—')}</dd></div>
              <div class="detail-row"><dt>支持平台</dt><dd>${platformLabels || '—'}</dd></div>
              <div class="detail-row"><dt>控制器支持</dt><dd>${app.controllerSupport === 'full' ? '完整支持' : app.controllerSupport ? '部分支持' : '—'}</dd></div>
              <div class="detail-row"><dt>成就数量</dt><dd>${achievement?.total ? `${formatNumber(achievement.total)} 项` : '—'}</dd></div>
              <div class="detail-row"><dt>DLC 数量</dt><dd>${app.dlc?.length ? `${app.dlc.length} 个` : '—'}</dd></div>
              ${fullgame?.appid ? `<div class="detail-row"><dt>本体游戏</dt><dd><a class="arrow-link" href="${gamePath(fullgame.appid)}">${escapeHtml(fullgame.name || `App ${fullgame.appid}`)} ${icon('arrow-up-right')}</a></dd></div>` : ''}              <div class="detail-row"><dt>发行版本</dt><dd>${packageList.length ? packageList.map((item) => escapeHtml(item.text)).join('<br>') : '—'}</dd></div>
              <div class="detail-row"><dt>支持语言</dt><dd>${escapeHtml((app.languageList || []).join('、') || app.languages || '—')}</dd></div>
              <div class="detail-row"><dt>年龄分级</dt><dd>${app.requiredAge ? `${app.requiredAge}+` : '—'}${app.contentDescriptors?.length ? ` · ${escapeHtml(app.contentDescriptors.join(' / '))}` : ''}</dd></div>
              <div class="detail-row"><dt>Steam App ID</dt><dd class="mono">${app.appid}</dd></div>
              <div class="detail-row"><dt>官网</dt><dd>${app.website ? `<a class="arrow-link" href="${safeUrl(app.website)}" target="_blank" rel="noopener noreferrer">访问 ${icon('arrow-up-right')}</a>` : '—'}</dd></div>
              ${app.supportUrl ? `<div class="detail-row"><dt>客服支持</dt><dd><a class="arrow-link" href="${safeUrl(app.supportUrl)}" target="_blank" rel="noopener noreferrer">支持页面 ${icon('arrow-up-right')}</a></dd></div>` : ''}
            </dl>
          </section>

          ${app.ratings?.length || app.contentNotes || app.legalNotice ? `
          <section class="panel content-panel">
            <div class="panel-title-row"><h2>分级与版权</h2><span>RATINGS &amp; LEGAL</span></div>
            ${app.ratings?.length ? `
            <div class="rating-list">
              ${app.ratings.map((rating) => `
                <div class="rating-row">
                  <span class="rating-board">${escapeHtml(rating.board)}</span>
                  <b class="rating-value">${escapeHtml(rating.rating || '—')}</b>
                  <small>${rating.descriptors?.length ? escapeHtml(rating.descriptors.join(' · ')) : '无附加说明'}</small>
                </div>`).join('')}
            </div>` : ''}
            ${app.contentNotes ? `<p class="legal-text">内容提示：${escapeHtml(app.contentNotes)}</p>` : ''}
            ${app.legalNotice ? `<p class="legal-text">${escapeHtml(app.legalNotice)}</p>` : ''}
          </section>` : ''}
        </div>

        <aside class="side-stack">
          <section class="panel side-panel">
            <h3>AT A GLANCE</h3>
            <div class="metric-list">
              <div class="metric-row"><span>Steam 评价数</span><b>${app.recommendations ? formatNumber(app.recommendations) : '—'}</b></div>
              <div class="metric-row"><span>媒体评分</span><b>${app.metacritic?.score || '—'}</b></div>
              <div class="metric-row"><span>成就</span><b>${achievement?.total ? `${formatNumber(achievement.total)} 项` : '—'}</b></div>
              <div class="metric-row"><span>DLC</span><b>${app.dlc?.length ? `${app.dlc.length} 个` : '无'}</b></div>
              <div class="metric-row"><span>当前区服</span><b>${escapeHtml(region.name)}</b></div>
              <div class="metric-row"><span>商店计价</span><b>${escapeHtml(app.price?.currency || region.currency)}${app.price?.currency && app.price.currency !== region.currency ? ` <small style="color:var(--warn,#e8b457)">非本地货币</small>` : ''}</b></div>
              <div class="metric-row"><span>数据来源</span><b>Steam Store API</b></div>
            </div>
          </section>

          ${app.metacritic?.score ? `
          <section class="panel side-panel">
            <h3>METACRITIC</h3>
            <a class="metacritic-box" href="${safeUrl(app.metacritic.url) || '#'}" target="_blank" rel="noopener noreferrer">
              <span class="metacritic-score">${app.metacritic.score}</span>
              <span><b>Metacritic</b><small>媒体综合评分</small></span>
            </a>
          </section>` : ''}

          <section class="panel side-panel">
            <h3>PLATFORMS</h3>
            <div class="platforms-large">
              ${platformLabels || '<span class="platform-pill">未提供</span>'}
            </div>
            <div class="tag-list" style="margin-top:12px">
              ${(app.genres || []).slice(0, 4).map((genre) => `<span class="tag">${escapeHtml(genre)}</span>`).join('')}
            </div>
          </section>
        </aside>
      </div>
    </div>`;
}

function relativeLabel(row, china) {
  if (!row.cny || !china?.cny) return { text: '—', className: '' };
  if (row.cc === 'cn') return { text: '基准', className: '' };
  const diff = ((row.cny - china.cny) / china.cny) * 100;
  if (Math.abs(diff) < 0.5) return { text: '持平', className: '' };
  return {
    text: `${diff > 0 ? '+' : ''}${diff.toFixed(0)}%`,
    className: diff < 0 ? 'lower' : 'higher',
  };
}

function priceBoard(prices) {
  if (!prices?.rows?.length) {
    return `<section class="panel price-board" id="price-board">${errorPanel('价格加载失败', '暂时没有取得区服价格，请稍后再试。', { retry: true })}</section>`;
  }
  const china = prices.china;
  const sortedRows = [...prices.rows].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.cny == null && b.cny == null) return a.name.localeCompare(b.name, 'zh');
    if (a.cny == null) return 1;
    if (b.cny == null) return -1;
    return a.cny - b.cny;
  });
  const lowest = prices.rows.find((row) => row.cc === prices.lowestCc) || null;
  const highest = prices.rows.find((row) => row.cc === prices.highestCc) || null;
  const maxCny = Math.max(...sortedRows.map((row) => Number(row.cny) || 0), 1);
  const fetchedTime = new Date(prices.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const rateTime = prices.rates?.updatedAt ? prettyDate(prices.rates.updatedAt) : '暂时不可用';

  return `
    <section class="panel price-board" id="price-board">
      <div class="price-board-head">
        <div class="price-board-title">
          <span class="eyebrow">REGIONAL PRICING</span>
          <h2>全球 16 区价格</h2>
          <p>按约合人民币从低到高排列 · ${prices.availableCount} / 16 个区服可获取 · 抓取于 ${escapeHtml(fetchedTime)}</p>
        </div>
        <div class="price-board-actions">
          <span class="badge ${prices.rates?.available ? 'accent' : 'orange'}">${prices.rates?.available ? '汇率已同步' : '仅本地定价'}</span>
          <a class="button small ghost" href="https://store.steampowered.com/app/${prices.appid}/" target="_blank" rel="noopener noreferrer">${icon('external')}Steam</a>
        </div>
      </div>
      <div class="price-summary">
        <div class="summary-cell accent">
          <div class="label">${icon('tag')}最低估价</div>
          <div class="value">${escapeHtml(lowest?.cnyFormatted || '—')}<small>${escapeHtml(lowest?.code || '')}</small></div>
          <div class="caption">${lowest ? `${escapeHtml(lowest.name)} · ${escapeHtml(priceText(lowest.price, lowest.isFree))}` : '暂无可用价格'}</div>
        </div>
        <div class="summary-cell">
          <div class="label">${icon('pin')}中国区</div>
          <div class="value">${escapeHtml(china?.cnyFormatted || '—')}<small>CNY</small></div>
          <div class="caption">${china?.available ? `本地定价 ${escapeHtml(priceText(china.price, china.isFree))}` : '该区暂不可用'}</div>
        </div>
        <div class="summary-cell">
          <div class="label">${icon('arrow-up-right')}最高估价</div>
          <div class="value">${escapeHtml(highest?.cnyFormatted || '—')}<small>${escapeHtml(highest?.code || '')}</small></div>
          <div class="caption">${highest ? `${escapeHtml(highest.name)} · ${escapeHtml(priceText(highest.price, highest.isFree))}` : '暂无可用价格'}</div>
        </div>
        <div class="summary-cell">
          <div class="label">${icon('layers')}区域价差</div>
          <div class="value">${prices.spreadPercent == null ? '—' : `${prices.spreadPercent}%`}<small>SPREAD</small></div>
          <div class="caption">最高价较最低价的估算差幅</div>
        </div>
      </div>

      <div style="overflow-x:auto">
        <table class="price-table">
          <thead><tr><th>区服</th><th>本地定价</th><th>约合人民币</th><th>相对国区</th><th>折扣</th><th style="text-align:right">商店</th></tr></thead>
          <tbody>
            ${sortedRows.map((row) => {
              const isLowest = row.cc === prices.lowestCc;
              const relative = relativeLabel(row, china);
              const bar = row.cny != null ? Math.max(2, Math.round((row.cny / maxCny) * 100)) : 0;
              return `
                <tr class="${isLowest ? 'lowest' : ''} ${row.cc === 'cn' ? 'china' : ''}">
                  <td>
                    <div class="region-cell">
                      <span class="region-code sm">${escapeHtml(row.code)}</span>
                      <span class="region-name">
                        <b>${escapeHtml(row.name)}${isLowest ? '<span class="lowest-tag">LOWEST</span>' : ''}${row.cc === 'cn' ? '<span class="china-tag">国区</span>' : ''}</b>
                        <small>${escapeHtml(row.currency)} · ${escapeHtml(row.currencyName)}${row.currencyMismatch ? `<span class="currency-flag" title="Steam 在该区以 ${escapeHtml(row.storeCurrency)} 计价">商店以 ${escapeHtml(row.storeCurrency)} 计价</span>` : ''}</small>
                      </span>
                    </div>
                  </td>
                  <td><span class="local-price ${row.isFree ? 'free' : ''}">${escapeHtml(row.available ? priceText(row.price, row.isFree) : '—')}</span></td>
                  <td>
                    <div class="cny-cell">
                      <span class="cny-value">${escapeHtml(row.cnyFormatted || '—')}<span class="est">估算</span></span>
                      <div class="cny-bar"><i style="width:${bar}%"></i></div>
                    </div>
                  </td>
                  <td><span class="relative ${relative.className}">${relative.text}</span></td>
                  <td><span class="discount-cell ${row.price?.discountPercent > 0 ? 'on' : ''}">${row.price?.discountPercent > 0 ? `−${row.price.discountPercent}%` : '—'}</span></td>
                  <td>
                    <a class="table-shop" href="https://store.steampowered.com/app/${prices.appid}/?cc=${encodeURIComponent(row.cc)}" target="_blank" rel="noopener noreferrer">打开 ${icon('arrow-up-right')}</a>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="price-foot">
        <p>${escapeHtml(prices.disclaimer)} 同一款游戏在不同区服可能使用不同发行版本或存在锁区限制。</p>
        <div class="rates"><b>RATE SOURCE · ${escapeHtml(prices.rates?.source || 'UNAVAILABLE')}</b>${escapeHtml(rateTime)}${prices.rates?.available ? '' : ' · 未取得汇率，人民币估算已隐藏'}</div>
      </div>
    </section>`;
}

async function loadGamePrices(appid, token, signal, focusPrices) {
  const slot = document.querySelector('#price-board-slot');
  if (!slot) return;
  try {
    const prices = await api(`/api/prices/${appid}`, { signal });
    if (token !== state.renderToken) return;
    slot.innerHTML = priceBoard(prices);
    bindImageFallbacks(slot);
    if (focusPrices) {
      setTimeout(() => {
        const board = document.querySelector('#price-board');
        if (board) {
          const top = board.getBoundingClientRect().top + window.scrollY - 84;
          window.scrollTo({ top, behavior: 'smooth' });
        }
      }, 80);
    }
  } catch (error) {
    if (isAbortError(error) || token !== state.renderToken) return;
    slot.innerHTML = `<section class="panel price-board" id="price-board">${errorPanel('区价加载失败', error.message, { retry: true })}</section>`;
  }
}

function addRecentGame(app) {
  const item = {
    appid: app.appid,
    name: app.name,
    image: app.headerImage || app.capsuleImage || '',
  };
  state.recentGames = [item, ...state.recentGames.filter((entry) => entry.appid !== app.appid)].slice(0, 4);
  writeJson(STORAGE.recentGames, state.recentGames);
  renderRecentGames();
}

function renderRecentGames() {
  const section = document.querySelector('#recent-section');
  const list = document.querySelector('#recent-list');
  if (!section || !list) return;
  const games = state.recentGames.slice(0, 4);
  section.hidden = games.length === 0;
  list.innerHTML = games.map((game) => `
    <a class="recent-item" href="${gamePath(game.appid)}">
      ${safeUrl(game.image) ? `<img class="recent-thumb" src="${safeUrl(game.image)}" alt="" loading="lazy">` : '<span class="recent-thumb"></span>'}
      <span>${escapeHtml(game.name)}</span>
    </a>`).join('');
}

async function renderGame(route, token, signal) {
  setView(gameSkeleton());
  const pricePromise = api(`/api/prices/${route.appid}`, { signal }).then(
    (prices) => ({ prices, error: null }),
    (error) => ({ prices: null, error }),
  );
  const dlcPromise = api(`/api/dlc/${route.appid}?cc=${encodeURIComponent(currentRegion().cc)}`, { signal }).then(
    (dlc) => ({ dlc, error: null }),
    (error) => ({ dlc: null, error }),
  );
  try {
    const app = await api(`/api/app/${route.appid}?cc=${encodeURIComponent(currentRegion().cc)}`, { signal });
    if (token !== state.renderToken) return;
    state.currentGame = app;
    setView(gamePage(app));
    setBreadcrumb([{ label: '探索', href: '#/' }, { label: '游戏', href: '#/prices' }, { label: app.name }]);
    addRecentGame(app);
    if (route.focus === 'prices') {
      setTimeout(() => {
        const board = document.querySelector('#price-board');
        if (board) window.scrollTo({ top: board.getBoundingClientRect().top + window.scrollY - 84, behavior: 'auto' });
      }, 40);
    }
    // The price request runs in parallel with app details; surface it when ready.
    pricePromise.then(({ prices, error }) => {      if (token !== state.renderToken) return;
      const slot = document.querySelector('#price-board-slot');
      if (!slot) return;
      if (error) {
        if (isAbortError(error)) return;
        slot.innerHTML = `<section class="panel price-board" id="price-board">${errorPanel('区价加载失败', error.message, { retry: true })}</section>`;
        return;
      }
      slot.innerHTML = priceBoard(prices);
      bindImageFallbacks(slot);
      if (route.focus === 'prices') {
        setTimeout(() => {
          const board = document.querySelector('#price-board');
          if (board) window.scrollTo({ top: board.getBoundingClientRect().top + window.scrollY - 84, behavior: 'smooth' });
        }, 80);
      }
    });
    // DLC names and prices resolve in the background so the page stays fast.
    dlcPromise.then(({ dlc, error }) => {
      if (token !== state.renderToken) return;
      const slot = document.querySelector('#dlc-slot');
      if (!slot) return;
      if (error) {
        if (isAbortError(error)) return;
        slot.innerHTML = `
          <section class="panel content-panel">
            <div class="panel-title-row"><h2>可下载内容</h2><span>DLC</span></div>
            <p class="dlc-empty">DLC 列表加载失败：${escapeHtml(error.message)}</p>
          </section>`;
        return;
      }
      slot.innerHTML = dlcPanel(dlc);
      bindImageFallbacks(slot);
    });
  } catch (error) {
    if (isAbortError(error) || token !== state.renderToken) return;
    setView(`
      <div class="page">
        <div class="game-breadcrumb"><a href="#/">探索</a>${icon('chevron-right')}<span>未知游戏</span></div>
        ${errorPanel('没有找到这款游戏', error.message, { retry: true })}
      </div>`);
  }
}

/* =========================================================
   Profile
   ========================================================= */
function profileLandingPage() {
  const recent = state.recentProfiles.slice(0, 4);
  return `
    <div class="page profile-landing">
      <section class="profile-landing-hero">
        <span class="eyebrow">STEAM PLAYER LOOKUP</span>
        <h1>认识屏幕<br>另一端的玩家。</h1>
        <p>输入 SteamID64、个性域名或主页链接。公开档案无需 Key 即可读取；配置 Web API Key 后，还能解锁等级、封禁明细与最近游戏。Steam 不支持按昵称搜索。</p>
        <form class="profile-search" id="profile-lookup-form">
          <div class="search-shell">
            ${icon('user')}
            <input name="id" type="text" placeholder="SteamID64 / 个性域名 / 主页链接" aria-label="输入 Steam 玩家标识" spellcheck="false" autocomplete="off">
          </div>
          <button class="button primary" type="submit">查询档案 ${icon('arrow-right')}</button>
        </form>
        <div class="profile-examples">
          <span>示例</span>
          <button type="button" data-profile-query="gabe">gabe</button>
          <button type="button" data-profile-query="76561197960384218">SteamID64</button>
          <button type="button" data-profile-query="https://steamcommunity.com/id/gabe/">主页链接</button>
        </div>
      </section>
      <div class="profile-feature-grid">
        <div class="panel profile-feature">${icon('user')}<h3>公开档案读取</h3><p>头像、昵称、状态、地区、加入时间与群组信息，无需登录。</p></div>
        <div class="panel profile-feature">${icon('shield')}<h3>官方 API 增强</h3><p>接入 Web API Key 后查看 Steam 等级、VAC 封禁与最近游戏记录。</p></div>
        <div class="panel profile-feature">${icon('lock')}<h3>不触碰账号</h3><p>不需要 Steam 用户名或密码，也不会发起任何交易或登录授权。</p></div>
      </div>
      ${recent.length ? `
      <section style="margin-top:26px">
        <div class="section-head"><div><span class="eyebrow">RECENT PROFILES</span><h2>最近查询</h2></div><button class="section-link" type="button" data-clear-profiles>清除记录 ${icon('close')}</button></div>
        <div class="profile-recent-grid">
          ${recent.map((profile) => `
            <a class="panel profile-recent-card" href="${profilePath(profile.query)}">
              <img src="${safeUrl(profile.avatar) || fallbackAvatar(profile.name)}" alt="">
              <span><b>${escapeHtml(profile.name)}</b><small>${escapeHtml(profile.steamId || profile.query)}</small></span>
              ${icon('chevron-right')}
            </a>`).join('')}
        </div>
      </section>` : ''}
    </div>`;
}

function profileSkeleton() {
  return `
    <div class="page">
      <div class="skeleton" style="height:290px;border-radius:28px;margin-bottom:18px"></div>
      <div style="display:grid;grid-template-columns:1fr 330px;gap:18px">
        <div class="skeleton" style="height:240px;border-radius:20px"></div>
        <div class="skeleton" style="height:240px;border-radius:20px"></div>
      </div>
    </div>`;
}

function visibilityText(profile) {
  return profile.visibilityLabel || ({ public: '公开', friends: '仅好友', private: '私密' })[profile.visibility] || '未知';
}

const PRIVACY_TEXT = {
  public: { label: '公开', hint: 'Steam 公开显示' },
  friends: { label: '仅好友可见', hint: '受 Steam 隐私设置限制' },
  private: { label: '私密', hint: '受 Steam 隐私设置限制' },
};

function privacyBadge(state) {
  const meta = PRIVACY_TEXT[state] || PRIVACY_TEXT.private;
  const tone = state === 'public' ? 'ok' : state === 'friends' ? 'friend' : 'locked';
  return `<span class="privacy-badge ${tone}">${state === 'public' ? icon('eye') : icon('lock')}${escapeHtml(meta.label)}</span>`;
}

function privacyRow(label, state, fallback = '—') {
  const meta = PRIVACY_TEXT[state] || PRIVACY_TEXT.private;
  return `
    <div class="privacy-row ${state === 'public' ? 'is-public' : 'is-hidden'}">
      <span>${escapeHtml(label)}</span>
      ${state === 'public' ? `<b>${escapeHtml(fallback)}</b>` : `<small>${escapeHtml(meta.hint)}</small>`}
      ${privacyBadge(state)}
    </div>`;
}

function profileBanState(profile) {
  const bans = profile.bans;
  if (bans) {
    // 游戏封禁（Game Ban）独立于 VAC 封禁，Steam 用单独字段统计
    const gameBans = Number(bans.numberOfGameBans) || 0;
    const any = bans.vacBanned || bans.communityBanned || bans.tradeBan || gameBans > 0;
    return {
      any,
      title: any ? '存在封禁或限制记录' : '未发现封禁记录',
      details: [
        bans.vacBanned ? `VAC 封禁 ${bans.numberOfVacBans || 1} 次` : 'VAC 正常',
        gameBans > 0 ? `游戏封禁 ${gameBans} 次` : '游戏封禁正常',
        bans.communityBanned ? '社区封禁' : '社区正常',
        bans.tradeBan ? '交易封禁' : '交易正常',
      ].join(' · '),
    };
  }
  if (profile.vacBanned) {
    return { any: true, title: '公开档案显示 VAC 封禁', details: '完整封禁明细需要 Steam Web API Key。' };
  }
  if (profile.tradeBanState && profile.tradeBanState !== 'None') {
    return { any: true, title: '交易状态受限', details: `交易封禁状态：${profile.tradeBanState}` };
  }
  return { any: false, title: '公开资料未显示封禁', details: 'VAC 与交易状态正常，配置 Key 可查看完整明细。' };
}

function profileValveNotice() {
  return `
    <div class="valve-notice">
      <div class="valve-notice-head">${icon('alert')}<b>Valve 员工防诈骗提醒</b></div>
      <p>Valve 员工永远不会使用任何聊天系统（包括 Steam 聊天和 Discord）就您的帐户与您沟通。您与 Steam 客服人员谈论有关自己帐户事宜的唯一方式就是通过 Steam 客服站点。无论在什么情况下，您都无需直接联系 Valve 或 Steam 员工来解决问题。</p>
      <p class="valve-notice-link"><a href="https://help.steampowered.com/zh-cn/faqs/view/70E6-991B-233B-A37B" target="_blank" rel="noopener noreferrer">Steam欺诈常见问题</a></p>
    </div>`;
}

function profilePage(profile) {
  const avatar = safeUrl(profile.avatar) || fallbackAvatar(profile.personaName);
  const avatarMedium = safeUrl(profile.avatarMedium) || avatar;
  const statusTone = profile.statusTone || (['online', 'in-game'].includes(profile.status) ? 'online' : 'offline');
  const memberSince = profile.memberSince ? prettyDate(profile.memberSince) : prettyDate(profile.createdAt);
  const recentHours = profile.source === 'webapi'
    ? totalHours(profile.hoursPlayed2Wk)
    : (profile.hoursPlayed2Wk ? `${Number(profile.hoursPlayed2Wk).toFixed(1)} 小时` : '—');
  const banState = profileBanState(profile);
  const sourceLabel = profile.apiUsed ? '官方 Web API' : '公开档案';
  const recentGames = Array.isArray(profile.recentGames) ? profile.recentGames : [];
  const library = profile.library;
  const libraryGames = Array.isArray(library?.top) ? library.top : [];
  const customUrl = profile.customUrl ? `https://steamcommunity.com/id/${encodeURIComponent(profile.customUrl)}` : '';
  const visibility = visibilityText(profile);
  const privacy = profile.privacy || {};
  const hiddenCount = Object.values(privacy).filter((state) => state && state !== 'public').length;
  const levelXp = profile.levelXp;
  const nextLevelXp = Number(profile.nextLevelXp) || 0;
  const levelProgress = levelXp != null && nextLevelXp > 0 ? Math.min(100, Math.max(2, Math.round((levelXp / (levelXp + nextLevelXp)) * 100))) : 0;
  const gamesHidden = privacy.games && privacy.games !== 'public';

  return `
    <div class="page">
      <div class="game-breadcrumb">
        <a href="#/">探索</a>${icon('chevron-right')}<a href="#/profile">玩家档案</a>${icon('chevron-right')}<span>${escapeHtml(profile.personaName)}</span>
      </div>
      ${profile.isValveEmployee ? profileValveNotice() : ''}
      <section class="profile-hero">
        <div class="profile-banner"><img src="${avatarMedium}" alt="" data-fallback></div>
        <div class="profile-hero-inner">
          <div class="profile-avatar-wrap">
            <img class="profile-avatar" src="${avatar}" alt="${escapeHtml(profile.personaName)} 的头像" data-fallback>
            <span class="profile-online ${statusTone}"></span>
          </div>
          <div class="profile-main">
            <div class="profile-name-row">
              <h1 class="profile-name">${escapeHtml(profile.personaName)}</h1>
              ${profile.isValveEmployee ? '<span class="player-title valve" title="Valve 员工称号">Valve员工</span>' : ''}
              ${profile.title?.label ? `<span class="player-title ${escapeHtml(profile.title.color || 'crimson')}" title="${escapeHtml(profile.title.label)} 称号">${escapeHtml(profile.title.label)}</span>` : ''}
              <span class="badge ${profile.apiUsed ? 'accent' : 'blue'}">${sourceLabel}</span>
              <span class="badge ${visibility === '公开' ? '' : 'orange'}">${escapeHtml(visibility)}</span>
              ${banState.any ? '<span class="badge red">受限</span>' : ''}
            </div>
            ${profile.realName ? `<p class="profile-realname">${escapeHtml(profile.realName)}</p>` : ''}
            <div class="profile-status-row">
              <span class="dot ${statusTone}"></span>
              <span>${escapeHtml(profile.statusLabel || '未知状态')}</span>
              ${profile.stateMessage && profile.stateMessage !== 'Offline' ? `<span>· ${escapeHtml(profile.stateMessage)}</span>` : ''}
              ${profile.customUrl ? `<span class="profile-handle">/id/${escapeHtml(profile.customUrl)}</span>` : ''}
            </div>
          </div>
          <div class="profile-hero-actions">
            <a class="button" href="${safeUrl(profile.profileUrl) || '#'}" target="_blank" rel="noopener noreferrer">${icon('external')}Steam 主页</a>
            <button class="button ghost" type="button" data-copy="${escapeHtml(profile.steamId)}">${icon('copy')}复制 SteamID</button>
          </div>
        </div>
        <div class="profile-stats">
          <div class="profile-stat"><div class="label">STEAM LEVEL</div><div class="value">${profile.level != null ? profile.level : '—'} ${profile.level == null ? '<small>未公开</small>' : ''}</div></div>
          <div class="profile-stat"><div class="label">游戏库</div><div class="value">${profile.libraryCount != null ? formatNumber(profile.libraryCount) + ' <small>款</small>' : gamesHidden ? '<small>私密</small>' : '—'}</div></div>
          <div class="profile-stat"><div class="label">总游戏时长</div><div class="value">${profile.totalPlaytimeMinutes != null ? formatNumber(Math.round(profile.totalPlaytimeMinutes / 60)) + ' <small>小时</small>' : gamesHidden ? '<small>私密</small>' : '—'}</div></div>
          <div class="profile-stat"><div class="label">两周游戏时长</div><div class="value">${escapeHtml(recentHours)}</div></div>
          <div class="profile-stat"><div class="label">加入 STEAM</div><div class="value">${escapeHtml(memberSince || '—')}</div></div>
          <div class="profile-stat"><div class="label">地区</div><div class="value" style="font-size:14px">${escapeHtml(profile.location || profile.country || '未公开')}</div></div>
        </div>
        ${levelXp != null || profile.badgeCount ? `
        <div class="profile-levelbar">
          <span class="levelbar-label">LEVEL ${profile.level ?? '—'}</span>
          <span class="levelbar-track"><i style="width:${levelProgress}%"></i></span>
          <span class="levelbar-meta">${levelXp != null ? `${formatNumber(levelXp)} XP` : ''}${nextLevelXp ? ` · 距升级还需 ${formatNumber(nextLevelXp)} XP` : ''}${profile.badgeCount ? ` · ${profile.badgeCount} 枚徽章` : ''}</span>
        </div>` : ''}
      </section>

      <div class="profile-layout">
        <div class="profile-content">
          ${profile.warning ? `<div class="profile-note warning">${icon('alert')}<span>${escapeHtml(profile.warning)}</span></div>` : ''}
          ${profile.visibility !== 'public' ? `<div class="profile-note">${icon('eye')}<span>该玩家的档案可见性为「${escapeHtml(visibility)}」。部分或全部资料无法公开读取，最近游戏与群组信息可能缺失。</span></div>` : ''}
          ${hiddenCount ? `
          <section class="panel content-panel privacy-panel">
            <div class="panel-title-row"><h2>隐私设置</h2><span>PRIVACY · ${hiddenCount} 项受限</span></div>
            <div class="privacy-list-rows">
              ${privacyRow('个人资料页', privacy.profile, visibility)}
              ${privacyRow('个人资料详情', privacy.details, '官方 API 可读')}
              ${privacyRow('游戏库 / 拥有的游戏', privacy.games, profile.libraryCount != null ? `${formatNumber(profile.libraryCount)} 款` : '可读')}
              ${privacyRow('游戏时长记录', privacy.playtime, profile.totalPlaytimeMinutes != null ? `${formatNumber(Math.round(profile.totalPlaytimeMinutes / 60))} 小时` : '可读')}
              ${privacyRow('真实姓名', privacy.realName, profile.realName || '未填写')}
              ${privacyRow('地区与位置', privacy.location, profile.location || profile.country || '未填写')}
              ${privacyRow('最近在线时间', privacy.lastOnline, profile.lastLogoff ? prettyDateTime(profile.lastLogoff) : '—')}
              ${privacyRow('公开群组', privacy.groups, `${profile.groupCount || 0} 个`)}
            </div>
            <p class="privacy-note">${icon('info')}<span>标为「私密 / 仅好友可见」的项目由该玩家在 Steam 隐私设置中关闭，任何第三方网站都无法读取，只能显示为受限。</span></p>
          </section>` : ''}
          ${profile.headline || profile.summary ? `
          <section class="panel content-panel">
            <div class="panel-title-row"><h2>个人简介</h2><span>PROFILE</span></div>
            ${profile.headline ? `<p class="profile-realname" style="margin:0 0 8px;color:var(--text)">${escapeHtml(profile.headline)}</p>` : ''}
            <p class="about-text" style="margin:0">${escapeHtml(profile.summary || '')}</p>
          </section>` : ''}

          ${profile.apiUsed ? `
          ${libraryGames.length ? `
          <section class="panel content-panel">
            <div class="panel-title-row"><h2>游戏库 · 时长排行</h2><span>LIBRARY · TOP ${libraryGames.length}</span></div>
            <div class="library-list">
              ${libraryGames.map((game, index) => `
                <a class="library-row" href="${gamePath(game.appid)}">
                  <span class="library-rank">${String(index + 1).padStart(2, '0')}</span>
                  <img src="${safeUrl(game.header) || fallbackAvatar(game.name)}" alt="" loading="lazy" data-fallback>
                  <span class="library-copy"><b>${escapeHtml(game.name)}</b><small>${formatNumber(game.hours)} 小时</small></span>
                  <span class="library-bar" aria-hidden="true"><i style="width:${Math.max(4, Math.round((game.hours / Math.max(libraryGames[0]?.hours || 1, 1)) * 100))}%"></i></span>
                </a>`).join('')}
            </div>
          </section>` : gamesHidden ? `
          <section class="panel content-panel">
            <div class="panel-title-row"><h2>游戏库</h2><span>LIBRARY · PRIVATE</span></div>
            <div class="privacy-locked">${icon('lock')}<div><b>该玩家的游戏详情为私密</b><small>Steam 不允许第三方读取其拥有的游戏、时长与最近游玩记录。可在 Steam 隐私设置 →「游戏详情」中改为公开后重新查询。</small></div></div>
          </section>` : ''}
          <section class="panel content-panel">
            <div class="panel-title-row"><h2>最近在玩</h2><span>RECENT · 2 WEEKS</span></div>
            ${recentGames.length ? `
              <div class="recent-games">
                ${recentGames.map((game) => `
                  <a class="recent-game" href="${gamePath(game.appid)}">
                    <img src="${safeUrl(game.header) || safeUrl(game.icon) || fallbackAvatar(game.name)}" alt="" loading="lazy" data-fallback>
                    <span class="recent-game-copy">
                      <b>${escapeHtml(game.name)}</b>
                      <small>${game.playtime2Weeks ? `近两周 ${hoursLabel(game.playtime2Weeks)}` : `共 ${hoursLabel(game.playtimeForever)}`}</small>
                    </span>
                  </a>`).join('')}
              </div>` : '<div class="empty-inline privacy-inline">' + icon('lock') + (gamesHidden ? '该玩家的游戏详情为私密，无法读取最近游玩记录。' : '最近两周没有公开的游玩记录。') + '</div>'}
          </section>
          ${profile.bans ? `
          <section class="panel content-panel">
            <div class="panel-title-row"><h2>封禁记录</h2><span>ACCOUNT STANDING</span></div>
            <div class="metric-list">
              <div class="metric-row"><span>VAC 封禁</span><b>${profile.bans.vacBanned ? `有记录（${profile.bans.numberOfVacBans || 1} 次）` : '无'}</b></div>
              <div class="metric-row"><span>游戏封禁</span><b>${profile.bans.numberOfGameBans > 0 ? `有记录（${profile.bans.numberOfGameBans} 次）` : '无'}</b></div>
              <div class="metric-row"><span>社区封禁</span><b>${profile.bans.communityBanned ? '有记录' : '无'}</b></div>
              <div class="metric-row"><span>交易封禁</span><b>${profile.bans.tradeBan ? escapeHtml(profile.bans.economyBan || '受限') : '无'}</b></div>
              <div class="metric-row"><span>距上次封禁</span><b>${profile.bans.daysSinceLastBan ? `${formatNumber(profile.bans.daysSinceLastBan)} 天` : '无记录'}</b></div>
            </div>
            <div class="profile-note" style="margin-top:16px">${icon('info')}<span>数据来自 Steam 官方 ISteamUser/GetPlayerBans 接口。游戏封禁（Game Ban）是独立于 VAC 的封禁类型，只有该接口能读到。</span></div>
          </section>` : ''}` : `
          <section class="panel content-panel">
            <div class="panel-title-row"><h2>公开资料概览</h2><span>PUBLIC DATA</span></div>
            <div class="metric-list">
              <div class="metric-row"><span>个人资料可见性</span><b>${escapeHtml(visibility)}</b></div>
              <div class="metric-row"><span>加入 Steam</span><b>${escapeHtml(memberSince || '—')}</b></div>
              <div class="metric-row"><span>公开群组数量</span><b>${profile.groupCount || 0}</b></div>
              <div class="metric-row"><span>两周公开时长</span><b>${recentHours}</b></div>
              <div class="metric-row"><span>VAC 封禁</span><b>${profile.bans ? (profile.bans.vacBanned ? `有记录（${profile.bans.numberOfVacBans || 1} 次）` : '无') : (profile.vacBanned ? '有记录' : '无公开记录')}</b></div>
              <div class="metric-row"><span>游戏封禁</span><b>${profile.bans ? (profile.bans.numberOfGameBans > 0 ? `有记录（${profile.bans.numberOfGameBans} 次）` : '无') : '无公开记录'}</b></div>
              <div class="metric-row"><span>社区封禁</span><b>${profile.bans ? (profile.bans.communityBanned ? '有记录' : '无') : '无公开记录'}</b></div>
              <div class="metric-row"><span>交易封禁</span><b>${profile.bans ? (profile.bans.tradeBan ? escapeHtml(profile.bans.economyBan || '受限') : '无') : escapeHtml(profile.tradeBanState || '无公开记录')}</b></div>
              ${profile.bans?.daysSinceLastBan ? `<div class="metric-row"><span>距上次封禁</span><b>${formatNumber(profile.bans.daysSinceLastBan)} 天</b></div>` : ''}
              <div class="metric-row"><span>受限账户</span><b>${profile.limitedAccount ? '是' : '否'}</b></div>
            </div>
            <div class="profile-note" style="margin-top:16px">${icon('info')}<span>Steam 公开档案 XML 不包含等级、封禁明细与完整游戏记录。配置 Web API Key 后，同一页面会自动升级为官方 API 数据。</span></div>
          </section>`}
        </div>

        <aside class="profile-side">
          <section class="panel side-panel">
            <h3>IDENTITY</h3>
            <div class="identity-list">
              <div class="identity-row"><span>SteamID64</span><b>${escapeHtml(profile.steamId)} <button class="copy-button" type="button" data-copy="${escapeHtml(profile.steamId)}" aria-label="复制 SteamID">${icon('copy')}</button></b></div>
              <div class="identity-row"><span>个性域名</span><b>${profile.customUrl ? `<a href="${safeUrl(customUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(profile.customUrl)}</a>` : '—'}</b></div>
              <div class="identity-row"><span>账号状态</span><b>${escapeHtml(profile.statusLabel || '—')}</b></div>
              ${profile.gameName ? `<div class="identity-row"><span>当前游戏</span><b>${escapeHtml(profile.gameName)}</b></div>` : ''}
              <div class="identity-row"><span>档案可见性</span><b>${escapeHtml(visibility)} ${privacyBadge(privacy.profile)}</b></div>
              <div class="identity-row"><span>Steam 等级</span><b>${profile.level != null ? profile.level : '—'} ${levelXp != null ? `<small>${formatNumber(levelXp)} XP</small>` : ''}</b></div>
              ${profile.badgeCount ? `<div class="identity-row"><span>徽章</span><b>${formatNumber(profile.badgeCount)} 枚 · 合计 ${formatNumber(profile.badgeLevel || 0)} 级</b></div>` : ''}
              <div class="identity-row"><span>游戏库</span><b>${profile.libraryCount != null ? `${formatNumber(profile.libraryCount)} 款` : privacyBadge(privacy.games)}</b></div>
              <div class="identity-row"><span>数据来源</span><b>${escapeHtml(sourceLabel)}</b></div>
              <div class="identity-row"><span>公开群组</span><b>${profile.groupCount || 0} 个 ${privacyBadge(privacy.groups)}</b></div>
              <div class="identity-row"><span>加入时间</span><b>${escapeHtml(memberSince || '—')}</b></div>
              <div class="identity-row"><span>地区</span><b>${escapeHtml(profile.location || profile.country || '—')} ${privacyBadge(privacy.location)}</b></div>
              ${profile.lastLogoff ? `<div class="identity-row"><span>最近在线</span><b>${escapeHtml(prettyDateTime(profile.lastLogoff))}</b></div>` : `<div class="identity-row"><span>最近在线</span><b>${privacyBadge(privacy.lastOnline)}</b></div>`}
              <div class="identity-row"><span>受限账户</span><b>${profile.limitedAccount ? '是' : '否'}</b></div>
            </div>
          </section>

          <section class="panel side-panel">
            <h3>ACCOUNT STANDING</h3>
            <div class="ban-card ${banState.any ? 'banned' : ''}">
              ${icon(banState.any ? 'alert' : 'shield')}
              <div><b>${escapeHtml(banState.title)}</b><small>${escapeHtml(banState.details)}</small></div>
            </div>
          </section>

          ${profile.primaryGroup ? `
          <section class="panel side-panel">
            <h3>PRIMARY GROUP</h3>
            <a class="group-card" href="https://steamcommunity.com/groups/${encodeURIComponent(profile.primaryGroup.url || '')}" target="_blank" rel="noopener noreferrer">
              <img src="${safeUrl(profile.primaryGroup.avatar) || fallbackAvatar(profile.primaryGroup.name)}" alt="" loading="lazy">
              <span><b>${escapeHtml(profile.primaryGroup.name || 'Steam 群组')}</b><small>${profile.primaryGroup.members ? `${formatNumber(profile.primaryGroup.members)} 位成员` : 'Steam 群组'}</small></span>
            </a>
          </section>` : ''}

          ${!profile.apiUsed ? `
          <div class="upgrade-card">
            <span class="eyebrow">LIMITED DATA</span>
            <h3>官方数据未完全公开</h3>
            <p>服务器已启用 Steam 官方 Web API；该玩家的等级、游戏库或封禁明细受 Steam 隐私设置限制，公开档案中不会显示。</p>
          </div>` : `
          <div class="panel side-panel">
            <h3>DATA SOURCE</h3>
            <div class="profile-note" style="margin:0;border-color:var(--line);background:rgba(255,255,255,.02)">${icon('shield')}<span>本页由 Steam 官方 Web API 提供增强数据；API Key 由本机服务加密保存，不会发送到浏览器。</span></div>
          </div>`}
        </aside>
      </div>
    </div>`;
}

function addRecentProfile(profile, query) {
  const item = {
    steamId: profile.steamId,
    name: profile.personaName,
    avatar: profile.avatar,
    query: profile.customUrl || profile.steamId || query,
  };
  state.recentProfiles = [item, ...state.recentProfiles.filter((entry) => entry.steamId !== profile.steamId)].slice(0, 4);
  writeJson(STORAGE.recentProfiles, state.recentProfiles);
}

function profileNotFound(query) {
  return `
    <div class="page">
      <div class="game-breadcrumb"><a href="#/">探索</a>${icon('chevron-right')}<a href="#/profile">玩家档案</a>${icon('chevron-right')}<span>未找到</span></div>
      <div class="empty-state">
        <div class="empty-icon">${icon('user')}</div>
        <h2>没有找到这个玩家</h2>
        <p>请检查 SteamID64（17 位数字）、个性域名或主页链接是否正确。私密档案也可能无法通过公开接口读取。</p>
        <a class="button primary" href="#/profile">${icon('arrow-left')}重新查询</a>
      </div>
    </div>`;
}

async function renderProfile(route, token, signal) {
  if (!route.query) {
    setView(profileLandingPage());
    return;
  }
  setView(profileSkeleton());
  try {
    const profile = await api(`/api/profile?id=${encodeURIComponent(route.query)}`, { signal });
    if (token !== state.renderToken) return;
    state.currentProfile = profile;
    setView(profilePage(profile));
    setBreadcrumb([{ label: '玩家档案', href: '#/profile' }, { label: profile.personaName }]);
    addRecentProfile(profile, route.query);
  } catch (error) {
    if (isAbortError(error) || token !== state.renderToken) return;
    if (error.status === 404) {
      setView(profileNotFound(route.query));
    } else {
      setView(`
        <div class="page">
          <div class="game-breadcrumb"><a href="#/">探索</a>${icon('chevron-right')}<a href="#/profile">玩家档案</a>${icon('chevron-right')}<span>查询失败</span></div>
          ${errorPanel('玩家档案加载失败', error.message, { retry: true })}
        </div>`);
    }
  }
}

/* =========================================================
   Price landing
   ========================================================= */
function pricesLandingPage(featured) {
  const region = currentRegion();
  const top = featured?.topSellers?.slice(0, 8) || [];
  return `
    <div class="page prices-landing">
      <section class="prices-hero">
        <div>
          <span class="eyebrow">GLOBAL PRICE INDEX</span>
          <h1>一眼看穿<br>各区定价。</h1>
          <p>同时读取 Steam 商店在 16 个区服的本地定价，按公开汇率折算成人民币。先看价格，再决定去哪个世界。</p>
          <form class="js-search-form" role="search" autocomplete="off" style="position:relative;z-index:3">
            <div class="search-shell">
              ${icon('search')}
              <input name="q" type="search" placeholder="搜索要对比的游戏，或输入 App ID…" aria-label="搜索要对比的游戏">
              <button class="search-submit" type="submit" aria-label="搜索">${icon('arrow-right')}</button>
            </div>
            <div class="suggest-panel" hidden></div>
          </form>
        </div>
        <div class="orbit-visual" aria-hidden="true">
          <div class="orbit-ring"></div><div class="orbit-ring"></div>
          <div class="orbit-core"><div><b>16</b><span>REGIONS</span></div></div>
          <span class="orbit-chip">CN</span><span class="orbit-chip">US</span><span class="orbit-chip">AR</span><span class="orbit-chip">TR</span><span class="orbit-chip">EU</span>
        </div>
      </section>

      <section class="region-section">
        <div class="section-head">
          <div><span class="eyebrow">COVERAGE</span><h2>覆盖区服</h2><p>当前定价参考区服：${escapeHtml(region.name)} · ${escapeHtml(region.currency)}</p></div>
          <a class="section-link" href="#/game/1245620?focus=prices">看一个例子 ${icon('arrow-up-right')}</a>
        </div>
        <div class="region-grid-large">
          ${state.regions.map((item) => `
            <button class="region-card ${item.cc === region.cc ? 'current' : ''}" type="button" data-region-option="${item.cc}" style="text-align:left;cursor:pointer;color:inherit">
              <span class="region-code">${escapeHtml(item.code)}</span>
              <span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.currency)} · ${escapeHtml(item.currencyName)}${item.currencyMismatch ? ` · 商店以 ${escapeHtml(item.storeCurrency)} 计价` : ''}</small></span>
            </button>`).join('')}
        </div>
      </section>

      <section class="region-section" id="quick-picks">
        <div class="section-head">
          <div><span class="eyebrow">QUICK START</span><h2>从热销游戏开始</h2><p>选择一款游戏，查看它的 16 区价格明细</p></div>
          <a class="section-link" href="#/">回探索页 ${icon('arrow-right')}</a>
        </div>
        ${top.length ? gameGrid(top, { className: 'search-grid' }) : `<div class="game-grid">${skeletonCards(4)}</div>`}
      </section>

      <div class="prices-how">
        <div class="how-step"><span class="num">STEP 01</span><h3>搜索一款游戏</h3><p>使用中文名、英文名或 Steam App ID，匹配 Steam 商店当前区服的商品。</p></div>
        <div class="how-step"><span class="num">STEP 02</span><h3>读取 16 个区服</h3><p>分别请求 Steam 商店的地区定价，保留本地货币金额与折扣信息。</p></div>
        <div class="how-step"><span class="num">STEP 03</span><h3>统一折算比较</h3><p>用公开汇率估算人民币价格并排序，同时标注国区基准与区域价差。</p></div>
      </div>
    </div>`;
}

async function renderPricesLanding(token, signal) {
  setView(pricesLandingPage(null));
  try {
    const featured = await getFeatured(currentRegion().cc, signal);
    if (token !== state.renderToken) return;
    const target = document.querySelector('#quick-picks');
    if (target) {
      const top = featured.topSellers?.slice(0, 8) || [];
      target.innerHTML = `
        <div class="section-head">
          <div><span class="eyebrow">QUICK START</span><h2>从热销游戏开始</h2><p>选择一款游戏，查看它的 16 区价格明细</p></div>
          <a class="section-link" href="#/">回探索页 ${icon('arrow-right')}</a>
        </div>
        ${top.length ? gameGrid(top, { className: 'search-grid' }) : '<div class="empty-inline">暂时没有榜单数据。</div>'}`;
      bindImageFallbacks(target);
    }
  } catch (error) {
    if (isAbortError(error) || token !== state.renderToken) return;
    const target = document.querySelector('#quick-picks');
    if (target) {
      target.innerHTML = `
        <div class="section-head"><div><span class="eyebrow">QUICK START</span><h2>从热销游戏开始</h2></div></div>
        <div class="empty-inline">热销榜单暂时不可用，但你仍然可以搜索任意游戏开始比价。</div>`;
    }
  }
}

/* =========================================================
   Not found
   ========================================================= */
function notFoundPage() {
  return `
    <div class="page">
      <div class="empty-state" style="margin-top:60px">
        <div class="empty-icon">${icon('compass')}</div>
        <h2>这片区域还没有地图</h2>
        <p>你访问的页面不存在。回到探索页，继续寻找下一个世界。</p>
        <a class="button primary" href="#/">${icon('arrow-left')}返回探索</a>
      </div>
    </div>`;
}

/* =========================================================
   Search suggestions
   ========================================================= */
function closeSuggestPanels() {
  document.querySelectorAll('.suggest-panel').forEach((panel) => {
    panel.hidden = true;
    panel.innerHTML = '';
  });
}

function bindSearchForms(root) {
  root.querySelectorAll('form.js-search-form').forEach((form) => {
    if (form.dataset.bound === '1') return;
    form.dataset.bound = '1';
    const input = form.querySelector('input[name="q"]');
    const panel = form.querySelector('.suggest-panel');
    if (!input || !panel) return;
    let timer = null;
    let controller = null;
    let items = [];
    let activeIndex = -1;

    const hide = () => {
      panel.hidden = true;
      activeIndex = -1;
    };

    const navigateToSearch = () => {
      const query = input.value.trim();
      if (!query) return;
      hide();
      input.blur();
      if (/^\d{1,8}$/.test(query)) {
        window.location.hash = `#/game/${query}`;
      } else {
        window.location.hash = searchPath(query);
      }
    };

    const choose = (game) => {
      hide();
      input.blur();
      window.location.hash = gamePath(game.appid);
    };

    const updateActive = () => {
      panel.querySelectorAll('.suggest-item').forEach((item, index) => {
        item.classList.toggle('active', index === activeIndex);
        if (index === activeIndex) item.scrollIntoView({ block: 'nearest' });
      });
    };

    const renderResults = (data) => {
      if (!data.results?.length) {
        panel.innerHTML = `<div class="suggest-empty">没找到“${escapeHtml(input.value.trim())}”<br><span style="font-size:10px;color:var(--muted-2)">试试英文原名或 App ID</span></div>`;
        panel.hidden = false;
        return;
      }
      panel.innerHTML = `
        <div class="suggest-list">
          ${data.results.slice(0, 6).map((game, index) => `
            <button class="suggest-item" type="button" data-suggest-index="${index}">
              ${safeUrl(game.image) ? `<img src="${safeUrl(game.image)}" alt="" loading="lazy">` : ''}
              <span class="suggest-copy"><b>${escapeHtml(game.name)}</b><small>APP ${game.appid}${game.releaseDate ? ` · ${escapeHtml(game.releaseDate)}` : ''}${game.unlisted ? ' · 已下架' : ''}</small></span>
              <span class="suggest-price">${game.unlisted ? '<span class="unlisted-flag">已下架</span>' : escapeHtml(priceText(game.price, game.isFree))}</span>
            </button>`).join('')}
        </div>
        <div class="suggest-foot">
          <span>${data.results.length} 个匹配结果</span>
          <button type="button" data-suggest-all>查看全部结果</button>
        </div>`;
      panel.hidden = false;
      bindImageFallbacks(panel);
    };

    const load = async () => {
      const query = input.value.trim();
      if (query.length < 2) { hide(); return; }
      if (controller) controller.abort();
      controller = new AbortController();
      panel.innerHTML = '<div class="suggest-empty">正在搜索 Steam 商店…</div>';
      panel.hidden = false;
      try {
        const data = await api(`/api/search?q=${encodeURIComponent(query)}&cc=${encodeURIComponent(currentRegion().cc)}`, { signal: controller.signal });
        if (input.value.trim() !== query) return;
        items = data.results || [];
        activeIndex = -1;
        renderResults(data);
      } catch (error) {
        if (isAbortError(error)) return;
        if (input.value.trim() !== query) return;
        panel.innerHTML = `<div class="suggest-empty">${escapeHtml(error.message)}</div>`;
        panel.hidden = false;
      }
    };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const query = input.value.trim();
      if (query.length < 2) { hide(); return; }
      timer = setTimeout(load, 280);
    });

    input.addEventListener('keydown', (event) => {
      if (panel.hidden) return;
      const buttons = panel.querySelectorAll('.suggest-item');
      if (!buttons.length) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        activeIndex = Math.min(activeIndex + 1, buttons.length - 1);
        updateActive();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        updateActive();
      } else if (event.key === 'Escape') {
        hide();
      }
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (activeIndex >= 0 && items[activeIndex]) {
        choose(items[activeIndex]);
      } else {
        navigateToSearch();
      }
    });

    panel.addEventListener('mousedown', (event) => {
      const item = event.target.closest('[data-suggest-index]');
      if (item) {
        event.preventDefault();
        const game = items[Number(item.dataset.suggestIndex)];
        if (game) choose(game);
        return;
      }
      if (event.target.closest('[data-suggest-all]')) {
        event.preventDefault();
        navigateToSearch();
      }
    });

    form.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!form.contains(document.activeElement)) hide();
      }, 100);
    });
  });
}

function bindProfileForm(root) {
  const form = root.querySelector('#profile-lookup-form');
  if (!form || form.dataset.bound === '1') return;
  form.dataset.bound = '1';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = form.querySelector('input[name="id"]')?.value.trim();
    if (!value) {
      toast('请输入 SteamID、个性域名或主页链接', 'error');
      return;
    }
    window.location.hash = profilePath(value);
  });
}

/* =========================================================
   Region, settings, overlays
   ========================================================= */
function updateRegionUI() {
  const region = currentRegion();
  document.querySelector('#side-region-code').textContent = region.code;
  document.querySelector('#side-region-name').textContent = region.name;
  document.querySelector('#side-region-currency').textContent = `${region.currency} · ${region.currencyName}`;
  document.querySelector('#region-chip-code').textContent = region.code;
  document.querySelector('#region-chip-currency').textContent = region.currency;
  document.querySelectorAll('.region-option').forEach((option) => {
    option.classList.toggle('active', option.dataset.regionOption === region.cc);
  });
}

function updateKeyUI() {
  const connected = Boolean(state.serverKey);
  const sideStatus = document.querySelector('#side-key-status');
  const dot = document.querySelector('#key-dot');
  const chipDot = document.querySelector('#api-chip-dot');
  const chipLabel = document.querySelector('#api-chip-label');
  if (sideStatus) sideStatus.textContent = connected ? '官方 API 已连接' : '公开档案模式';
  if (dot) dot.classList.toggle('live', connected);
  if (chipDot) chipDot.classList.toggle('live', connected);
  if (chipLabel) chipLabel.textContent = connected ? '官方 API' : '公开模式';
}

/* =========================================================
   Admin backend
   ========================================================= */
function adminLoginPage(message = '') {
  return `
    <div class="page admin-page">
      <div class="admin-login panel">
        <div class="panel-title-row"><h2>管理后台</h2><span>ADMIN ACCESS</span></div>
        <p class="admin-hint">请输入管理员账号与密码。初始账号为 <code>steamweb</code>，登录后可以在后台自行修改密码。</p>
        ${message ? `<p class="admin-error">${escapeHtml(message)}</p>` : ''}
        <form class="admin-form" id="admin-login-form">
          <label>账号<input type="text" name="username" autocomplete="username" required></label>
          <label>密码<input type="password" name="password" autocomplete="current-password" required></label>
          <button class="button primary" type="submit">${icon('shield')}登录</button>
        </form>
      </div>
    </div>`;
}

function adminAuthPanel(debug) {
  if (!debug) return '';
  const rows = [
    ['回调地址', debug.callbackUrl],
    ['主机名', debug.hostname],
    ['协议', debug.https ? 'https ✓' : 'http ✗（Steam 只接受 https）'],
    ['API Key', debug.serverKeyConfigured ? '已配置' : '未配置'],
    ['当前 Key 指纹', debug.serverKeyFingerprint || '（未配置）'],
    ['PUBLIC_ORIGIN', debug.publicOriginOverride || '（未设置）'],
  ].map(([label, value]) => `
    <div class="identity-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(String(value))}</b></div>`).join('');

  const problems = Array.isArray(debug.problems) ? debug.problems : [];
  const status = !debug.serverKeyConfigured
    ? ['red', '未配置 Steam Web API Key，登录无法进行']
    : problems.length
      ? ['orange', problems.join('；')]
      : ['blue', '配置看起来正常，去 steamcommunity.com/dev/apikey 确认域名已登记即可'];

  return `
    <section class="panel admin-panel">
      <div class="panel-title-row"><h2>Steam 登录自检</h2><span>AUTH CHECK</span></div>
      <div class="admin-hint" style="margin-bottom:12px">Steam 只有在「回调域名已登记在 API Key 里」且「回调地址是 https」时才会完成 OpenID 握手。注意：登记域名的必须是服务器正在用的那一把 Key——Steam 会用登记了该域名的 Key 去签名回跳。</div>
      <div class="identity-list">${rows}</div>
      <div class="profile-note ${status[0] === 'red' ? 'warning' : ''}" style="margin-top:12px">${icon('info')}<span>${escapeHtml(status[1])}</span></div>
    </section>`;
}

function adminDashboard(stats, titles, debug) {
  const rows = titles.map((title, index) => `
    <tr data-admin-title="${escapeHtml(title.steamId)}">
      <td><input type="text" name="steamId" value="${escapeHtml(title.steamId)}" inputmode="numeric" pattern="\\d{17}" required></td>
      <td><input type="text" name="label" value="${escapeHtml(title.label)}" maxlength="24" required></td>
      <td>
        <select name="color">
          ${['crimson', 'blue', 'gold'].map((color) => `<option value="${color}" ${title.color === color ? 'selected' : ''}>${({ crimson: '深红', blue: '蓝色', gold: '金色' })[color]}</option>`).join('')}
        </select>
      </td>
      <td><input type="number" name="priority" value="${escapeHtml(String(title.priority))}" min="0" max="999"></td>
      <td><button class="admin-remove" type="button" data-action="admin-remove-title" title="删除该称号">${icon('close')}</button></td>
    </tr>`).join('');

  const statCards = [
    ['服务版本', stats.version],
    ['运行时长', `${Math.floor(stats.uptime / 60)} 分钟`],
    ['Steam API Key', stats.serverKey ? '已配置' : '未配置'],
    ['区服数量', stats.regions],
    ['缓存条目', stats.cachedEntries],
    ['称号数量', stats.titles],
    ['Steam 登录会话', stats.steamSessions],
    ['Node 版本', stats.node],
  ].map(([label, value]) => `
    <div class="admin-stat"><label>${escapeHtml(label)}</label><b>${escapeHtml(String(value))}</b></div>`).join('');

  return `
    <div class="page admin-page">
      <div class="admin-head">
        <div class="panel-title-row"><h2>管理后台</h2><span>ADMIN · ${escapeHtml(stats.username || '')}</span></div>
        <button class="button" type="button" data-action="admin-logout">${icon('lock')}退出登录</button>
      </div>

      <section class="panel admin-panel">
        <div class="panel-title-row"><h2>运行状态</h2><span>STATUS</span></div>
        <div class="admin-stats">${statCards}</div>
      </section>

      <section class="panel admin-panel">
        <div class="panel-title-row"><h2>玩家称号</h2><span>TITLES · ${titles.length}</span></div>
        <p class="admin-hint">称号会显示在 Steam 名称后面。颜色可选深红 / 蓝色 / 金色，优先级数值越大越靠前。保存后立即生效。</p>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>SteamID64</th><th>称号</th><th>颜色</th><th>优先级</th><th></th></tr></thead>
            <tbody id="admin-titles-body">${rows}</tbody>
          </table>
        </div>
        <div class="admin-actions">
          <button class="button" type="button" data-action="admin-add-title">${icon('sparkles')}添加称号</button>
          <button class="button primary" type="button" data-action="admin-save-titles">${icon('check')}保存全部</button>
        </div>
      </section>

      <section class="panel admin-panel">
        <div class="panel-title-row"><h2>修改登录密码</h2><span>PASSWORD</span></div>
        <p class="admin-hint">修改后立即生效，其它设备上已登录的管理员会话会被强制下线。新密码至少 8 位，且需要同时包含字母和数字。若服务端设置了 <code>ADMIN_PASSWORD</code> 环境变量，重启后会以环境变量为准。</p>
        <form class="admin-form row" id="admin-password-form">
          <label>当前密码<input type="password" name="currentPassword" autocomplete="current-password" required></label>
          <label>新密码<input type="password" name="newPassword" autocomplete="new-password" minlength="8" required></label>
          <label>确认新密码<input type="password" name="confirmPassword" autocomplete="new-password" minlength="8" required></label>
          <button class="button primary" type="submit">${icon('lock')}修改密码</button>
        </form>
      </section>

      ${adminAuthPanel(debug)}
    </div>`;
}

async function renderAdmin(token, signal) {
  let session = null;
  try {
    session = await api('/api/admin/session', { signal });
  } catch (error) {
    setView(adminLoginPage(error.message));
    return;
  }
  if (!session.authenticated) {
    setView(adminLoginPage());
    return;
  }
  try {
    const [stats, titlesData, debug] = await Promise.all([
      api('/api/admin/stats', { signal }),
      api('/api/admin/titles', { signal }),
      api('/api/auth/debug', { signal }).catch(() => null),
    ]);
    if (token !== state.renderToken) return;
    setView(adminDashboard(
      { ...stats, username: session.username },
      titlesData.titles || [],
      debug ? { ...debug, serverKeyFingerprint: stats.serverKeyFingerprint || debug.serverKeyFingerprint } : null,
    ));
  } catch (error) {
    if (error.status === 401) {
      setView(adminLoginPage('登录已失效，请重新登录'));
      return;
    }
    setView(adminLoginPage(error.message));
  }
}

function collectAdminTitles() {
  const body = document.querySelector('#admin-titles-body');
  if (!body) return [];
  return [...body.querySelectorAll('tr[data-admin-title]')].map((row) => ({
    steamId: row.querySelector('input[name="steamId"]')?.value.trim() || '',
    label: row.querySelector('input[name="label"]')?.value.trim() || '',
    color: row.querySelector('select[name="color"]')?.value || 'crimson',
    priority: Number(row.querySelector('input[name="priority"]')?.value) || 0,
  }));
}

/* =========================================================
   Steam session (OpenID login)
   ========================================================= */
async function loadSession() {
  try {
    const data = await api('/api/auth/session');
    state.session = data.authenticated ? data.user : null;
  } catch {
    state.session = null;
  }
  renderSessionUI();
  return state.session;
}

function renderSessionUI() {
  const user = state.session;
  const loginButton = document.querySelector('#steam-login');
  const loginName = document.querySelector('#login-name');
  const loginStatus = document.querySelector('#login-status');
  const loginAvatar = document.querySelector('#login-avatar');
  const chip = document.querySelector('#user-chip');
  const chipAvatar = document.querySelector('#user-chip-avatar');
  const chipName = document.querySelector('#user-chip-name');
  const logoutButton = document.querySelector('#steam-logout');

  if (user) {
    if (loginName) loginName.textContent = user.personaName || 'Steam 玩家';
    if (loginStatus) loginStatus.textContent = '已登录 · 点击查看我的档案';
    if (loginAvatar) {
      const url = safeUrl(user.avatar);
      loginAvatar.innerHTML = url ? `<img src="${url}" alt="">` : icon('user');
      loginAvatar.classList.add('has-avatar');
    }
    if (loginButton) {
      loginButton.dataset.action = 'my-profile';
      loginButton.title = '查看我的 Steam 档案';
    }
    if (chip) {
      chip.hidden = false;
      chip.href = `#/profile/${encodeURIComponent(user.steamId)}`;
    }
    if (chipName) chipName.textContent = user.personaName || 'Steam 玩家';
    if (chipAvatar) {
      const url = safeUrl(user.avatar);
      chipAvatar.innerHTML = url ? `<img src="${url}" alt="">` : icon('user');
    }
    if (logoutButton) logoutButton.hidden = false;
  } else {
    if (loginName) loginName.textContent = 'Steam 登录';
    if (loginStatus) loginStatus.textContent = '登录后可查看我的档案';
    if (loginAvatar) {
      loginAvatar.innerHTML = icon('user');
      loginAvatar.classList.remove('has-avatar');
    }
    if (loginButton) {
      loginButton.dataset.action = 'steam-login';
      loginButton.title = '使用 Steam 账号登录';
    }
    if (chip) chip.hidden = true;
    if (logoutButton) logoutButton.hidden = true;
  }
}

function handleAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const auth = params.get('auth');
  if (!auth) return;
  const reason = params.get('reason') || '';
  const code = params.get('code') || '';
  params.delete('auth');
  params.delete('reason');
  params.delete('code');
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  if (auth === 'ok') {
    toast('已通过 Steam 账号登录');
    return;
  }
  toast(`${reason || 'Steam 登录失败，请重试'}${code ? `（${code}）` : ''}`, 'error');
}

function renderRegionControls() {  if (!regionListEl) return;
  regionListEl.innerHTML = state.regions.map((region) => `
    <button class="region-option ${region.cc === state.region ? 'active' : ''}" type="button" data-region-option="${region.cc}">
      <span class="region-code">${escapeHtml(region.code)}</span>
      <span><b>${escapeHtml(region.name)}</b><small>${escapeHtml(region.currency)} · ${escapeHtml(region.currencyName)}</small></span>
    </button>`).join('');
  updateRegionUI();
}

function setRegion(cc, { render = true } = {}) {
  const region = regionByCc(cc);
  if (!region || region.cc === state.region) {
    closeRegionPopover();
    return;
  }
  state.region = region.cc;
  try { localStorage.setItem(STORAGE.region, region.cc); } catch { /* ignore */ }
  state.heroIndex = 0;
  updateRegionUI();
  closeRegionPopover();
  closeSidebar();
  toast(`已切换到${region.name} · ${region.currency}（${region.currencyName}）`);
  if (render && state.route) renderRoute();
}

function openRegionPopover(anchor) {
  if (!state.regions.length) return;
  const rect = anchor.getBoundingClientRect();
  regionPopover.hidden = false;
  regionPopover.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-expanded', 'true');
  const width = regionPopover.offsetWidth;
  const height = regionPopover.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 9;
  if (innerWidth <= 900 && rect.left < 100) {
    left = rect.right + 10;
    top = rect.bottom - height;
  }
  if (rect.bottom + height + 20 > innerHeight) top = Math.max(12, rect.top - height - 9);
  left = Math.max(12, Math.min(left, innerWidth - width - 12));
  top = Math.max(12, Math.min(top, innerHeight - height - 12));
  regionPopover.style.left = `${left}px`;
  regionPopover.style.top = `${top}px`;
}

function closeRegionPopover() {
  if (!regionPopover) return;
  regionPopover.hidden = true;
  document.querySelectorAll('#region-button, #region-chip').forEach((button) => button.setAttribute('aria-expanded', 'false'));
}

function openSidebar() {
  sidebar.classList.add('open');
  sidebarScrim.hidden = false;
  document.body.classList.add('is-locked');
}

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarScrim.hidden = true;
  document.body.classList.remove('is-locked');
}

function openLightbox(src, caption = '') {
  if (!src) return;
  lightboxImage.src = src;
  lightboxCaption.textContent = caption;
  if (typeof lightbox.showModal === 'function') lightbox.showModal();
  else lightbox.setAttribute('open', '');
}

function closeLightbox() {
  if (lightbox.open) lightbox.close();
  else lightbox.removeAttribute('open');
  lightboxImage.removeAttribute('src');
}

function initStaticEvents() {
  document.querySelector('#region-button').addEventListener('click', (event) => {
    event.stopPropagation();
    openRegionPopover(event.currentTarget);
  });
  document.querySelector('#region-chip').addEventListener('click', (event) => {
    event.stopPropagation();
    openRegionPopover(event.currentTarget);
  });
  document.querySelector('#region-close').addEventListener('click', closeRegionPopover);
  document.querySelector('#menu-button').addEventListener('click', () => {
    if (sidebar.classList.contains('open')) closeSidebar();
    else openSidebar();
  });
  sidebarScrim.addEventListener('click', closeSidebar);
  document.querySelector('#lightbox-close').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox || event.target === lightboxImage) closeLightbox();
  });
  document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', closeSidebar));

  document.addEventListener('click', handleDelegatedClick);
  document.addEventListener('submit', handleDelegatedSubmit);
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('resize', () => {
    closeRegionPopover();
    if (innerWidth > 900) closeSidebar();
  });
  window.addEventListener('hashchange', renderRoute);
}

async function handleDelegatedSubmit(event) {
  const loginForm = event.target.closest('#admin-login-form');
  if (loginForm) {
    event.preventDefault();
    const data = new FormData(loginForm);
    const submit = loginForm.querySelector('button[type="submit"]');
    if (submit) { submit.disabled = true; submit.textContent = '登录中…'; }
    try {
      await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
      });
      toast('管理员登录成功');
      await renderAdmin(state.renderToken, state.abortController?.signal);
    } catch (error) {
      setView(adminLoginPage(error.message || '登录失败'));
    }
    return;
  }

  const passwordForm = event.target.closest('#admin-password-form');
  if (passwordForm) {
    event.preventDefault();
    const data = new FormData(passwordForm);
    const current = String(data.get('currentPassword') || '');
    const next = String(data.get('newPassword') || '');
    const confirm = String(data.get('confirmPassword') || '');
    if (next !== confirm) {
      toast('两次输入的新密码不一致', 'error');
      return;
    }
    const submit = passwordForm.querySelector('button[type="submit"]');
    const original = submit ? submit.innerHTML : '';
    if (submit) { submit.disabled = true; submit.textContent = '提交中…'; }
    try {
      await api('/api/admin/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      passwordForm.reset();
      toast('密码已修改，请牢记新密码');
    } catch (error) {
      toast(error.message || '修改失败', 'error');
    } finally {
      if (submit) { submit.disabled = false; submit.innerHTML = original; }
    }
    return;
  }
}

async function handleDelegatedClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  if (!target.closest('#region-popover') && !target.closest('#region-button') && !target.closest('#region-chip')) {
    closeRegionPopover();
  }

  const regionOption = target.closest('[data-region-option]');
  if (regionOption) {
    setRegion(regionOption.dataset.regionOption);
    return;
  }

  const heroPick = target.closest('[data-hero-pick]');
  if (heroPick && state.featured) {
    state.heroIndex = Number(heroPick.dataset.heroPick) || 0;
    const stage = document.querySelector('.hero-stage');
    if (stage) {
      stage.innerHTML = heroStage(state.featured);
      bindImageFallbacks(stage);
    }
    return;
  }

  const trendingTab = target.closest('[data-trending-tab]');
  if (trendingTab && state.featured) {
    state.trendingTab = trendingTab.dataset.trendingTab || 'topSellers';
    document.querySelectorAll('[data-trending-tab]').forEach((button) => {
      button.classList.toggle('active', button === trendingTab);
      button.setAttribute('aria-selected', button === trendingTab ? 'true' : 'false');
    });
    const tabs = {
      topSellers: { items: state.featured.topSellers || [], rank: true },
      newReleases: { items: state.featured.newReleases || [], rank: false },
      specials: { items: state.featured.specials || [], rank: false },
    };
    const active = tabs[state.trendingTab] || tabs.topSellers;
    const grid = document.querySelector('#trending-grid');
    if (grid) {
      grid.innerHTML = active.items.length ? gameGrid(active.items.slice(0, 10), { rank: active.rank }) : '<div class="empty-inline">这个榜单暂时没有数据。</div>';
      bindImageFallbacks(grid);
    }
    return;
  }

  const quickSearch = target.closest('[data-quick-search]');
  if (quickSearch) {
    window.location.hash = searchPath(quickSearch.dataset.quickSearch);
    return;
  }

  const profileExample = target.closest('[data-profile-query]');
  if (profileExample) {
    window.location.hash = profilePath(profileExample.dataset.profileQuery);
    return;
  }

  const copyButton = target.closest('[data-copy]');
  if (copyButton) {
    copyText(copyButton.dataset.copy);
    return;
  }

  const lightboxButton = target.closest('[data-lightbox]');
  if (lightboxButton) {
    openLightbox(lightboxButton.dataset.lightbox, lightboxButton.dataset.caption || '');
    return;
  }

  const action = target.closest('[data-action]')?.dataset.action;
  if (action === 'reload') { window.location.reload(); return; }
  if (action === 'admin-add-title') {
    const body = document.querySelector('#admin-titles-body');
    if (!body) return;
    const row = document.createElement('tr');
    row.dataset.adminTitle = 'new';
    row.innerHTML = `
      <td><input type="text" name="steamId" inputmode="numeric" pattern="\\d{17}" placeholder="7656119..." required></td>
      <td><input type="text" name="label" maxlength="24" placeholder="Owner" required></td>
      <td><select name="color"><option value="crimson">深红</option><option value="blue">蓝色</option><option value="gold">金色</option></select></td>
      <td><input type="number" name="priority" value="50" min="0" max="999"></td>
      <td><button class="admin-remove" type="button" data-action="admin-remove-title" title="删除该称号">${icon('close')}</button></td>`;
    body.append(row);
    row.querySelector('input[name="steamId"]')?.focus();
    return;
  }
  if (action === 'admin-remove-title') {
    const row = target.closest('tr[data-admin-title]');
    if (row) row.remove();
    return;
  }
  if (action === 'admin-save-titles') {
    const titles = collectAdminTitles();
    if (!titles.length) { toast('至少保留一个称号', 'error'); return; }
    try {
      await api('/api/admin/titles', { method: 'PUT', body: JSON.stringify({ titles }) });
      toast('称号已保存并生效');
      renderRoute();
    } catch (error) {
      toast(error.message || '保存失败', 'error');
    }
    return;
  }
  if (action === 'admin-logout') {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* ignore */ }
    toast('已退出管理后台');
    setView(adminLoginPage());
    return;
  }
  if (action === 'steam-login') {
    window.location.href = '/api/auth/login';
    return;
  }
  if (action === 'my-profile') {
    if (state.session?.steamId) window.location.hash = `#/profile/${encodeURIComponent(state.session.steamId)}`;
    return;
  }
  if (action === 'steam-logout') {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore network errors, the cookie is cleared anyway */ }
    state.session = null;
    renderSessionUI();
    toast('已退出 Steam 登录');
    return;
  }
  if (action === 'scroll-prices') {
    const board = document.querySelector('#price-board');
    if (board) {
      const top = board.getBoundingClientRect().top + window.scrollY - 84;
      window.scrollTo({ top, behavior: 'smooth' });
    }
    return;
  }
  if (action === 'toggle-about') {
    const text = document.querySelector('#about-text');
    if (!text) return;
    const open = text.classList.toggle('clamped');
    target.textContent = open ? '展开完整简介' : '收起简介';
    return;
  }
  if (action === 'focus-search') {
    const input = document.querySelector('.hero-search input[name="q"]') || document.querySelector('#global-search-input');
    input?.focus();
    return;
  }

  if (target.closest('[data-clear-profiles]')) {
    state.recentProfiles = [];
    writeJson(STORAGE.recentProfiles, []);
    renderRoute();
    toast('最近查询记录已清除');
    return;
  }

  // Close the mobile drawer when a normal in-page navigation link is used.
  if (target.closest('a[href^="#/"]') && innerWidth <= 900) closeSidebar();
}

function handleKeydown(event) {
  if (event.key === 'Escape') {
    closeRegionPopover();
    closeSuggestPanels();
    closeSidebar();
    if (lightbox.open) closeLightbox();
    return;
  }
  if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const active = document.activeElement;
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
    if (!typing && !lightbox.open) {
      event.preventDefault();
      document.querySelector('#global-search-input')?.focus();
    }
  }
}

/* =========================================================
   Boot
   ========================================================= */
async function boot() {
  renderRecentGames();
  initStaticEvents();
  bindSearchForms(document);
  bindImageFallbacks(document);
  handleAuthRedirect();
  try {
    const config = await api('/api/config');
    state.config = config;
    state.regions = config.regions || [];
    state.serverKey = Boolean(config.hasServerKey);
    if (!state.regions.some((region) => region.cc === state.region)) state.region = config.defaults?.region || 'cn';
    renderRegionControls();
    updateKeyUI();
    updateRegionUI();
    await loadSession();
    await renderRoute();
    // Re-run after the first view is painted: the topbar form exists from the
    // start, but this also catches any form injected by the initial route.
    bindSearchForms(document);
    bindProfileForm(document);
  } catch (error) {
    setView(`
      <div class="page">
        <div class="empty-state" style="margin-top:70px">
          <div class="empty-icon">${icon('alert')}</div>
          <h2>无法连接 Steam Atlas 服务</h2>
          <p>${escapeHtml(error.message)}<br>请在项目目录运行 <code style="color:var(--accent);font-family:var(--font-mono)">node server.mjs</code>，然后刷新页面。</p>
          <button class="button primary" type="button" data-action="reload">${icon('refresh')}重新加载</button>
        </div>
      </div>`);
  }
}

boot();
