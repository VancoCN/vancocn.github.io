# Arcaea 版本留档

自动轮询 lowiro 公开接口，把 Arcaea 的**版本号、观测时间、文件体积**留档成一个静态页面。

> 本项目**只收集事实性元数据**。不下载、不存储、不分发 APK 本体，不记录下载链接，
> 不包含任何游戏资产（音乐 / 图片 / 剧情文本 / logo）。详见下方「边界」一节。

## 怎么用

1. 建一个 GitHub 仓库，把这些文件推上去。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选 `Deploy from a branch`，
   分支 `main`、目录 `/ (root)`。保存后就能拿到公网地址。
3. **Actions** 标签页里手动点一次 `Check Arcaea version` → `Run workflow`，生成首条记录。
4. 之后每 6 小时自动跑一次。**每次运行都会往「检查日志」里追加一条并提交**，所以 Actions
   里会看到定期提交，不是只在有新版本时才动。

想改频率就编辑 `.github/workflows/check.yml` 里的 cron。

> **放到已有仓库的子目录时**（例如 `vancocn.github.io/arctracker/`）：GitHub Actions **只认仓库根目录的
> `.github/workflows/`**，子目录里的 workflow 文件不会被执行。所以要把 workflow 放到仓库根，
> 再用 `defaults.run.working-directory` 指回子目录——可参考 `arctracker-check.yml` 的写法。

## 文件说明

| 文件 | 作用 |
|---|---|
| `scripts/check.py` | 轮询接口、比对版本号、写回留档。只发 `HEAD` 探测体积，不读正文 |
| `.github/workflows/check.yml` | 定时执行 + 提交（每次都留日志，所以每次都会 commit） |
| `versions.json` | 留档数据本体：版本 `history` + 每次检查的 `checks` 日志 |
| `versions.js` | 同一份数据包装成 JS，让页面在 `file://` 下也能直接打开 |
| `index.html` | 展示页面 |
| `alfyt.ttf` | 页面字体 |

## 字体

页面用的是 **阿里巴巴方格体（Alimama FangYuanTi Medium）**——阿里官方发布的免费商用中文字体，
不是游戏资产，可以放心使用。约 2.6 MB，已用 `font-display: swap`，字体没加载完时先用系统字体顶上。

`@font-face` 里写了两个来源：先找同目录的 `alfyt.ttf`，找不到再退到上一级的 `../alfyt.ttf`。
这样既能作为独立项目部署，也能放进已有站点复用站级字体（省掉重复上传 2.6 MB）。
要换字体的话，替换字体文件并改 `index.html` 里 `@font-face` 的 `src`。

## 检查日志

每次工作流运行都会往 `versions.json` 的 `checks` 数组插一条记录，**不管有没有新版本、成功还是失败**：

| `status` | 含义 |
|---|---|
| `new_version` | 发现新版本，已写入 `history` |
| `unchanged` | 版本号没变 |
| `error` | 接口请求失败，错误信息记在 `message` 里 |

页面「检查日志」一栏显示最近 50 条；留档上限 300 条（约 75 天），超出的丢最旧的。
失败也留痕是有意的——只记录成功的话，接口挂了你从页面上完全看不出来。

> 实现细节：新条目直接 `insert(0, ...)` 到数组最前，不按时间字符串排序。
> 因为 Python 的 `sort` 是稳定排序，同一秒内的两条会保持原顺序，把最新的挤到后面去（实测踩过）。

## 边界（改动时请保持）

保持这些约束，项目才站得住：

- **不下载 APK 正文。** 体积用 `HEAD` 请求的 `Content-Length` 拿，不落盘。
  一旦加了 `sha256`，就意味着必须完整下载文件，性质就变了。
- **不记录下载直链。** 接口返回的 URL 带 `?token=` 且会失效，存下来就是死链；而且官方按地区
  决定是否提供 APK，公开直链等于绕过这层判断。页面只放一个官网入口，让官方自己处理。
  （`scripts/check.py` 里有一条断言专门防止 token 混进留档，改动时别删。）
- **不用官方 logo、不放游戏素材。** lowiro 的衍生作品政策明确禁止使用 logo 与游戏资产。
- **请求频率克制。** 每 6 小时一次、每次几十字节。别做分钟级轮询。

## 两个已知限制

- **GitHub Actions 的 cron 不保证准时**，高峰期可能延迟几十分钟甚至跳过。
  所以「首次观测时间」只是近似值，不代表官方发布时间。页面上也如实标注了这一点。
- **大陆 IP 会被 lowiro 屏蔽 APK 下载**。GitHub Actions 的 runner 在境外，正好绕开这个问题；
  如果你把这套脚本搬到国内服务器上跑，接口可能拿不到正常返回。
