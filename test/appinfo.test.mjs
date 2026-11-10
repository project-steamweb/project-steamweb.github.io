// appinfo 模块的离线单元测试：构造 KeyValues 二进制数据，验证解析与字段抽取。
import { parseKeyValues, kvToAppInfo } from '../appinfo.mjs';

/* --- KeyValues 写入器（与 Steam 的二进制格式一致） --- */
const TYPE_OBJECT = 0x00;
const TYPE_STRING = 0x01;
const TYPE_INT32 = 0x02;
const TYPE_END = 0x08;

function cstr(text) {
  return Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
}

function kvString(key, value) {
  return Buffer.concat([Buffer.from([TYPE_STRING]), cstr(key), cstr(value)]);
}

function kvInt(key, value) {
  const body = Buffer.alloc(4);
  body.writeInt32LE(value, 0);
  return Buffer.concat([Buffer.from([TYPE_INT32]), cstr(key), body]);
}

function kvObject(key, children) {
  return Buffer.concat([Buffer.from([TYPE_OBJECT]), cstr(key), Buffer.concat(children), Buffer.from([TYPE_END])]);
}

function kvRoot(children) {
  return Buffer.concat([Buffer.from([TYPE_OBJECT]), cstr(''), Buffer.concat(children), Buffer.from([TYPE_END])]);
}

/* --- 构造一份与 steamcmd app_info_print 结构一致的样例 --- */
const buffer = kvRoot([
  kvString('appid', '280490'),
  kvObject('common', [
    kvString('name', 'Evolve'),
    kvString('type', 'Game'),
    kvString('developer', 'Turtle Rock Studios'),
    kvString('publisher', 'Turtle Rock Studios'),
    kvString('short_description', '一款四人合作射击游戏。'),
    kvInt('parent', 0),
  ]),
  kvObject('extended', [
    kvObject('section', [
      kvString('name', 'Evolve'),
      kvString('type', 'Game'),
      kvString('developer', 'Turtle Rock Studios'),
      kvString('publisher', 'Turtle Rock Studios'),
      kvString('short_description', '一款四人合作射击游戏。'),
      kvObject('price', [
        kvString('currency', 'CNY'),
        kvInt('initial', 29800),
        kvInt('final', 29800),
        kvInt('discount_percent', 0),
      ]),
      kvObject('dlcs', [
        kvString('280491', 'Huntsman Pack'),
        kvString('280492', 'Strider Pack'),
      ]),
    ]),
    kvObject('release_date', [
      kvString('date', '2015 年 2 月 8 日'),
    ]),
    kvObject('assets', [
      kvString('0', 'https://cdn.example/header.jpg'),
    ]),
  ]),
]);

const checks = [];

const kv = parseKeyValues(buffer);
checks.push(['KV 根键为空', kv.key === '']);
checks.push(['KV 含 appid', kv.value.appid === '280490']);
checks.push(['KV 含 common.name', kv.value.common.name === 'Evolve']);
checks.push(['KV 嵌套对象正确', kv.value.extended.release_date.date === '2015 年 2 月 8 日']);
checks.push(['KV 含价格', kv.value.extended.section.price.final === 29800]);
checks.push(['KV 含 DLC 映射', Object.keys(kv.value.extended.section.dlcs).length === 2]);

const info = kvToAppInfo(kv);
checks.push(['抽取到名称', info?.name === 'Evolve']);
checks.push(['类型映射为 game', info?.type === 'game']);
checks.push(['抽取到开发商', info?.developer === 'Turtle Rock Studios']);
checks.push(['抽取到发行商', info?.publisher === 'Turtle Rock Studios']);
checks.push(['抽取到简介', info?.description === '一款四人合作射击游戏。']);
checks.push(['抽取到发售日期', info?.releaseDate === '2015 年 2 月 8 日']);
checks.push(['价格单位为分', info?.price?.final === 29800]);
checks.push(['价格币种正确', info?.price?.currency === 'CNY']);
checks.push(['DLC 列表条目数', info?.dlcs?.length === 2]);
checks.push(['DLC 含名称', info?.dlcs?.[0]?.name === 'Huntsman Pack']);

for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
