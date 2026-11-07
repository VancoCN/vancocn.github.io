# BiliFetch · 粘贴 B 站链接，直接下载音频 / 视频

两个版本，按需选：

| | **默认版** `index.html` | **完整版** `full.html` |
| --- | --- | --- |
| 打开就能用 | ✅ 不用登录、不用填 token | ❌ 要粘一个 Personal Access Token |
| 解析速度 | 约 1 秒 | 30–90 秒（走一次 Actions） |
| 视频 | 单文件 MP4（含音轨），最高 **720P** | MP4，可到 1080P（配 cookie） |
| 音频 | M4A（AAC 原始码率） | **MP3**（ffmpeg 转码） |
| 额外依赖 | 一个几十行的 Cloudflare Worker（一次性部署） | GitHub Actions（仓库里已有） |
| 访客需要做什么 | 什么都不用做 | 每次换浏览器都要填 token |

---

## 默认版是怎么跑起来的

```
浏览器 (index.html, GitHub Pages)
  │  ① GET  <worker>/x/web-interface/view?bvid=…         ← Worker 补 Referer
  │  ② GET  <worker>/x/player/wbi/playurl?…              ← Worker 补 Referer，返回 JSON
  │  ③ <video src> / <a download> 直连 B 站 CDN         ← 不经过 Worker
  │  ④ 音频：MP4 里的音轨是 DASH 分片，必须带 Referer
  │        → 走 <worker>/stream?u=…&s=<HMAC>            ← 只代理这几 MB
  ▼
Cloudflare Worker（十几行，免费额度足够）
```

关键设计：**Worker 只转发几 KB 的 JSON 和几 MB 的音频，视频字节由浏览器直连 B 站 CDN。**
所以它不会被当成视频代理，带宽和免费额度都不成问题。

### 为什么绕不开这一个转发器

我把所有能想到的浏览器方案都实测过，结论是**纯静态页面做不到**：

| 请求 | 无 Referer | 外站 Referer | bilibili Referer |
| --- | --- | --- | --- |
| `view`（标题/封面/分P） | ✅ 200 | ✅ 200 | ✅ 200 |
| **`playurl`（取播放地址）** | ❌ 风控页 | ❌ 风控页 | ✅ 200 |
| DASH 音频流 | ❌ 403 | ❌ 403 | ✅ 206 |
| 单文件 MP4 | ✅ 206 | ✅ 206 | ✅ 206 |

`playurl` 强制校验 `Referer: https://www.bilibili.com/`，浏览器无法伪造这个请求头；
加 cookie（buvid3/buvid4）、换老接口、`--impersonate`、公共 CORS 代理，全部无效。
既然一定要有「浏览器之外的一跳」，那就让它尽量小 —— 这就是 `worker.js`。

---

## 部署转发器（一次性，约 2 分钟）

1. 打开 [Cloudflare 控制台 → Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
2. **Create → Worker**，随便起个名字（如 `bili-proxy`），**Deploy**
3. 点 **Edit code**，把仓库里 `worker.js` 的全文粘进去，**Deploy**
4. 复制分配给你的地址，形如 `https://bili-proxy.xxx.workers.dev`

然后把它写进 `index.html`：

```js
/* ==== 唯一需要改的地方 ==== */
var PROXY = 'https://bili-proxy.xxx.workers.dev';
```

临时测试不想改代码也行：打开页面时带 `?proxy=https://...`，或直接在页面顶部的输入框里填
（会存到 localStorage，但只对当前浏览器有效，访客仍需要上面那行）。

### 可选：解锁 720P 以上

Worker 的 **Settings → Variables and Secrets** 加一个 `BILI_COOKIE`，
值是浏览器里复制的完整 Cookie 头（需含 `SESSDATA`）。加了之后 Worker 转发时会带上它，
页面右上角会显示「已连接 · 带登录态」。

再可选：加 `SIGN_KEY`（随便一串长随机字符）作为 `/stream` 的 HMAC 密钥，不设置则用内置默认值。

---

## 完整版（GitHub Actions）

`full.html` 保留原来的方案：网页触发 `workflow_dispatch` → Actions 里跑 `scripts/bili.py`
→ 结果发布成 Release（tag = `dl-<job>`），页面轮询取回。
它能做 MP3、1080P（配 `BILI_COOKIE` secret）、更精细的分 P 处理，代价是慢和需要 token。

页面里需要填一次 Fine-grained token：只勾 `vancocn.github.io` 这一个仓库，
权限 `Actions: Read and write` + `Contents: Read`。

---

## 实测与限制

| 项 | 情况 |
| --- | --- |
| 默认版清晰度 | 单文件 MP4 固定锁在 **720P**（`platform=html5` 的上限），请求 qn=80/120 也只返回 64 |
| 默认版音频 | DASH 最高码率（常见 192k），存为 `.m4a`；要 MP3 用完整版 |
| 未登录 | 只给 360P / 480P 档位；720P 需 cookie（完整版同理） |
| 番剧 / 付费 / 直播 | 两条路都拿不到，会显示 B 站返回的错误 |
| 跨域 | 单文件 MP4 的 CDN 对外站 Referer 放行，浏览器可直接下载；DASH 音频不行，必须走 `/stream` |
| 音频 CDN | 会落到 `*.mountaintoys.cn` 这类 P2P 边缘节点，所以 `/stream` 不用域名白名单，改用 HMAC 签名防滥用 |
| Worker 免费额度 | 每天 10 万次请求，只有 JSON 和音频经过它，个人用远够 |

---

## 目录

```
bili-web-dl/index.html          默认版：打开即用（依赖 Worker）
bili-web-dl/full.html           完整版：GitHub Actions + token，支持 MP3 / 1080P
bili-web-dl/worker.js           Cloudflare Worker，补 Referer 的转发器
bili-web-dl/scripts/bili.py     完整版用：走 B 站 API 的解析与下载
bili-web-dl/scripts/publish.sh  完整版用：把结果发布成 Release
bili-web-dl/scripts/cleanup.py  完整版用：清理 24 小时前的 dl-* Release
.github/workflows/bili.yml      完整版的工作流（只 sparse-checkout bili-web-dl/）
```

## 本地调试

```bash
cd bili-web-dl
python -m http.server 8080
# 打开 http://127.0.0.1:8080/?proxy=http://127.0.0.1:8787
```

Worker 本地跑：把 `worker.js` 复制成 `.mjs`，写个 http 服务器把请求交给
`worker.fetch(request, env)` 即可（Node 22 自带 fetch/Request/Response/crypto.subtle）。
仓库里不带这个 shim，因为线上用不到。

## 免责声明

仅供个人学习、备份自己有权使用的内容。请遵守 B 站用户协议与著作权法，
不要用于二次分发或商业用途。
