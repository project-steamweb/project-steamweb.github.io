// Steam appinfo (Content Server) client.
//
// Steam 的商店公开接口只提供「当前在售」的游戏数据；已经下架 / 未公开的游戏
// 只有 Content Server 仍然保留着完整资料，steamcmd 的 `app_info_print` 就是
// 通过这个协议读取的。本模块用纯 Node 实现（TLS + WebSocket + Protobuf +
// KeyValues），供服务端在商店接口失败时兜底。
//
// 如果运行环境无法连接 cm.steampowered.com（例如被防火墙拦截），
// fetchAppInfo 会安静地返回 null，不影响站点其它功能。

import tls from 'node:tls';
import crypto from 'node:crypto';

const CM_HOST = process.env.STEAM_CM_HOST || 'cm.steampowered.com';
const CM_PORT = Number(process.env.STEAM_CM_PORT || 443);

const EMsg = {
  CLIENT_HELLO: 1,
  CLIENT_LOGON: 2,
  CLIENT_APPI_INFO: 32,
  CLIENT_REQUEST_APPI_INFO: 33,
  MULTI: 0xffffffff,
};

// 连续失败后暂停一段时间，避免每次查询都去等一次连接超时。
let blockedUntil = 0;

function cmBlocked() {
  return Date.now() < blockedUntil;
}

/* ------------------------------ Protobuf ------------------------------ */
function varint(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    bytes.push(byte);
  } while (v);
  return Buffer.from(bytes);
}

function pbTag(field, wire) {
  return varint((field << 3) | wire);
}

function pbString(field, value) {
  const body = Buffer.from(String(value), 'utf8');
  return Buffer.concat([pbTag(field, 2), varint(body.length), body]);
}

function pbBytes(field, value) {
  return Buffer.concat([pbTag(field, 2), varint(value.length), value]);
}

function pbUint(field, value) {
  return Buffer.concat([pbTag(field, 0), varint(value)]);
}

function pbBool(field, value) {
  return Buffer.concat([pbTag(field, 0), varint(value ? 1 : 0)]);
}

function pbDecode(buffer) {
  const out = {};
  let offset = 0;
  while (offset < buffer.length) {
    let shift = 0;
    let key = 0;
    while (offset < buffer.length) {
      const byte = buffer[offset++];
      key |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      let value = 0;
      shift = 0;
      while (offset < buffer.length) {
        const byte = buffer[offset++];
        value |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) break;
        shift += 7;
      }
      out[field] = value;
    } else if (wire === 2) {
      let length = 0;
      shift = 0;
      while (offset < buffer.length) {
        const byte = buffer[offset++];
        length |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) break;
        shift += 7;
      }
      out[field] = buffer.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 5) {
      out[field] = buffer.readUInt32LE(offset);
      offset += 4;
    } else if (wire === 1) {
      out[field] = Number(buffer.readBigUInt64LE(offset));
      offset += 8;
    } else {
      break;
    }
  }
  return out;
}

