// Steam appinfo（PICS / Content Server）客户端。
//
// Steam 的商店公开接口只提供「当前在售」的游戏数据；商店查不到的���戏
// （未公开、区域限制、预告片条目等）仍然留在 Steam 的应用数据库里，
// steamcmd 的 `app_info_print` 就是通过这个协议读取的。
//
// 本模块是纯 Node 实现（无第三方依赖），协议细节对照
// SteamRE/SteamKit2 与 DoctorMcKay/node-steam-user 的实现：
//   - 服务器列表：ISteamDirectory/GetCMListForConnect
//   - 传输：明文 TCP 27017，每帧为「长度 + "VT01" 魔数 + 数据」
//   - 通道加密：RSA-OAEP-SHA1 挑战应答 + NetFilter（AES-256-CBC + HMAC-SHA1）
//   - 业务协议：CMsgClientHello / 匿名 CMsgClientLogon / CMsgClientPICSProductInfoRequest
//   - 多消息打包：EMsg Multi（必要时 gzip 压缩）
//   - 资料格式：VDF 文本
//
// 如果运行环境无法连接 CM 服务器（例如被防火墙拦截），fetchAppInfo 会安静地
// 返回 null，不影响站点其它功能。

import net from 'node:net';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

/* ------------------------------ 常量 ------------------------------ */
const EMsg = {
  MULTI: 1,
  CHANNEL_ENCRYPT_REQUEST: 1303,
  CHANNEL_ENCRYPT_RESPONSE: 1304,
  CHANNEL_ENCRYPT_RESULT: 1305,
  CLIENT_HELLO: 9805,
  CLIENT_LOGON: 5514,
  CLIENT_LOGON_RESPONSE: 751,
  PICS_PRODUCT_INFO_REQUEST: 8903,
  PICS_PRODUCT_INFO_RESPONSE: 8904,
};

const PROTOCOL_VERSION = 65581;
const TCP_MAGIC = 0x31305456; // "VT01"，按小端读取得到的值
const PROTO_FLAG = 0x80000000;

// Steam 公共宇宙（Public universe）的 RSA-1024 公钥，DER / SubjectPublicKeyInfo。
// 取自 SteamRE/SteamKit2 的 KeyDictionary。
const STEAM_PUBLIC_KEY_DER = Buffer.from(
  '30819d300d06092a864886f70d010101050003818b0030818702818100dfec1ad62c10662c17353a14b07c59117f9dd3'
  + 'd82b7ae3e015cd191e46e87b8774a2184631a9031479828ee945a24912a923687389cf69a1b16146bdc1bebfd6011bd8'
  + '81d4dc90fbfe4f527366cb9570d7c58eba1c7a3375a1623446bb60b78068fa13a77a8a374b9ec6f45d5f3a99f99ec43a'
  + 'e963a2bb881928e0e714c04289020111',
  'hex',
);

// 官方 CM 服务器列表来自 ISteamDirectory/GetCMListForConnect（公开接口，无需密钥）。
// 其中 type=netfilter 的条目就是明文 TCP + Envelope 加密这套协议。
const CM_FALLBACK_ENDPOINTS = [
  'ext1-sea1.steamserver.net:27017',
  'ext1-fra1.steamserver.net:27017',
  'ext1-sfo1.steamserver.net:27017',
  'ext1-lhr1.steamserver.net:27017',
  'ext1-iad3.steamserver.net:27017',
  'ext1-syd1.steamserver.net:27017',
];
const CM_PORT = Number(process.env.STEAM_CM_PORT || 27017);

// 服务器列表变化很少，缓存一小时。
let cmEndpointsCache = null;
let cmEndpointsCachedAt = 0;

// 设为 1 时打印收发的原始报文，用于排查协议问题。
const TRACE = process.env.STEAM_APPINFO_TRACE === '1';

// 连续失败后暂停一段时间，避免每次查询都去等一次连接超时。
let blockedUntil = 0;

