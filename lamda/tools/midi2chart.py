#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""midi2chart.py — 把 .mid 转成 Lamda 的游戏谱面（charts/<id>.js）。

用法:
    python tools/midi2chart.py "F:/MSC乐谱/badapple!.mid"
    python tools/midi2chart.py song.mid --title "Bad Apple!!" --artist "Touhou"
    python tools/midi2chart.py song.mid --player 1        # 指定玩家音轨（0 起）
    python tools/midi2chart.py song.mid --orig            # 标记为原创曲
    python tools/midi2chart.py --reindex                  # 只重建 charts/index.js

产物:
    charts/<id>.js      谱面（<script> 可直接加载，无需服务器）
    charts/index.js     曲目清单（自动重建）

曲绘：把图片放到 covers/<id>.jpg|png|jpeg|webp，转换时会自动识别并写进谱面。
"""
import argparse
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHART_DIR = ROOT / "charts"
COVER_DIR = ROOT / "covers"
CHORD_WIN = 0.028          # 同时按下的判定窗（秒）

try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass


# --------------------------------------------------------------------------- MIDI
def _read_text(b: bytes) -> str:
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("latin-1", "replace")


class Reader:
    def __init__(self, data: bytes):
        self.d = data
        self.p = 0

    def u8(self) -> int:
        v = self.d[self.p]
        self.p += 1
        return v

    def u16(self) -> int:
        v = (self.d[self.p] << 8) | self.d[self.p + 1]
        self.p += 2
        return v

    def u32(self) -> int:
        v = int.from_bytes(self.d[self.p:self.p + 4], "big")
        self.p += 4
        return v

    def vlq(self) -> int:
        v = 0
        while True:
            b = self.d[self.p]
            self.p += 1
            v = (v << 7) | (b & 0x7F)
            if not (b & 0x80):
                return v


def parse_midi(raw: bytes):
    if len(raw) < 14 or raw[:4] != b"MThd":
        raise ValueError("不是有效的 MIDI 文件")

    r = Reader(raw)
    r.p = 4
    hlen = r.u32()
    fmt = r.u16()
    ntrk = r.u16()
    division = r.u16()
    r.p = 8 + hlen
    tpb = 480 if division & 0x8000 else (division or 480)

    raw_tracks = []
    tempos = [(0, 500000)]
    max_tick = 0

    for _ in range(ntrk):
        if r.p + 8 > len(raw):
            break
        r.p += 4                       # 'MTrk'
        length = r.u32()
        end = min(r.p + length, len(raw))
        tick = 0
        status = 0
        name = ""
        evs = []
        while r.p < end:
            tick += r.vlq()
            max_tick = max(max_tick, tick)
            b = r.d[r.p]
            if b < 0x80:
                st = status
            else:
                r.p += 1
                st = b
                status = st
            kind = st & 0xF0

            if st == 0xFF:
                mt = r.u8()
                ml = r.vlq()
                data = r.d[r.p:r.p + ml]
                r.p += ml
                if mt == 0x51 and ml >= 3:
                    tempos.append((tick, (data[0] << 16) | (data[1] << 8) | data[2]))
                elif mt == 0x03 and not name:
                    name = _read_text(data).strip()
            elif st in (0xF0, 0xF7):
                r.p += r.vlq()
            elif kind in (0x90, 0x80):
                note = r.u8()
                vel = r.u8()
                evs.append((tick, kind == 0x90 and vel > 0, note, vel, st & 0x0F))
            elif kind in (0xC0, 0xD0):
                r.p += 1
            else:
                r.p += 2
        r.p = end
        raw_tracks.append((name, evs))

    if not raw_tracks:
        raise ValueError("MIDI 里没有音轨")

    # tempo map -> 秒
    tempos.sort(key=lambda x: x[0])
    segs = []
    for tk, us in tempos:
        if segs and segs[-1][0] == tk:
            segs[-1][1] = us
        else:
            segs.append([tk, us, 0.0])
    for i in range(1, len(segs)):
        ptk, pus, psec = segs[i - 1]
        segs[i][2] = psec + (segs[i][0] - ptk) / tpb * (pus / 1e6)

    def to_sec(tk: int) -> float:
        lo, hi, k = 0, len(segs) - 1, 0
        while lo <= hi:
            m = (lo + hi) // 2
            if segs[m][0] <= tk:
                k = m
                lo = m + 1
            else:
                hi = m - 1
        tk0, us, sec = segs[k]
        return sec + (tk - tk0) / tpb * (us / 1e6)

    tracks = []
    for name, evs in raw_tracks:
        open_notes = {}
        notes = []
        chans = set()
        for tick, is_on, note, vel, ch in evs:
            chans.add(ch)
            key = ch * 128 + note
            if is_on:
                open_notes.setdefault(key, []).append((tick, vel))
            else:
                q = open_notes.get(key)
                if q:
                    tk0, v0 = q.pop(0)
                    notes.append((to_sec(tk0), to_sec(tick), note, v0))
        for key, q in open_notes.items():
            for tk0, v0 in q:
                notes.append((to_sec(tk0), to_sec(tk0) + 0.4, key % 128, v0))
        notes.sort(key=lambda n: n[0])
        tracks.append({
            "name": name,
            "drum": 9 in chans,
            "notes": notes,
        })

    tempo = []
    for tk, us, sec in segs:
        spb = us / 1e6
        if tempo and abs(tempo[-1][1] - spb) < 1e-9:
            continue
        tempo.append([round(sec, 4), round(spb, 6)])

    return {
        "format": fmt,
        "tpb": tpb,
        "tracks": tracks,
        "tempo": tempo,
        "bpm": round(60.0 / (segs[0][1] / 1e6), 1),
        "max_tick": max_tick,
        "to_sec": to_sec,
    }


# --------------------------------------------------------------------------- 谱面
def count_taps(notes, win=CHORD_WIN):
    c, last = 0, -1e9
    for n in notes:
        if n[0] - last > win:
            c += 1
            last = n[0]
    return c


def slugify(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower()
    return s or "chart"


def find_cover(cid: str):
    if not COVER_DIR.is_dir():
        return None
    for ext in ("jpg", "jpeg", "png", "webp", "JPG", "PNG"):
        p = COVER_DIR / ("%s.%s" % (cid, ext))
        if p.exists():
            return p.name
    return None


def fmt_note(n):
    return "[%.4f,%.3f,%d,%d]" % (n[0], n[1] - n[0], n[2], n[3])


def render(chart) -> str:
    out = ["/* %s.js — 由 tools/midi2chart.py 生成，可手动微调 */" % chart["id"]]
    out.append('(window.LAMBDA_CHART = window.LAMBDA_CHART || {})[%s] = {'
               % json.dumps(chart["id"], ensure_ascii=False))
    for k in ("v", "id", "title", "artist", "orig", "bpm", "duration", "player", "level", "taps", "cover"):
        if k in chart and chart[k] not in (None, ""):
            out.append("  %s: %s," % (json.dumps(k), json.dumps(chart[k], ensure_ascii=False)))
    out.append('  "tempo": %s,' % json.dumps(chart["tempo"]))
    out.append('  "tracks": %s,' % json.dumps(chart["tracks"], ensure_ascii=False))
    out.append('  "notes": [')
    for arr in chart["notes"]:
        if not arr:
            out.append("    [],")
            continue
        out.append("    [")
        for i in range(0, len(arr), 6):
            out.append("      " + ", ".join(fmt_note(n) for n in arr[i:i + 6]) + ",")
        out.append("    ],")
    out.append("  ]")
    out.append("};")
    return "\n".join(out) + "\n"


def reindex() -> list:
    """重建清单。新增曲目追加到末尾，保持既有曲目顺序稳定（避免打乱成绩与选曲位置）。"""
    CHART_DIR.mkdir(parents=True, exist_ok=True)
    index_path = CHART_DIR / "index.js"
    old = []
    if index_path.exists():
        m = re.search(r"LAMBDA_INDEX\s*=\s*(\[[^\]]*\])",
                      index_path.read_text(encoding="utf-8"))
        if m:
            try:
                old = json.loads(m.group(1))
            except ValueError:
                old = []
    ids = sorted(p.stem for p in CHART_DIR.glob("*.js") if p.name != "index.js")
    keep = [i for i in old if i in ids]
    merged = keep + [i for i in ids if i not in keep]
    body = ("/* 曲目清单 — 由 tools/midi2chart.py 自动生成，请勿手改。\n"
            "   新增谱面后运行「更新谱面.bat」重新生成本文件。 */\n"
            "window.LAMBDA_INDEX = %s;\n" % json.dumps(merged, ensure_ascii=False, indent=0)
            .replace("\n", ""))
    index_path.write_text(body, encoding="utf-8")
    return merged


def convert(args) -> int:
    src = Path(args.midi)
    if not src.exists():
        print("找不到文件：%s" % src)
        return 1
    raw = src.read_bytes()
    try:
        mid = parse_midi(raw)
    except ValueError as e:
        print("解析失败：%s" % e)
        return 1

    tracks = mid["tracks"]
    player = args.player
    if player is None:
        player = next((i for i, t in enumerate(tracks) if t["notes"]), 0)
    if player >= len(tracks) or not tracks[player]["notes"]:
        print("第 %d 条音轨没有音符，无法作为玩家音轨。" % (player + 1))
        return 1

    title = args.title or re.sub(r"[_\s]+", " ", src.stem).strip()
    cid = args.id or slugify(title)

    duration = max((n[1] for t in tracks for n in t["notes"]), default=0.0)
    taps = count_taps(tracks[player]["notes"])
    level = max(1, min(15, int(round(taps / max(1.0, duration) * 2.5))))

    chart = {
        "v": 1,
        "id": cid,
        "title": title,
        "artist": args.artist or "",
        "orig": True if args.orig else "",
        "bpm": mid["bpm"],
        "duration": round(duration, 3),
        "player": player,
        "level": level,
        "taps": taps,
        "tempo": mid["tempo"],
        "tracks": [
            {"name": t["name"] or ("track%d" % (i + 1)),
             "drum": t["drum"],
             "gain": 1.0 if i == player else 0.6}
            for i, t in enumerate(tracks)
        ],
        "notes": [[list(n) for n in t["notes"]] for t in tracks],
    }
    cv = find_cover(cid)
    if cv:
        chart["cover"] = cv

    CHART_DIR.mkdir(parents=True, exist_ok=True)
    out = CHART_DIR / ("%s.js" % cid)
    out.write_text(render(chart), encoding="utf-8")

    print("输入     : %s" % src.name)
    print("输出谱面 : charts/%s.js  (%.1f KB)" % (cid, out.stat().st_size / 1024))
    print("曲名     : %s   BPM %s   时长 %s" % (title, mid["bpm"], "%d:%02d" % (duration // 60, duration % 60)))
    print("音轨     : %d 条，玩家 = 第 %d 条（%s）" % (len(tracks), player + 1, tracks[player]["name"] or "-"))
    print("击打单位 : %d   LV.%02d" % (taps, level))
    print("曲绘     : %s" % (cv if cv else "未找到（放到 covers/%s.jpg 后重新转换即可）" % cid))

    ids = reindex()
    print("-" * 56)
    print("清单已更新：%d 首 -> charts/index.js" % len(ids))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("midi", nargs="?", help="输入 .mid 文件")
    ap.add_argument("--title", default=None)
    ap.add_argument("--artist", default="")
    ap.add_argument("--orig", action="store_true", help="标记为原创曲（游戏内会显示 ORIGINAL 角标）")
    ap.add_argument("--id", default=None, help="谱面 id（默认由标题生成）")
    ap.add_argument("--player", type=int, default=None, help="玩家音轨索引，从 0 开始")
    ap.add_argument("--reindex", action="store_true", help="只重建 charts/index.js")
    args = ap.parse_args()

    if args.reindex:
        ids = reindex()
        print("已重建 charts/index.js：%d 首" % len(ids))
        for i in ids:
            print("  - %s" % i)
        return 0

    if not args.midi:
        ap.print_help()
        return 1
    return convert(args)


if __name__ == "__main__":
    raise SystemExit(main())