/* ------------------------------ CM 消息封装 ------------------------------ */
function cmMessage(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(type, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function cmSplit(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const type = buffer.readUInt32LE(offset);
    const length = buffer.readUInt32LE(offset + 4);
    if (offset + 8 + length > buffer.length) break;
    messages.push({ type, payload: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 8 + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

/* ------------------------------ KeyValues ------------------------------ */
export function parseKeyValues(buffer) {
  let offset = 0;

  function readByte() {
    if (offset >= buffer.length) throw new Error('KeyValues 越界');
    return buffer[offset++];
  }

  function readCString() {
    const end = buffer.indexOf(0, offset);
    if (end < 0) throw new Error('KeyValues 字符串未结束');
    const text = buffer.subarray(offset, end).toString('utf8');
    offset = end + 1;
    return text;
  }

  function readValue(type) {
    switch (type) {
      case 0x00: return readObject();
      case 0x01: return readCString();
      case 0x02: { const v = buffer.readInt32LE(offset); offset += 4; return v; }
      case 0x03: { const v = buffer.readFloatLE(offset); offset += 4; return v; }
      case 0x04: { const v = buffer.readUInt32LE(offset); offset += 4; return v; }
      case 0x05: { const end = buffer.indexOf(0, offset); const t = buffer.subarray(offset, end).toString('utf8'); offset = end + 1; return t; }
      case 0x06: { const v = buffer.readUInt32LE(offset); offset += 4; return v; }
      case 0x07: { const v = Number(buffer.readBigUInt64LE(offset)); offset += 8; return v; }
      case 0x08: return null;
      case 0x0a: { const v = Number(buffer.readBigInt64LE(offset)); offset += 8; return v; }
      case 0x0b: return null;
      default: throw new Error(`未知 KeyValues 类型 0x${type.toString(16)}`);
    }
  }

  function readObject() {
    const result = {};
    for (;;) {
      const type = readByte();
      if (type === 0x08 || type === 0x0b) break;
      const key = readCString();
      result[key] = readValue(type);
    }
    return result;
  }

  const type = readByte();
  const key = readCString();
  return { key, value: readValue(type) };
}

/* ------------------------------ WebSocket ------------------------------ */
function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    let mask = null;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + length > buffer.length) break;
    let payload = buffer.subarray(cursor, cursor + length);
    if (mask) {
      const out = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    }
    frames.push({ opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function encodeFrame(payload, opcode = 0x2) {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function connectCm(timeout = 10000) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = tls.connect({ host: CM_HOST, port: CM_PORT, servername: CM_HOST }, () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${CM_HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\n\r\n`,
      );
    });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('连接 CM 服务器超时'));
    }, timeout);

    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const handlers = [];

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const index = buffer.indexOf('\r\n\r\n');
        if (index < 0) return;
        const head = buffer.subarray(0, index).toString('latin1');
        const expected = crypto.createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (!head.includes(expected)) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error('CM WebSocket 握手失败'));
          return;
        }
        buffer = buffer.subarray(index + 4);
        upgraded = true;
        clearTimeout(timer);
        resolve({
          send: (data) => socket.write(encodeFrame(data)),
          on: (fn) => handlers.push(fn),
          close: () => socket.end(),
        });
        return;
      }
      const { frames, rest } = parseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x8) { socket.end(); return; }
        if (frame.opcode === 0x9) { socket.write(encodeFrame(frame.payload, 0xa)); continue; }
        for (const handler of handlers) handler(frame.payload);
      }
    });
  });
}

/* ------------------------------ 资料抽取 ------------------------------ */
function pick(source, ...paths) {
  for (const path of paths) {
    let current = source;
    for (const key of path.split('.')) {
      if (current == null || typeof current !== 'object') { current = undefined; break; }
      current = current[key];
    }
    if (current !== undefined && current !== null && current !== '') return current;
  }
  return undefined;
}

export function kvToAppInfo(kv) {
  const root = kv?.value || {};
  const common = root.common || {};
  const extended = root.extended || {};
  const section = extended.section || {};

  const name = pick(section, 'name', 'display_name') || pick(common, 'name');
  if (!name) return null;

  const typeRaw = pick(section, 'type') || pick(common, 'type') || 'Game';
  const typeMap = {
    Game: 'game', DLC: 'dlc', Demo: 'demo', Tool: 'tool', Music: 'soundtrack',
    Video: 'video', Application: 'app', Series: 'series', Mod: 'mod',
  };
  const type = typeMap[typeRaw] || 'game';

  const price = pick(section, 'price') || pick(common, 'price');
  let priceOverview = null;
  if (price && typeof price === 'object') {
    // appinfo 的价格结构与商店 API 的 price_overview 一致，金额单位是「分」。
    const final = typeof price.final === 'number'
      ? Math.round(price.final)
      : (typeof price.initial === 'number' ? Math.round(price.initial) : null);
    if (final !== null) {
      const initial = typeof price.initial === 'number' ? Math.round(price.initial) : final;
      priceOverview = {
        currency: price.currency || 'USD',
        initial,
        final,
        discount_percent: typeof price.discount_percent === 'number' ? price.discount_percent : 0,
      };
    }
  }

  const dlcMap = pick(section, 'dlcs') || pick(common, 'dlcs') || {};
  const dlcs = Object.entries(dlcMap)
    .filter(([id]) => /^\d+$/.test(id))
    .map(([id, value]) => ({ appid: Number(id), name: typeof value === 'string' ? value : '' }));

  const releaseDate = pick(extended, 'release_date.date', 'release_date') || null;
  const developers = pick(section, 'developer') || pick(extended, 'developer') || '';
  const publishers = pick(section, 'publisher') || pick(extended, 'publisher') || '';
  const description = pick(section, 'short_description') || pick(common, 'short_description') || '';
  const header = pick(extended, 'assets.0.header_image') || pick(common, 'header_image') || '';
  const background = pick(extended, 'assets.0.background') || pick(common, 'background') || '';
  const parent = pick(common, 'parent') || null;

  return {
    appid: Number(pick(root, 'appid') || 0),
    name: String(name),
    type,
    typeLabel: String(typeRaw),
    description: String(description),
    developer: String(developers),
    publisher: String(publishers),
    releaseDate: releaseDate ? String(releaseDate) : null,
    header,
    background,
    price: priceOverview,
    dlcs,
    parent: parent ? { appid: Number(parent), name: '' } : null,
  };
}

/* ------------------------------ 对外接口 ------------------------------ */
export async function fetchAppInfo(appid, { timeout = 12000 } = {}) {
  if (cmBlocked()) return null;
  const target = Number(appid);
  if (!Number.isInteger(target) || target <= 0) return null;

  let connection = null;
  try {
    connection = await connectCm(Math.min(timeout, 10000));
  } catch (error) {
    // 连不上就暂时不再尝试（10 分钟），把机会留给其它数据源。
    blockedUntil = Date.now() + 10 * 60 * 1000;
    console.warn('[appinfo] 无法连接 CM 服务器，已暂时停用:', error?.message || error);
    return null;
  }

  try {
    const received = [];
    connection.on((payload) => {
      const { messages } = cmSplit(payload);
      for (const message of messages) {
        if (message.type === EMsg.MULTI) {
          const { messages: nested } = cmSplit(message.payload);
          received.push(...nested);
        } else {
          received.push(message);
        }
      }
    });

    const hello = Buffer.concat([
      pbUint(1, 1),
      pbString(2, 'Steam Client'),
      pbString(3, '174'),
      pbUint(5, 2),
      pbUint(6, 0),
      pbUint(7, 19),
      pbBool(8, false),
      pbBytes(9, crypto.randomBytes(20)),
      pbUint(10, Math.floor(Date.now() / 1000)),
      pbUint(11, 0),
      pbUint(12, 0),
      pbBytes(14, Buffer.from([0, 0, 0, 0])),
    ]);
    connection.send(cmMessage(EMsg.CLIENT_HELLO, hello));

    const deadline = Date.now() + timeout;
    const logonDeadline = Date.now() + 6000;
    let logonDone = received.some((message) => message.type === EMsg.CLIENT_LOGON);
    while (!logonDone && Date.now() < logonDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      logonDone = received.some((message) => message.type === EMsg.CLIENT_LOGON);
    }
    if (!logonDone) {
      console.warn('[appinfo] CM 服务器未确认登录');
      return null;
    }

    const request = Buffer.concat([
      pbString(1, String(target)),
      pbBool(2, false),
      pbBool(3, false),
      pbUint(4, 0),
    ]);
    connection.send(cmMessage(EMsg.CLIENT_REQUEST_APPI_INFO, request));

    let payload = null;
    while (Date.now() < deadline) {
      const hit = received.find((message) => message.type === EMsg.CLIENT_APPI_INFO);
      if (hit) {
        const decoded = pbDecode(hit.payload);
        if (decoded[5]?.length) { payload = decoded[5]; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!payload) return null;

    const info = kvToAppInfo(parseKeyValues(payload));
    return info;
  } catch (error) {
    console.warn('[appinfo] 读取失败:', error?.message || error);
    return null;
  } finally {
    try { connection.close(); } catch { /* ignore */ }
  }
}

export function appInfoAvailable() {
  return !cmBlocked();
}