function cmBlocked() {
  return Date.now() < blockedUntil;
}

/* ------------------------------ Protobuf ------------------------------ */
function varint(value) {
  const bytes = [];
  let v = typeof value === 'bigint' ? value : BigInt(value >>> 0);
  v = BigInt.asUintN(64, v);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    bytes.push(byte);
  } while (v);
  return Buffer.from(bytes);
}

function pbVarint(field, value) {
  return Buffer.concat([varint((field << 3) | 0), varint(value)]);
}

function pbFixed64(field, value) {
  const body = Buffer.alloc(8);
  body.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([varint((field << 3) | 1), body]);
}

function pbBytes(field, value) {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
}

function pbString(field, value) {
  return pbBytes(field, Buffer.from(String(value), 'utf8'));
}

function pbBool(field, value) {
  return pbVarint(field, value ? 1 : 0);
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
      out[field] = buffer.readBigUInt64LE(offset);
      offset += 8;
    } else {
      break;
    }
  }
  return out;
}

// 收集 repeated 数值字段（非 packed 编码时每个值各占一个 varint）。
function pbCollectVarints(body, targetField) {
  const values = [];
  let offset = 0;
  while (offset < body.length) {
    let key = 0;
    let shift = 0;
    while (offset < body.length) {
      const byte = body[offset++];
      key |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      let value = 0;
      shift = 0;
      while (offset < body.length) {
        const byte = body[offset++];
        value |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) break;
        shift += 7;
      }
      if (field === targetField) values.push(value >>> 0);
    } else if (wire === 2) {
      let length = 0;
      shift = 0;
      while (offset < body.length) {
        const byte = body[offset++];
        length |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) break;
        shift += 7;
      }
      offset += length;
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  return values;
}

// 收集某个字段的全部「长度分隔」内容。repeated 字段在顶层会各占一组 tag+len，
// 不能简单地把它们合并成一个 Buffer 再解码。
function pbCollectField(body, targetField) {
  const items = [];
  let offset = 0;
  while (offset < body.length) {
    let key = 0;
    let shift = 0;
    while (offset < body.length) {
      const byte = body[offset++];
      key |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 2) {
      let length = 0;
      shift = 0;
      while (offset < body.length) {
        const byte = body[offset++];
        length |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) break;
        shift += 7;
      }
      const content = body.subarray(offset, offset + length);
      offset += length;
      if (field === targetField) items.push(content);
    } else if (wire === 0) {
      shift = 0;
      while (offset < body.length) {
        const byte = body[offset++];
        if (!(byte & 0x80)) break;
        shift += 7;
      }
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  return items;
}

// repeated 的数值字段是 packed varint 字节流
function pbDecodePacked(buffer) {
  const values = [];
  let offset = 0;
  let value = 0;
  let shift = 0;
  for (; offset < buffer.length; offset += 1) {
    const byte = buffer[offset];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) {
      values.push(value >>> 0);
      value = 0;
      shift = 0;
    } else {
      shift += 7;
    }
  }
  return values;
}

