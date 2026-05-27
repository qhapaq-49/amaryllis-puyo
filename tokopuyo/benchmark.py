#!/usr/bin/env python3
"""
ベンチマーク: width/depthを変えながらAIに一定手数打たせて
連鎖数・スコアの分布を計測する。

使い方:
  python benchmark.py                         # デフォルト設定で実行
  python benchmark.py --moves 60             # 60手
  python benchmark.py --seeds 42 123 999     # シード指定
  python benchmark.py --widths 250 500 1000  # width指定
  python benchmark.py --depths 16 24 32      # depth指定
  python benchmark.py --jobs 4               # 並列数
  python benchmark.py --out result.csv       # CSV出力先
"""

import argparse
import csv
import json
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

BINARY = Path(__file__).parent.parent / "bin" / "tokopuyo" / "tokopuyo.exe"
COLORS = ['R', 'Y', 'G', 'B']

CHAIN_POWER  = [0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512]
COLOR_BONUS  = [0, 0, 3, 6, 12, 24]
GROUP_BONUS  = [0, 0, 0, 0, 0, 2, 3, 4, 5, 6, 7, 10]


# ─── PRNG (JS の mulberry32 と同一) ─────────────────────────────────────────

def mulberry32(seed):
    s = seed & 0xFFFFFFFF
    def rng():
        nonlocal s
        s = (s + 0x6D2B79F5) & 0xFFFFFFFF
        t = ((s ^ (s >> 15)) * (1 | s)) & 0xFFFFFFFF
        t = (t + ((t ^ (t >> 7)) * (61 | t))) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return rng

def generate_queue(seed, count=200):
    rng = mulberry32(seed)
    return [(COLORS[int(rng() * 4)], COLORS[int(rng() * 4)]) for _ in range(count)]


# ─── フィールド操作 ──────────────────────────────────────────────────────────

def empty_field():
    return ["......"] * 13

def field_to_grid(field):
    return [list(row) for row in field]

def grid_to_field(grid):
    return ["".join(row) for row in grid]

def drop_puyo(field, col, color):
    grid = field_to_grid(field)
    for row in range(12, -1, -1):
        if grid[row][col] == '.':
            grid[row][col] = color
            return grid_to_field(grid)
    return field

def apply_move(field, x, r, pair):
    a, b = pair
    if r == "UP":
        field = drop_puyo(field, x, a)
        field = drop_puyo(field, x, b)
    elif r == "DOWN":
        field = drop_puyo(field, x, b)
        field = drop_puyo(field, x, a)
    elif r == "RIGHT":
        field = drop_puyo(field, x, a)
        field = drop_puyo(field, x + 1, b)
    elif r == "LEFT":
        field = drop_puyo(field, x, a)
        field = drop_puyo(field, x - 1, b)
    return field

def apply_gravity(grid):
    for col in range(6):
        cells = [grid[row][col] for row in range(13) if grid[row][col] != '.']
        for row in range(13):
            grid[row][col] = '.'
        for i, cell in enumerate(reversed(cells)):
            grid[12 - i][col] = cell
    return grid

def find_groups(field):
    grid = field_to_grid(field)
    visited = [[False]*6 for _ in range(13)]
    groups = []
    # row 0 (13段目) は消え判定から除外 (ama get_mask_12準拠)
    for row in range(1, 13):
        for col in range(6):
            c = grid[row][col]
            if not visited[row][col] and c not in '.#':
                group = []
                q = [(row, col)]
                visited[row][col] = True
                while q:
                    r, c2 = q.pop()
                    group.append((r, c2))
                    for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
                        nr, nc = r+dr, c2+dc
                        if 1 <= nr < 13 and 0 <= nc < 6 and not visited[nr][nc] and grid[nr][nc] == grid[r][c2]:
                            visited[nr][nc] = True
                            q.append((nr, nc))
                groups.append((grid[group[0][0]][group[0][1]], group))
    return groups

def calc_step_score(groups, chain_index):
    pop_count = sum(len(g) for _, g in groups)
    power     = CHAIN_POWER[min(chain_index, len(CHAIN_POWER) - 1)]
    colors    = len(set(c for c, _ in groups))
    color_b   = COLOR_BONUS[min(colors, len(COLOR_BONUS) - 1)]
    group_b   = sum(GROUP_BONUS[min(len(g), len(GROUP_BONUS) - 1)] for _, g in groups)
    return pop_count * 10 * max(1, min(999, power + color_b + group_b))

