#!/usr/bin/env python3
"""轮询 lowiro 公开 API，留档 Arcaea 的版本号与观测时间。

设计边界（务必保持）：
  * 只读取元数据 —— 版本号、APK 文件大小、Last-Modified
  * 不下载 APK 正文，不存储 APK，不记录带 token 的下载链接
  * 不触碰任何游戏资产（音乐、图片、剧情文本、logo）
有新版本时写回 versions.json / versions.js；无变化时保持文件不动，
以便 Actions 里用 git status 判断是否提交。
"""

import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

API = "https://webapi.lowiro.com/webapi/serve/static/bin/arcaea/apk"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_JSON = os.path.join(ROOT, "versions.json")
DATA_JS = os.path.join(ROOT, "versions.js")

TIMEOUT = 30
RETRIES = 3

# 检查日志最多保留多少条（每 6 小时一条，300 条约合 75 天）
MAX_CHECKS = 300


def _open(url, method="GET"):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=TIMEOUT)


def fetch_api():
    """拿版本号。带重试，全部失败才抛异常。"""
    last = None
    for i in range(RETRIES):
        try:
            with _open(API) as r:
                payload = json.load(r)
            if not payload.get("success"):
                raise RuntimeError("API 返回 success=false, error_code=%r" % payload.get("error_code"))
            value = payload["value"]
            return value["version"], value["url"]
        except Exception as e:  # noqa: BLE001
            last = e
            print("[warn] 第 %d 次请求失败: %s" % (i + 1, e), file=sys.stderr)
            if i + 1 < RETRIES:
                time.sleep(5)
    raise RuntimeError("API 请求连续失败: %s" % last)


def probe_meta(url):
    """只发 HEAD 探测体积和 Last-Modified，绝不读取正文。"""
    meta = {"size": None, "last_modified": None}
    try:
        with _open(url, "HEAD") as r:
            cl = r.headers.get("Content-Length")
            if cl and cl.isdigit():
                meta["size"] = int(cl)
            meta["last_modified"] = r.headers.get("Last-Modified")
    except Exception as e:  # noqa: BLE001
        # HEAD 被拒不影响主流程，体积只是锦上添花
        print("[warn] HEAD 探测失败（已忽略）: %s" % e, file=sys.stderr)
    return meta


def version_key(v):
    """把 '6.14.12c' 之类解析成可排序的元组。"""
    nums = re.findall(r"\d+", v or "")
    return tuple(int(n) for n in nums) if nums else (0,)


def load():
    if os.path.exists(DATA_JSON):
        with open(DATA_JSON, encoding="utf-8") as f:
            data = json.load(f)
        data.setdefault("checks", [])
        return data
    return {"latest": None, "updated_at": None, "history": [], "checks": []}


def append_check(data, status, version=None, message=None):
    """每次检查都留一条日志，无论有没有新版本、成功还是失败。"""
    entry = {
        "time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "status": status,  # new_version | unchanged | error
        "version": version,
    }
    if message:
        entry["message"] = message[:200]
    # 新条目插到最前：每次运行都是当前时刻，不必（也不该）依赖字符串比较排序——
    # sort 是稳定排序，同一秒内的两条会保持原顺序，把最新的挤到后面去。
    data.setdefault("checks", []).insert(0, entry)
    del data["checks"][MAX_CHECKS:]


def save(data):
    data["history"].sort(key=lambda e: version_key(e["version"]), reverse=True)
    data["latest"] = data["history"][0]["version"] if data["history"] else None
    data["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")

    with open(DATA_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    # 同时输出一份 JS，让页面在 file:// 下也能直接打开（避免 fetch 的 CORS 限制）
    with open(DATA_JS, "w", encoding="utf-8") as f:
        f.write("window.ARC_VERSIONS = ")
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write(";\n")


def human_size(n):
    if not n:
        return "—"
    step = 1024.0
    for unit in ("B", "KB", "MB", "GB"):
        if n < step or unit == "GB":
            return "%.1f %s" % (n, unit) if unit != "B" else "%d B" % n
        n /= step
    return "—"


def main():
    data = load()

    try:
        version, url = fetch_api()
    except Exception as e:  # noqa: BLE001
        # 失败也要留痕 —— 看不见失败，就不叫日志
        append_check(data, "error", None, str(e))
        save(data)
        print("[error] 接口请求失败，已记入日志: %s" % e, file=sys.stderr)
        return 0

    print("当前线上版本: %s" % version)

    if any(e["version"] == version for e in data["history"]):
        append_check(data, "unchanged", version)
        save(data)
        print("无变化，已记入日志。")
        return 0

    meta = probe_meta(url)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    data["history"].append({
        "version": version,
        "first_seen": now,
        "size": meta["size"],
        "size_human": human_size(meta["size"]),
        "last_modified": meta["last_modified"],
    })
    append_check(data, "new_version", version)
    save(data)
    print("已记录新版本: %s (首次观测 %s, 体积 %s)" % (version, now, human_size(meta["size"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