/* ------------------------------ VDF 文本 ------------------------------ */
// PICS 返回的资料是 VDF 文本（不是二进制 KeyValues），这里解析成对象树。
export function parseVdf(text) {
  let pos = 0;

  function skip() {
    for (;;) {
      while (pos < text.length && /\s/.test(text[pos])) pos += 1;
      if (text[pos] === '/' && text[pos + 1] === '/') {
        while (pos < text.length && text[pos] !== '\n') pos += 1;
        continue;
      }
      break;
    }
  }

  function readToken() {
    skip();
    if (text[pos] === '"') {
      pos += 1;
      let out = '';
      while (pos < text.length && text[pos] !== '"') {
        if (text[pos] === '\\' && pos + 1 < text.length) pos += 1;
        out += text[pos];
        pos += 1;
      }
      pos += 1;
      return out;
    }
    let out = '';
    while (pos < text.length && !/[\s{}"/]/.test(text[pos])) {
      out += text[pos];
      pos += 1;
    }
    return out;
  }

  function parseObject() {
    const result = {};
    for (;;) {
      skip();
      if (pos >= text.length) break;
      if (text[pos] === '}') { pos += 1; break; }
      const key = readToken();
      skip();
      if (text[pos] === '{') {
        pos += 1;
        result[key] = parseObject();
      } else {
        result[key] = readToken();
      }
    }
    return result;
  }

  skip();
  const rootKey = readToken();
  skip();
  let value = '';
  if (text[pos] === '{') {
    pos += 1;
    value = parseObject();
  } else {
    value = readToken();
  }
  return { key: rootKey, value };
}

/* ------------------------------ CRC32 ------------------------------ */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------ NetFilter 加密 ------------------------------ */
const IV_LENGTH = 16;
const IV_RANDOM_LENGTH = 3;

function hmacSha1(key, data) {
  return crypto.createHmac('sha1', key).update(data).digest();
}

class NetFilter {
  constructor(sessionKey) {
    this.sessionKey = sessionKey;
    this.hmacSecret = sessionKey.subarray(0, 16);
  }

  encrypt(plaintext) {
    const random = crypto.randomBytes(IV_RANDOM_LENGTH);
    const iv = Buffer.alloc(IV_LENGTH);
    const digest = hmacSha1(this.hmacSecret, Buffer.concat([random, plaintext]));
    digest.copy(iv, 0, 0, IV_LENGTH - IV_RANDOM_LENGTH);
    random.copy(iv, IV_LENGTH - IV_RANDOM_LENGTH);

    const ecb = crypto.createCipheriv('aes-256-ecb', this.sessionKey, null);
    ecb.setAutoPadding(false);
    const encryptedIv = Buffer.concat([ecb.update(iv), ecb.final()]);

    const cbc = crypto.createCipheriv('aes-256-cbc', this.sessionKey, iv);
    const encrypted = Buffer.concat([cbc.update(plaintext), cbc.final()]);
    return Buffer.concat([encryptedIv, encrypted]);
  }

  decrypt(data) {
    if (data.length < IV_LENGTH) throw new Error('数据包比初始化向量还短');
    const ecb = crypto.createDecipheriv('aes-256-ecb', this.sessionKey, null);
    ecb.setAutoPadding(false);
    const iv = Buffer.concat([ecb.update(data.subarray(0, IV_LENGTH)), ecb.final()]);

    const cbc = crypto.createDecipheriv('aes-256-cbc', this.sessionKey, iv);
    const plaintext = Buffer.concat([cbc.update(data.subarray(IV_LENGTH)), cbc.final()]);

    const digest = hmacSha1(this.hmacSecret, Buffer.concat([iv.subarray(IV_LENGTH - IV_RANDOM_LENGTH), plaintext]));
    if (!digest.subarray(0, IV_LENGTH - IV_RANDOM_LENGTH).equals(iv.subarray(0, IV_LENGTH - IV_RANDOM_LENGTH))) {
      throw new Error('HMAC 校验失败，数据包可能已损坏');
    }
    return plaintext;
  }
}

/* ------------------------------ 消息封装 ------------------------------ */
// TCP 帧：uint32 长度 + "VT01" + 数据
function tcpFrame(data) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length, 0);
  header.writeUInt32LE(TCP_MAGIC, 4);
  return Buffer.concat([header, data]);
}

// protobuf 消息：uint32 (EMsg|0x80000000) + uint32 头长度 + 头 protobuf + 体 protobuf
function protoMessage(msgType, headerBytes, bodyBytes) {
  const head = Buffer.alloc(8);
  head.writeUInt32LE((msgType | PROTO_FLAG) >>> 0, 0);
  head.writeUInt32LE(headerBytes.length, 4);
  return Buffer.concat([head, headerBytes, bodyBytes]);
}