def pop_chains(field):
    chain_index = 0
    total_score = 0
    steps = []
    while True:
        groups = find_groups(field)
        to_pop = [(c, g) for c, g in groups if len(g) >= 4]
        if not to_pop:
            break
        step_score = calc_step_score(to_pop, chain_index)
        total_score += step_score
        chain_index += 1
        grid = field_to_grid(field)
        pop_cells = set()
        for _, group in to_pop:
            for r, c in group:
                pop_cells.add((r, c))
        for r, c in list(pop_cells):
            for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
                nr, nc = r+dr, c+dc
                if 0 <= nr < 13 and 0 <= nc < 6 and grid[nr][nc] == '#':
                    pop_cells.add((nr, nc))
        for r, c in pop_cells:
            grid[r][c] = '.'
        grid = apply_gravity(grid)
        field = grid_to_field(grid)
        steps.append(step_score)
    return field, chain_index, total_score, steps


# ─── AI呼び出し ──────────────────────────────────────────────────────────────

def ask_ai(field, queue, width, depth, binary=BINARY):
    req = {
        "field": field,
        "queue": [[a, b] for a, b in queue],
        "options": {"weights": "build", "width": width, "depth": depth},
    }
    result = subprocess.run(
        [str(binary)],
        input=json.dumps(req) + "\n",
        capture_output=True, text=True, timeout=120,
    )
    resp = json.loads(result.stdout.strip())
    if "error" in resp:
        raise RuntimeError(resp["error"])
    return resp["candidates"], resp.get("elapsed_ms", 0)


# ─── 1ゲームシミュレーション ─────────────────────────────────────────────────

def run_one(seed, width, depth, n_moves, binary=BINARY):
    """
    Returns list of dicts, one per move:
      move, chain_count, step_scores, move_score, cumulative_score, elapsed_ms
    """
    queue_all = generate_queue(seed, 200)
    field = empty_field()
    records = []
    cumulative_score = 0

    for move_num in range(1, n_moves + 1):
        qi = move_num - 1
        if qi + 4 > len(queue_all):
            break

        queue_slice = queue_all[qi:qi + 4]
        pair = queue_slice[0]

        try:
            candidates, elapsed_ms = ask_ai(field, queue_slice, width, depth, binary)
        except Exception as e:
            print(f"  [seed={seed} w={width} d={depth}] move {move_num}: error {e}", file=sys.stderr)
            break

        best = candidates[0]
        field = apply_move(field, best["x"], best["r"], pair)
        field, chain_count, move_score, _ = pop_chains(field)
        cumulative_score += move_score

        records.append({
            "seed": seed,
            "width": width,
            "depth": depth,
            "move": move_num,
            "chain_count": chain_count,
            "move_score": move_score,
            "cumulative_score": cumulative_score,
            "elapsed_ms": elapsed_ms,
        })

    return records


# ─── 集計・表示 ──────────────────────────────────────────────────────────────

def summarize(all_records, widths, depths, seeds):
    from collections import defaultdict
    # (width, depth) -> list of per-seed summary stats
    grouped = defaultdict(list)
    for rec in all_records:
        grouped[(rec["width"], rec["depth"], rec["seed"])].append(rec)

    print("\n" + "="*100)
    print(f"{'width':>6} {'depth':>5} | {'最大連鎖(平均)':>12} {'最大1発スコア(平均)':>18} {'累計スコア(平均)':>16} {'avg ms/手':>10}")
    print("-"*100)

    summary_rows = []
    for w in widths:
        for d in depths:
            max_chains_per_seed = []
            max_fire_scores_per_seed = []
            final_scores_per_seed = []
            avg_ms_per_seed = []
            for s in seeds:
                recs = grouped.get((w, d, s), [])
                if not recs:
                    continue
                max_chains_per_seed.append(max(r["chain_count"] for r in recs))
                max_fire_scores_per_seed.append(max(r["move_score"] for r in recs))
                final_scores_per_seed.append(recs[-1]["cumulative_score"])
                avg_ms_per_seed.append(sum(r["elapsed_ms"] for r in recs) / len(recs))
            if not max_chains_per_seed:
                continue
            avg_max_chain      = sum(max_chains_per_seed) / len(max_chains_per_seed)
            avg_max_fire_score = sum(max_fire_scores_per_seed) / len(max_fire_scores_per_seed)
            avg_score          = sum(final_scores_per_seed) / len(final_scores_per_seed)
            avg_ms             = sum(avg_ms_per_seed) / len(avg_ms_per_seed)
            print(f"{w:>6} {d:>5} | {avg_max_chain:>12.1f} {avg_max_fire_score:>18,.0f} {avg_score:>16,.0f} {avg_ms:>10.0f}")
            summary_rows.append((w, d, avg_max_chain, avg_max_fire_score, avg_score, avg_ms))

    print("="*100)
    return summary_rows


# ─── エントリポイント ─────────────────────────────────────────────────────────

