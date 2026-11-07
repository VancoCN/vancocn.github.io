/**
 * bili-proxy —— 给 B 站接口补上 Referer 的极小代理（Cloudflare Worker）
 *
 * 为什么需要它：api.bilibili.com 的 playurl 接口强制校验
 * `Referer: https://www.bilibili.com/`，浏览器无法伪造该请求头，
 * 纯前端页面因此拿不到播放地址。这个 Worker 只做一件事：转发 API 请求并补上 Referer。
 *
 * 刻意不转发视频字节：/playurl 只返回几 KB 的 JSON，视频 mp4 由浏览器直接向
 * B 站 CDN 下载（实测单文件 mp4 对外站 Referer 放行）。
 * 只有音频流需要经过 /stream，因为音频是 DASH 分片、同样校验 Referer；
 * 这个体积很小（几 MB），不构成带宽压力。
 *
 * /stream 不做域名白名单，改用 HMAC 签名：只放行本 Worker 自己签发出去的地址，
 * 既能挡住被当成通用代理滥用，也不用维护 B 站那些随时会变的 CDN 域名
 * （实测音频会落到 *.mountaintoys.cn 这类 P2P 边缘节点）。
 *
 * 可选环境变量：
 *   BILI_COOKIE  浏览器 Cookie 头原文（含 SESSDATA），可解锁 720P 以上
 *   SIGN_KEY     签名密钥，随便一串长随机字符串；不设置则用内置默认值
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const API_ORIGIN = 'https://api.bilibili.com';

/** 只放行这几个只读接口，避免被当成通用代理刷 */
const ALLOWED_PATHS = new Set([
  '/x/web-interface/view',
  '/x/player/wbi/playurl',
  '/x/player/playurl',
  '/x/player/wbi/v2',
  '/x/web-interface/nav',
]);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,OPTIONS',
  'access-control-allow-headers': 'Range,Content-Type,Accept',
  'access-control-expose-headers':
    'Content-Length,Content-Range,Accept-Ranges,Content-Type',
  'access-control-max-age': '86400',
};

const enc = new TextEncoder();

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
  });
}

/* ---------- 签名：让 /stream 只接受本 Worker 签发的地址 ---------- */

async function keyOf(env) {
  const raw = env.SIGN_KEY || 'bili-proxy-v1-default-key';
  return crypto.subtle.importKey('raw', enc.encode(raw),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(target, env) {
  const sig = await crypto.subtle.sign('HMAC', await keyOf(env), enc.encode(target));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    .slice(0, 22);
}

function toProxy(origin, target, sig) {
  return origin + '/stream?u=' + encodeURIComponent(target) + '&s=' + sig;
}

/** 把 playurl 返回里的音频地址改写成本 Worker 的 /stream 地址 */
async function rewriteAudio(payload, origin, env) {
  const data = payload && payload.data;
  const dash = data && data.dash;
  if (!dash) return payload;

  const lists = [dash.audio || [], dash.dolby ? dash.dolby.audio || [] : [], dash.flac ? [dash.flac] : []];
  for (const list of lists) {
    for (const item of list) {
      if (!item) continue;
      const primary = item.baseUrl || item.base_url;
      if (primary) {
        const sig = await sign(primary, env);
        item.baseUrl = toProxy(origin, primary, sig);
        item.base_url = item.baseUrl;
      }
      const backups = item.backupUrl || item.backup_url || [];
      if (backups.length) {
        const signed = [];
        for (const u of backups) signed.push(toProxy(origin, u, await sign(u, env)));
        item.backupUrl = signed;
        item.backup_url = signed;
      }
    }
  }
  return payload;
}

/* ---------- 转发 ---------- */

async function proxyApi(url, request, env) {
  const target = API_ORIGIN + url.pathname + url.search;
  const headers = {
    'user-agent': UA,
    referer: 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
    accept: 'application/json, text/plain, */*',
  };
  if (env.BILI_COOKIE) headers.cookie = env.BILI_COOKIE;

  const upstream = await fetch(target, {
    headers,
    cf: { cacheTtl: 30, cacheEverything: true },
  });

  if (url.pathname.indexOf('playurl') < 0) {
    const out = new Headers(CORS);
    out.set('content-type', 'application/json; charset=utf-8');
    out.set('cache-control', 'no-store');
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: out });
  }

  let payload;
  try {
    payload = JSON.parse(await upstream.text());
  } catch {
    return text('upstream returned non-JSON', 502);
  }
  payload = await rewriteAudio(payload, url.origin, env);
  const out = new Headers(CORS);
  out.set('content-type', 'application/json; charset=utf-8');
  out.set('cache-control', 'no-store');
  return new Response(JSON.stringify(payload), { status: upstream.status, headers: out });
}

async function streamMedia(url, request, env) {
  const raw = url.searchParams.get('u');
  const sig = url.searchParams.get('s');
  if (!raw || !sig) return text('missing u/s', 400);

  let target;
  try {
    target = new URL(raw);
  } catch {
    return text('bad u', 400);
  }
  if (!/^https?:$/.test(target.protocol)) return text('bad protocol', 400);

  const expect = await sign(raw, env);
  if (expect !== sig) return text('signature mismatch', 403);

  const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/' };
  const range = request.headers.get('range');
  if (range) headers.range = range;

  const upstream = await fetch(target.toString(), { headers });

  const out = new Headers(CORS);
  for (const h of ['content-type', 'content-length', 'content-range',
                   'accept-ranges', 'etag', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        ok: true,
        service: 'bili-proxy',
        cookie: Boolean(env.BILI_COOKIE),
        time: new Date().toISOString(),
      });
    }

    try {
      if (url.pathname === '/stream') return await streamMedia(url, request, env);
      if (!ALLOWED_PATHS.has(url.pathname)) return text('path not allowed', 403);
      return await proxyApi(url, request, env);
    } catch (err) {
      return text('proxy error: ' + (err && err.message ? err.message : err), 502);
    }
  },
};