// 结构体消息（MsgHdr，20 字节）：int32 EMsg + uint64 target + uint64 source
function structMessage(msgType, body) {
  const head = Buffer.alloc(20);
  head.writeInt32LE(msgType, 0);
  head.writeBigUInt64LE(0xffffffffffffffffn, 4);
  head.writeBigUInt64LE(0xffffffffffffffffn, 12);
  return Buffer.concat([head, body]);
}

function parsePacket(packet) {
  if (packet.length < 4) return null;
  const raw = packet.readUInt32LE(0);
  const msgType = raw & 0x7fffffff;
  if (raw & PROTO_FLAG) {
    if (packet.length < 8) return null;
    const headerLength = packet.readUInt32LE(4);
    if (packet.length < 8 + headerLength) return null;
    return {
      msgType,
      protobuf: true,
      header: pbDecode(packet.subarray(8, 8 + headerLength)),
      body: packet.subarray(8 + headerLength),
    };
  }
  if (packet.length < 20) return null;
  return {
    msgType,
    protobuf: false,
    targetJobId: packet.readBigUInt64LE(4),
    sourceJobId: packet.readBigUInt64LE(12),
    body: packet.subarray(20),
  };
}

/* ------------------------------ machine_id ------------------------------ */
// Steam 的匿名登录要求 machine_id 是一个格式完整的 MessageObject（KeyValues 二进制），
// 结构为 "MessageObject" { "BB3" <sha1> "FF2" <sha1> "3B3" <sha1> }。
// 缺少它（或格式不对）时服务器会返回 ClientServerUnavailable。
function buildMachineId() {
  const seed = crypto.randomBytes(16);
  const sha1Hex = (label) => crypto.createHash('sha1').update(Buffer.concat([seed, Buffer.from(label)])).digest('hex');

  const entry = (key, value) => Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from(key, 'utf8'), Buffer.from([0]),
    Buffer.from(value, 'utf8'), Buffer.from([0]),
  ]);

  return Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from('MessageObject', 'utf8'), Buffer.from([0]),
    entry('BB3', sha1Hex('guid')),
    entry('FF2', sha1Hex('mac')),
    entry('3B3', sha1Hex('disk')),
    Buffer.from([0x08]),
    Buffer.from([0x08]),
  ]);
}

/* ------------------------------ Multi 解包 ------------------------------ */
// CM 服务器会把多条消息打包进一条 Multi（EMsg 1）里发送，
// 其中 message_body 是若干条完整 CM 消息的拼接，必要时还会用 gzip 压缩。
function unwrapMulti(body) {
  const fields = pbDecode(body);
  const sizeUnzipped = fields[1] || 0;
  let payload = fields[2];
  if (TRACE) {
    console.log(`[appinfo:trace] Multi 字段: size_unzipped=${sizeUnzipped} body长度=${payload ? payload.length : 0} 前缀=${payload ? payload.subarray(0, 32).toString('hex') : ''}`);
  }
  if (!payload || !payload.length) return [];
  if (sizeUnzipped > 0) {
    try {
      payload = zlib.gunzipSync(payload);
    } catch {
      return [];
    }
  }
  const messages = [];
  let offset = 0;
  while (offset + 4 <= payload.length) {
    const size = payload.readInt32LE(offset);
    offset += 4;
    if (size <= 0 || offset + size > payload.length) break;
    const parsed = parsePacket(payload.subarray(offset, offset + size));
    offset += size;
    if (parsed) messages.push(parsed);
  }
  return messages;
}

