// Steam Atlas 助手 — 面板逻辑。
// 与后台服务通信，所有 Steam 请求都由 background.js 代发。

const el = (id) => document.getElementById(id);
const statusEl = el('status');

function setStatus(text, tone = '') {
  statusEl.textContent = text;
  statusEl.className = tone;
}

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (!response) { reject(new Error('后台服务没有响应')); return; }
      if (!response.ok) { reject(new Error(response.error || '请求失败')); return; }
      resolve(response.data);
    });
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function steamRunUrl(appid) {
  return `steam://run/${appid}`;
}

function steamStoreUrl(appid) {
  return `steam://store/${appid}`;
}

function storeWebUrl(appid) {
  return `https://store.steampowered.com/app/${appid}`;
}

function renderItem(item, { showHours = false } = {}) {
  let meta = `APP ${item.appid}`;
  if (showHours && item.hours) meta = `${item.hours} 小时`;
  else if (item.price) {
    const discount = item.price.discount ? ` −${item.price.discount}%` : '';
    meta = `${item.price.currency} ${item.price.final.toFixed(2)}${discount}`;
  }
  if (item.metacritic) meta += ` · MC ${item.metacritic}`;
  return `
    <li class="item">
      ${item.image ? `<img src="${escapeHtml(item.image)}" alt="" loading="lazy">` : '<span></span>'}
      <span class="item-body">
        <b>${escapeHtml(item.name || `App ${item.appid}`)}</b>
        <small>${escapeHtml(meta)}</small>
      </span>
      <span class="item-actions">
        <a class="run" href="${steamRunUrl(item.appid)}" title="用 Steam 客户端启动">启动</a>
        <a href="${steamStoreUrl(item.appid)}" title="在 Steam 客户端中打开商店页">商店</a>
        <a href="${storeWebUrl(item.appid)}" target="_blank" rel="noopener" title="在浏览器中打开商店页">网页</a>
      </span>
    </li>`;
}

function renderList(target, html, emptyText) {
  target.innerHTML = html || `<li class="empty">${escapeHtml(emptyText)}</li>`;
}

/* ---------------- tabs ---------------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
    document.querySelectorAll('.pane').forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === tab.dataset.tab));
    setStatus('就绪');
  });
});

/* ---------------- search ---------------- */
el('search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const term = el('search-input').value.trim();
  if (!term) return;
  setStatus('搜索中…');
  el('search-hint').textContent = '搜索中…';
  try {
    const results = await send('search', { term });
    renderList(el('search-results'), results.map((item) => renderItem(item)).join(''), '没有找到相关游戏');
    el('search-hint').textContent = `找到 ${results.length} 条结果，来自 Steam 商店公开接口。`;
    setStatus('完成');
  } catch (error) {
    renderList(el('search-results'), '', '搜索失败');
    el('search-hint').textContent = error.message;
    el('search-hint').classList.add('error');
    setStatus('失败', 'error');
  }
});

/* ---------------- library ---------------- */
async function loadLibrary() {
  const input = el('steam-id').value.trim();
  if (!input) { el('library-hint').textContent = '请先填写 SteamID64 或个性域名。'; return; }

  el('library-hint').classList.remove('error');
  el('library-hint').textContent = '读取中…';
  setStatus('读取中…');

  try {
    let steamId = input;
    if (!/^\d{17}$/.test(steamId)) {
      steamId = await send('resolve', { vanity: input });
      if (!steamId) throw new Error('无法解析该个性域名');
    }

    const [summary, owned, recent, level] = await Promise.all([
      send('summary', { steamId }).catch(() => null),
      send('owned', { steamId }).catch(() => null),
      send('recent', { steamId }).catch(() => null),
      send('level', { steamId }).catch(() => null),
    ]);

    if (summary) {
      el('profile-card').hidden = false;
      el('profile-avatar').src = summary.avatarfull || summary.avatarmedium || '';
      el('profile-name').textContent = summary.personaname || 'Steam 玩家';
      el('profile-id').textContent = `${steamId} · 等级 ${level ?? summary.player_level ?? '—'}`;
    }

    if (owned) {
      el('library-stats').hidden = false;
      el('stat-count').textContent = owned.count;
      el('stat-hours').textContent = `${Math.round(owned.totalMinutes / 60)} h`;
      renderList(el('library-results'), owned.games.map((game) => renderItem(game, { showHours: true })).join(''), '该账号的游戏库为空或未公开');
      el('library-hint').textContent = recent?.length
        ? `最近在玩：${recent.map((game) => game.name).slice(0, 3).join('、')}`
        : '已读取游戏库。';
    } else {
      renderList(el('library-results'), '', '无法读取游戏库');
      el('library-hint').textContent = '无法读取游戏库：需要有效的 API Key，且该玩家需公开游戏详情。';
      el('library-hint').classList.add('error');
    }
    setStatus('完成');
  } catch (error) {
    el('library-hint').textContent = error.message;
    el('library-hint').classList.add('error');
    renderList(el('library-results'), '', '读取失败');
    setStatus('失败', 'error');
  }
}

el('load-library').addEventListener('click', loadLibrary);
el('steam-id').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); loadLibrary(); } });

/* ---------------- account ---------------- */
el('save-key').addEventListener('click', async () => {
  const key = el('api-key').value.trim();
  await chrome.storage.local.set({ steamApiKey: key });
  el('api-key').value = '';
  setStatus(key ? 'Key 已保存到本机' : 'Key 已清除');
  el('account-results').innerHTML = '';
});

async function refreshAccount() {
  const stored = await chrome.storage.local.get(['steamApiKey', 'detectedSteamId']);
  if (stored.steamApiKey) el('api-key').placeholder = '已保存 Key（点击保存可覆盖）';
  const detected = stored.detectedSteamId || '';
  if (detected) {
    el('steam-id').value = detected;
    el('library-hint').textContent = `已自动识别当前浏览器的 Steam 账号：${detected}`;
  }
}

document.addEventListener('DOMContentLoaded', refreshAccount);

/* ---------------- side panel ---------------- */
el('open-side').addEventListener('click', async () => {
  if (!chrome.sidePanel) { setStatus('当前浏览器不支持侧边栏', 'error'); return; }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    setStatus('无法打开侧边栏', 'error');
  }
});
