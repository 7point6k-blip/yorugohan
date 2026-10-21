#!/usr/bin/env python3
"""東西線 葛西→飯田橋（中野方面）の時刻表を timetable.js に書き出す。

ダイヤ改正のときはこれを実行し直すだけでいい。
元データ：mini-tokyo-3d（公共交通オープンデータセンターの東京メトロ時刻表を整形したもの）
  git clone --depth 1 https://github.com/nagix/mini-tokyo-3d
  python3 tools/make-timetable.py mini-tokyo-3d/data/train-timetables/tokyometro-tozai.json
"""
import json
import sys
from datetime import date

src = sys.argv[1] if len(sys.argv) > 1 else "tokyometro-tozai.json"
data = json.load(open(src, encoding="utf-8"))


def mins(s):
    h, m = map(int, s.split(":"))
    return h * 60 + m


out = {"Weekday": set(), "SaturdayHoliday": set()}
for t in data:
    cal = t["id"].split(".")[-1]
    if cal not in out:
        continue
    names = [x["s"].split(".")[-1] for x in t["tt"]]
    if "Kasai" not in names or "Iidabashi" not in names:
        continue
    if names.index("Kasai") > names.index("Iidabashi"):
        continue  # 西船橋方面は使わない
    k = t["tt"][names.index("Kasai")]
    i = t["tt"][names.index("Iidabashi")]
    if "d" not in k:
        continue  # 葛西で乗れない（終点など）
    dep = mins(k["d"])
    arr = mins(i.get("a") or i.get("d"))  # 飯田橋は発時刻しか無いことが多いので、着として扱う（少し安全側）
    if dep < 180:
        dep += 1440
    while arr < dep:
        arr += 1440
    out[cal].add((dep, arr))

wk = sorted(out["Weekday"])
hol = sorted(out["SaturdayHoliday"])
if len(wk) < 100 or len(hol) < 100:
    sys.exit("時刻表の本数が少なすぎます。元データを確認してください")

with open("timetable.js", "w", encoding="utf-8") as f:
    f.write("// 東西線 葛西→飯田橋（中野方面）の時刻表。tools/make-timetable.py で作成\n")
    f.write("// 各要素は [葛西の発車, 飯田橋の到着]（0時からの分）\n")
    f.write(f"self.TOZAI = {{\n  updated: \"{date.today().isoformat()}\",\n")
    f.write(f"  weekday: {json.dumps([list(x) for x in wk], separators=(',', ':'))},\n")
    f.write(f"  holiday: {json.dumps([list(x) for x in hol], separators=(',', ':'))},\n}};\n")
print(f"平日 {len(wk)}本 / 土休日 {len(hol)}本 を timetable.js に書き出しました")