/* ------------------------------ 连接 ------------------------------ */
class CmConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.encryption = null;
    // 加密通道建立完成的回调（在收到 ChannelEncryptResult 的那一帧立刻切换，
    // 避免明文/密文边界上的竞态）。
    this.switchEncryption = null;
    this.messages = [];
    this.waiters = [];
    this.closed = false;

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => this.onClose());
    socket.on('close', () => this.onClose());
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 8) break;
      const length = this.buffer.readUInt32LE(0);
      const magic = this.buffer.readUInt32LE(4);
      if (magic !== TCP_MAGIC) {
        this.onClose();
        return;
      }
      if (this.buffer.length < 8 + length) break;
      let payload = this.buffer.subarray(8, 8 + length);
      this.buffer = this.buffer.subarray(8 + length);
      if (this.encryption) {
        try {
          payload = this.encryption.decrypt(payload);
        } catch (error) {
          if (TRACE) console.log('[appinfo:trace] 解密失败:', error.message);
          this.onClose();
          return;
        }
      }
      const parsed = parsePacket(payload);
      if (TRACE) {
        const preview = payload.subarray(0, 48).toString('hex');
        console.log(`[appinfo:trace] 收到 ${payload.length} 字节: ${preview}${parsed ? ` | EMsg=${parsed.msgType}${parsed.protobuf ? '(proto)' : '(struct)'}` : ' | 解析失败'}`);
        if (parsed && parsed.msgType === 5500) {
          const body = parsed.body;
          console.log(`[appinfo:trace]   ClientServerUnavailable: EMsgSent=${body.readUInt32LE(8)} 类型=${body.readInt32LE(12)}`);
        }
      }
      // ChannelEncryptResult 本身仍是明文，收到之后才切换到密文。
      if (parsed && parsed.msgType === EMsg.CHANNEL_ENCRYPT_RESULT && this.switchEncryption) {
        const switcher = this.switchEncryption;
        this.switchEncryption = null;
        switcher();
      }
      // Multi（EMsg 1）里打包了若干条消息，展开后一并处理。
      if (parsed && parsed.msgType === EMsg.MULTI) {
        for (const inner of unwrapMulti(parsed.body)) {
          this.messages.push(inner);
        }
        this.flushWaiters();
        continue;
      }
      if (parsed) {
        this.messages.push(parsed);
        this.flushWaiters();
      }
    }
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    this.flushWaiters();
  }

  flushWaiters() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  send(data) {
    if (this.closed) throw new Error('连接已关闭');
    if (TRACE) console.log(`[appinfo:trace] 发送 ${data.length} 字节: ${data.subarray(0, 48).toString('hex')}`);
    const payload = this.encryption ? this.encryption.encrypt(data) : data;
    this.socket.write(tcpFrame(payload));
  }

  async waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.messages.find(predicate);
      if (hit) {
        this.messages = this.messages.filter((message) => message !== hit);
        return hit;
      }
      if (this.closed) return null;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
}

