// 建立 Steam 应用名称索引（下架游戏也能被搜到）。
// 用法：node build-index.mjs [--from=1] [--to=4000000] [--concurrency=3]
import { scanAppIndex } from './appindex.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));

const started = Date.now();
console.log('[index] 开始扫描 App ID 空间…');

const result = await scanAppIndex({
  from: args.from ? Number(args.from) : null,
  to: args.to ? Number(args.to) : undefined,
  concurrency: args.concurrency ? Number(args.concurrency) : undefined,
  onProgress: ({ cursor, scanned, added, size }) => {
    const minutes = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`[index] 已扫到 App ID ${cursor}（新增 ${added}，索引共 ${size}）· 用时 ${minutes} 分钟`);
  },
});

console.log(`[index] 完成：扫描 ${result.scanned} 个，新增 ${result.added}，索引总数 ${result.count}，进度停在 ${result.next}`);
