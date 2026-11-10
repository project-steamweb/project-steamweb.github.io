// 在 Steam 社区页面上侦测当前浏览器已登录的 Steam 账号。
// 只读取页面上的公开 SteamID，不做任何修改。
(() => {
  function detectSteamId() {
    const globalId = typeof window.g_steamID === 'string' ? window.g_steamID : '';
    if (globalId) return globalId;
    const pathMatch = location.pathname.match(/\/profiles\/(\d{17})/);
    if (pathMatch) return pathMatch[1];
    const link = document.querySelector('a[href*="/profiles/"]');
    const linkMatch = link?.getAttribute('href')?.match(/(\d{17})/);
    return linkMatch ? linkMatch[1] : '';
  }

  const steamId = detectSteamId();
  if (!steamId) return;
  chrome.storage.local.set({ detectedSteamId: steamId });
  chrome.runtime.sendMessage({ type: 'detected', steamId }).catch(() => {});
})();