function connectCm(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(new CmConnection(socket));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/* ------------------------------ 服务器列表 ------------------------------ */
async function getCmEndpoints() {
  if (cmEndpointsCache && Date.now() - cmEndpointsCachedAt < 60 * 60 * 1000) return cmEndpointsCache;

  const endpoints = [];
  try {
    // 不同 cellid 对应不同机房，多取几个以便就近连接。
    for (const cellid of [0, 1, 4]) {
      const url = `https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=${cellid}&maxcount=40`;
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const json = await response.json();
      for (const server of json?.response?.serverlist || []) {
        if (server.type !== 'netfilter' || !server.endpoint) continue;
        endpoints.push(server.endpoint);
      }
    }
  } catch { /* 取不到列表就退回内置列表 */ }

  const seen = new Set();
  const all = [...endpoints, ...CM_FALLBACK_ENDPOINTS];
  const result = [];
  for (const endpoint of all) {
    if (seen.has(endpoint)) continue;
    seen.add(endpoint);
    const [host, port] = endpoint.split(':');
    result.push({ host, port: Number(port) || CM_PORT });
  }
  cmEndpointsCache = result;
  cmEndpointsCachedAt = Date.now();
  return result;
}

/* ------------------------------ 握手 ------------------------------ */
async function negotiateEncryption(connection) {
  const request = await connection.waitFor((m) => m.msgType === EMsg.CHANNEL_ENCRYPT_REQUEST, 10000);
  if (!request) throw new Error('CM 服务器没有发送加密请求');

  // body: uint32 protocolVersion + uint32 universe；其后是挑战数据
  const challenge = request.body.subarray(8);
  if (challenge.length < 16) throw new Error('加密挑战数据过短');

  const sessionKey = crypto.randomBytes(32);
  const blob = Buffer.concat([sessionKey, challenge]);
  const encryptedBlob = crypto.publicEncrypt(
    { key: STEAM_PUBLIC_KEY_DER, format: 'der', type: 'spki', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    blob,
  );

  const body = Buffer.alloc(8);
  body.writeUInt32LE(1, 0); // protocol version
  body.writeUInt32LE(128, 4); // key size
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32LE(crc32(encryptedBlob), 0);
  const trailer = Buffer.alloc(4);

  connection.send(structMessage(EMsg.CHANNEL_ENCRYPT_RESPONSE, Buffer.concat([body, encryptedBlob, checksum, trailer])));
  // 收到 ChannelEncryptResult 之后再切换到密文（结果本身是明文）。
  connection.switchEncryption = () => { connection.encryption = new NetFilter(sessionKey); };

  const result = await connection.waitFor((m) => m.msgType === EMsg.CHANNEL_ENCRYPT_RESULT, 10000);
  if (!result) throw new Error('CM 服务器没有确认加密通道');
  const eresult = result.body.readInt32LE(0);
  // Steam 的 EResult：1 = OK
  if (eresult !== 1) throw new Error(`加密通道建立失败（eresult=${eresult}）`);
  return sessionKey;
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
  const root = kv?.value?.appinfo || kv?.value || {};
  const common = root.common || {};
  const extended = root.extended || {};
  const section = extended.section || {};

  const name = pick(section, 'name') || pick(common, 'name');
  if (!name) return null;

  const typeRaw = pick(section, 'type') || pick(common, 'type') || 'Game';
  const typeMap = {
    Game: 'game', DLC: 'dlc', Demo: 'demo', Tool: 'tool', Music: 'soundtrack',
    Video: 'video', Application: 'app', Series: 'series', Mod: 'mod',
  };
  const type = typeMap[typeRaw] || 'game';

  // 名称可能带多语言版本
  const localized = common.name_localized || {};
  const localizedName = localized.schinese || localized.tchinese || localized.english || '';

  // 发售时间：新版资料里是 Unix 时间戳
  let releaseDate = pick(section, 'release_date.date', 'release_date') || null;
  if (!releaseDate) {
    const stamp = Number(common.steam_release_date);
    if (Number.isFinite(stamp) && stamp > 0) {
      releaseDate = new Date(stamp * 1000).toISOString().slice(0, 10);
    }
  }

  const developers = pick(section, 'developer') || pick(extended, 'developer') || '';
  const publishers = pick(section, 'publisher') || pick(extended, 'publisher') || '';
  const description = pick(section, 'short_description') || pick(common, 'short_description') || '';

  // 头图：资料里只有文件名，完整地址需要拼 CDN
  const headerFile = pick(common, 'header_image.english') || pick(common, 'header_image.schinese') || '';
  const header = headerFile && !headerFile.startsWith('http')
    ? `https://cdn.akamai.steamstatic.com/steam/apps/${Number(pick(root, 'appid') || 0)}/${headerFile}`
    : headerFile;

  // DLC：新版资料是一串逗号分隔的 App ID
  const dlcMap = pick(section, 'dlcs') || pick(common, 'dlcs') || {};
  const dlcs = [];
  if (dlcMap && typeof dlcMap === 'object') {
    for (const [id, value] of Object.entries(dlcMap)) {
      if (/^\d+$/.test(id)) dlcs.push({ appid: Number(id), name: typeof value === 'string' ? value : '' });
    }
  }
  const dlcList = pick(extended, 'listofdlc') || pick(common, 'listofdlc') || '';
  if (typeof dlcList === 'string' && dlcList.trim()) {
    for (const id of dlcList.split(',')) {
      const trimmed = id.trim();
      if (/^\d+$/.test(trimmed)) dlcs.push({ appid: Number(trimmed), name: '' });
    }
  }

  const parent = pick(common, 'parent') || pick(section, 'parent') || null;

  return {
    appid: Number(pick(root, 'appid') || 0),
    name: String(name),
    localizedName: String(localizedName),
    type,
    typeLabel: String(typeRaw),
    description: String(description),
    developer: String(developers),
    publisher: String(publishers),
    releaseDate: releaseDate ? String(releaseDate) : null,
    header,
    background: '',
    price: null,
    dlcs,
    parent: parent ? { appid: Number(parent), name: '' } : null,
  };
}

/* ------------------------------ 对外接口 ------------------------------ */
export async function fetchAppInfo(appid, { timeout = 20000 } = {}) {
  if (cmBlocked()) return null;
  const target = Number(appid);
  if (!Number.isInteger(target) || target <= 0) return null;

  let connection = null;
  let lastError = null;
  for (const endpoint of await getCmEndpoints()) {
    let attempt = null;
    try {
      attempt = await connectCm(endpoint.host, endpoint.port, Math.min(timeout, 8000));
      await negotiateEncryption(attempt);
      connection = attempt;
      break;
    } catch (error) {
      lastError = error;
      try { attempt?.socket.destroy(); } catch { /* ignore */ }
    }
  }
  if (!connection) {
    blockedUntil = Date.now() + 10 * 60 * 1000;
    console.warn('[appinfo] 无法连接任何 CM 服务器，已暂时停用:', lastError?.message || lastError);
    return null;
  }

  try {
    // SteamKit 对 Hello / Logon 不设置 job id（保持默认值 0xFFFFFFFFFFFFFFFF），
    // 只有 PICS 请求才带一个随机 job id 用于匹配回应。
    const defaultHeader = Buffer.concat([
      pbFixed64(1, 0n), // steamid
      pbVarint(2, 0), // client_sessionid
      pbVarint(3, 0), // routing_appid
      pbFixed64(10, 0xffffffffffffffffn), // jobid_source
      pbFixed64(11, 0xffffffffffffffffn), // jobid_target
    ]);

    // CMsgClientHello
    const helloBody = pbVarint(1, PROTOCOL_VERSION);
    connection.send(protoMessage(EMsg.CLIENT_HELLO, defaultHeader, helloBody));

    // CMsgClientLogon（匿名登录）
    // 参数参照 node-steam-user 的匿名登录：ProtoHeader.steamid 填匿名 SteamID，
    // 匿名标记放在 anon_user_target_account_name，且不携带 machine_id。
    const anonSteamId = (1n << 56n) | (10n << 52n);
    const logonHeader = Buffer.concat([
      pbFixed64(1, anonSteamId), // steamid
      pbVarint(2, 0), // client_sessionid
      pbVarint(3, 0), // routing_appid
      pbFixed64(10, 0xffffffffffffffffn), // jobid_source
      pbFixed64(11, 0xffffffffffffffffn), // jobid_target
    ]);
    const logonBody = Buffer.concat([
      pbVarint(1, PROTOCOL_VERSION),
      pbVarint(3, 0), // cell_id
      pbString(6, ''), // client_language
      pbVarint(7, 16), // client_os_type（EOSType.Windows10）
      pbBool(8, false), // should_remember_password
      pbString(80, 'anonymous'), // anon_user_target_account_name：匿名登录标记
      pbString(96, ''), // machine_name
      pbBool(102, false), // supports_rate_limit_response
    ]);
    connection.send(protoMessage(EMsg.CLIENT_LOGON, logonHeader, logonBody));

    const logonResponse = await connection.waitFor((m) => m.msgType === EMsg.CLIENT_LOGON_RESPONSE, 10000);
    if (!logonResponse) {
      console.warn('[appinfo] 匿名登录没有收到回应');
      return null;
    }
    const logonFields = pbDecode(logonResponse.body);
    if (TRACE) console.log(`[appinfo:trace] 登录回应字段: ${JSON.stringify(Object.fromEntries(Object.entries(logonFields).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : (Buffer.isBuffer(v) ? v.toString('hex') : v)])))}`);
    const eresult = logonFields[1];
    if (eresult !== 1 && TRACE) {
      console.warn(`[appinfo] 匿名登录返回 eresult=${eresult}（继续尝试 PICS）`);
    }

    // 登录成功后，后续消息要带上服务器分配的会话 ID 与 SteamID。
    const sessionId = Number(logonResponse.header?.[2] || 0);
    const loggedSteamId = logonResponse.header?.[1] ?? 0n;
    if (TRACE) console.log(`[appinfo:trace] 会话 ID=${sessionId} steamid=${loggedSteamId}`);

    // CMsgClientPICSProductInfoRequest
    const picsJobId = (BigInt.asUintN(63, crypto.randomBytes(8).readBigUInt64LE())) | 1n;
    const picsHeader = Buffer.concat([
      pbFixed64(1, loggedSteamId),
      pbVarint(2, sessionId),
      pbVarint(3, 0),
      pbFixed64(10, picsJobId),
      pbFixed64(11, 0xffffffffffffffffn),
    ]);
    const appEntry = Buffer.concat([
      pbVarint(1, target), // appid
      pbBool(3, false), // only_public_obsolete
    ]);
    const picsBody = Buffer.concat([
      pbBytes(2, appEntry), // apps
      pbBool(3, false), // meta_data_only
    ]);
    connection.send(protoMessage(EMsg.PICS_PRODUCT_INFO_REQUEST, picsHeader, picsBody));
    if (TRACE) console.log(`[appinfo:trace] PICS 请求体: ${picsBody.toString('hex')}`);

    const response = await connection.waitFor((m) => m.msgType === EMsg.PICS_PRODUCT_INFO_RESPONSE, 12000);
    if (!response) {
      console.warn(`[appinfo] ${target} 没有收到 PICS 回应`);
      return null;
    }

    const appChunks = pbCollectField(response.body, 1);
    const unknown = [
      ...pbCollectVarints(response.body, 2),
      ...pbCollectField(response.body, 2).flatMap((chunk) => pbDecodePacked(chunk)),
    ];
    if (TRACE) {
      console.log(`[appinfo:trace] PICS 回应体(${response.body.length}): ${response.body.subarray(0, 48).toString('hex')}`);
      console.log(`[appinfo:trace] PICS 条目数=${appChunks.length} 未知=${unknown.join(',') || '无'}`);
    }
    if (!appChunks.length) {
      console.warn(`[appinfo] ${target} PICS 未返回资料（未知 appid：${unknown.join(',') || '无'}）`);
      return null;
    }
    for (const chunk of appChunks) {
      const info = pbDecode(chunk);
      const buffer = info[5];
      if (TRACE) console.log(`[appinfo:trace] AppInfo 字段: ${Object.entries(info).map(([k, v]) => `${k}=${Buffer.isBuffer(v) ? `buf(${v.length})` : String(v)}`).join(' ')}`);
      if (!buffer?.length) continue;
      let parsed = null;
      try {
        const text = buffer.toString('utf8').replace(/\0+$/, '');
        parsed = kvToAppInfo(parseVdf(text));
      } catch (error) {
        console.warn('[appinfo] VDF 解析失败:', error?.message || error);
        continue;
      }
      if (parsed) {
        parsed.appid = parsed.appid || target;
        return parsed;
      }
    }
    return null;
  } catch (error) {
    console.warn('[appinfo] 读取失败:', error?.message || error);
    return null;
  } finally {
    try { connection?.socket.destroy(); } catch { /* ignore */ }
  }
}

export function appInfoAvailable() {
  return !cmBlocked();
}
