# Arcaea 版本留档

自动轮询 lowiro 公开接口，把 Arcaea 的**版本号、观测时间、文件体积**留档成一个静态页面。

> 本项目**只收集事实性元数据**。不下载、不存储、不分发 APK 本体——页面上的下载按钮是
> **指向官方 CDN 的链接**，点击是直接从 lowiro 服务器取文件，不经过本站。
> 不包含任何游戏资产（音乐 / 图片 / 剧情文本 / logo）。详见下方「边界」一节。

## 怎么用

1. 建一个 GitHub 仓库，把这些文件推上去。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选 `Deploy from a branch`，
   分支 `main`、目录 `/ (root)`。保存后就能拿到公网地址。
3. **Actions** 标签页里手动点一次 `Check Arcaea version` → `Run workflow`，生成首条记录。
4. 之后每天自动跑 7 次（北京时间 07:50 / 08:00 / 08:15 / 08:30 / 08:45 / 14:17 / 20:17）。
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

## 检查日志

每次工作流运行都会往 `versions.json` 的 `checks` 数组插一条记录，**不管有没有新版本、成功还是失败**：

| `status` | 含义 |
|---|---|
| `new_version` | 发现新版本，已写入 `history` |
| `unchanged` | 版本号没变（但会顺手刷新直链） |
| `error` | 接口请求失败，错误信息记在 `message` 里 |

每条日志还带一个 `url`，是**本次检查时接口返回的那个链接**，只作留档、不关心它过不过期
（请求失败时为空）。下载按钮**不用**它，始终取最新版本那条——那条每次运行都会刷新。

- 日志上限 **300 条**（约 75 天），超出后**从最早的开始删**；
- **版本历史 `history` 不设上限**，观测到的每个版本都一直留着。

页面「检查日志」一栏默认只占 **约 10 行高度**，更早的记录滚动查看（表头吸顶，底部渐隐提示还有内容）。失败也留痕是有意的——只记录成功的话，接口挂了从页面上看不出来。

> 实现细节：新条目直接 `insert(0, ...)` 到数组最前，不按时间字符串排序。
> 因为 Python 的 `sort` 是稳定排序，同一秒内的两条会保持原顺序，把最新的挤到后面去（实测踩过）。

- **GitHub Actions 的 cron 不保证准时**，高峰期可能延迟几十分钟甚至跳过。
  所以「首次观测时间」只是近似值，不代表官方发布时间。页面上也如实标注了这一点。
- **大陆 IP 会被 lowiro 屏蔽 APK 下载**。GitHub Actions 的 runner 在境外，正好绕开这个问题；
  如果你把这套脚本搬到国内服务器上跑，接口可能拿不到正常返回。