def print_interim(all_records, wd_pairs):
    from collections import defaultdict
    grouped = defaultdict(list)
    for rec in all_records:
        grouped[(rec["width"], rec["depth"], rec["seed"])].append(rec)

    seeds_done = sorted(set(r["seed"] for r in all_records))

    print(f"\n--- 暫定集計 ({len(seeds_done)} seed完了) ---")
    print(f"{'w':>6} {'d':>5} | {'最大連鎖(平均)':>14} {'最大1発スコア(平均)':>20} {'n':>4}")
    print("-" * 55)
    for w, d in wd_pairs:
        mc_list, mf_list = [], []
        for s in seeds_done:
            recs = grouped.get((w, d, s), [])
            if not recs:
                continue
            mc_list.append(max(r["chain_count"] for r in recs))
            mf_list.append(max(r["move_score"] for r in recs))
        if not mc_list:
            continue
        print(f"{w:>6} {d:>5} | {sum(mc_list)/len(mc_list):>14.1f} {sum(mf_list)/len(mf_list):>20,.0f} {len(mc_list):>4}")
    print()
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="とこぷよAI ベンチマーク")
    parser.add_argument("--seeds",  type=int, nargs="+", default=[42, 123, 999])
    parser.add_argument("--widths", type=int, nargs="+", default=[100, 250, 500, 1000, 2000])
    parser.add_argument("--depths", type=int, nargs="+", default=[8, 16, 24, 32])
    parser.add_argument("--pairs",  type=str, nargs="+", default=None,
                        help="width,depth ペアを直接指定 (例: --pairs 500,32 1000,16)")
    parser.add_argument("--moves",  type=int, default=60)
    parser.add_argument("--jobs",   type=int, default=4)
    parser.add_argument("--out",    type=str, default="benchmark_result.csv")
    parser.add_argument("--binary", type=str, default=str(BINARY))
    args = parser.parse_args()

    if args.pairs:
        wd_pairs = []
        for p in args.pairs:
            w, d = p.split(",")
            wd_pairs.append((int(w), int(d)))
        args.widths = sorted(set(w for w, _ in wd_pairs))
        args.depths = sorted(set(d for _, d in wd_pairs))
    else:
        wd_pairs = [(w, d) for w in args.widths for d in args.depths]

    # resume: 既存CSVがあれば完了済みタスクをスキップ
    completed = set()
    all_records = []
    out_path = Path(args.out)
    fieldnames = ["seed", "width", "depth", "move", "chain_count", "move_score", "cumulative_score", "elapsed_ms"]
    if out_path.exists():
        with open(out_path, newline="") as f:
            for r in csv.DictReader(f):
                rec = {k: int(v) for k, v in r.items() if k in fieldnames}
                all_records.append(rec)
                completed.add((rec["seed"], rec["width"], rec["depth"]))
        print(f"resume: {len(completed)} タスク分を読み込み済み")

    tasks = [
        (seed, width, depth)
        for seed in args.seeds
        for width, depth in wd_pairs
        if (seed, width, depth) not in completed
    ]
    total_all = len(args.seeds) * len(wd_pairs)
    total = len(tasks)
    print(f"タスク数: {total}/{total_all}  (seeds={args.seeds}, widths={args.widths}, depths={args.depths}, moves={args.moves})")
    print(f"並列数: {args.jobs}  出力: {args.out}")

    # CSV追記モードで開く（resumeと新規どちらも対応）
    write_header = not out_path.exists() or out_path.stat().st_size == 0
    csv_file = open(out_path, "a", newline="")
    writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
    if write_header:
        writer.writeheader()

    done = 0
    t_start = time.time()

    try:
        with ProcessPoolExecutor(max_workers=args.jobs) as executor:
            futures = {
                executor.submit(run_one, seed, width, depth, args.moves, args.binary): (seed, width, depth)
                for seed, width, depth in tasks
            }
            for future in as_completed(futures):
                seed, width, depth = futures[future]
                done += 1
                elapsed = time.time() - t_start
                try:
                    records = future.result()
                    # CSVに即時追記
                    for rec in records:
                        writer.writerow({k: rec[k] for k in fieldnames if k in rec})
                    csv_file.flush()
                    all_records.extend(records)
                    max_chain = max((r["chain_count"] for r in records), default=0)
                    final_score = records[-1]["cumulative_score"] if records else 0
                    no_fire = "  ⚠️ 未発火" if max_chain == 0 else ""
                    print(f"[{done:3d}/{total}] seed={seed} w={width:5d} d={depth:3d}  "
                          f"max連鎖={max_chain}  累計スコア={final_score:>10,}  経過={elapsed:.0f}s{no_fire}")
                    # 全configで1seed分が揃ったら暫定集計
                    if done % len(wd_pairs) == 0:
                        print_interim(all_records, wd_pairs)
                except Exception as e:
                    print(f"[{done:3d}/{total}] seed={seed} w={width} d={depth}  ERROR: {e}")
    finally:
        csv_file.close()

    print(f"\nCSV保存: {args.out}  ({len(all_records)} 行)")
    widths_out = sorted(set(w for w, _ in wd_pairs))
    depths_out = sorted(set(d for _, d in wd_pairs))
    summarize(all_records, widths_out, depths_out, args.seeds)


if __name__ == "__main__":
    main()
