#!/usr/bin/env python3
"""
とこぷよシミュレーター
tokopuyoバイナリを30手分ループして、積み上がる連鎖の形を確認する
"""
import json
import subprocess
import sys

# ─────────────────────────────────────────────
# フィールド操作
# ─────────────────────────────────────────────

def empty_field():
    return ["......"] * 13

def field_to_grid(field):
    return [list(row) for row in field]

def grid_to_field(grid):
    return ["".join(row) for row in grid]

def drop_puyo(field, x, color):
    """column x に color を1個落とす (重力あり)"""
    grid = field_to_grid(field)
    for row in range(12, -1, -1):  # 下から上へ探す
        if grid[row][x] == '.':
            grid[row][x] = color
            return grid_to_field(grid)
    return field  # 列が満杯 (通常は起きない)

def apply_move(field, x, r, pair):
    """(x, r, pair) を適用してフィールドを更新"""
    first, second = pair
    if r == "UP":
        field = drop_puyo(field, x, first)
        field = drop_puyo(field, x, second)
    elif r == "DOWN":
        field = drop_puyo(field, x, second)
        field = drop_puyo(field, x, first)
    elif r == "RIGHT":
        field = drop_puyo(field, x, first)
        field = drop_puyo(field, x + 1, second)
    elif r == "LEFT":
        field = drop_puyo(field, x, first)
        field = drop_puyo(field, x - 1, second)
    return field

def apply_gravity(grid):
    """重力を適用 (浮いているぷよを落とす)"""
    for col in range(6):
        cells = [grid[row][col] for row in range(13) if grid[row][col] != '.']
        for row in range(13):
            grid[row][col] = '.'
        for i, cell in enumerate(reversed(cells)):
            grid[12 - i][col] = cell
    return grid

def find_groups(field):
    """同色の連結グループを全て返す"""
    grid = field_to_grid(field)
    visited = [[False]*6 for _ in range(13)]
    groups = []
    for row in range(13):
        for col in range(6):
            c = grid[row][col]
            if not visited[row][col] and c not in '.#':
                # BFS
                group = []
                queue = [(row, col)]
                visited[row][col] = True
                while queue:
                    r, c2 = queue.pop()
                    group.append((r, c2))
                    for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
                        nr, nc = r+dr, c2+dc
                        if 0<=nr<13 and 0<=nc<6 and not visited[nr][nc] and grid[nr][nc]==grid[r][c2]:
                            visited[nr][nc] = True
                            queue.append((nr, nc))
                groups.append((grid[group[0][0]][group[0][1]], group))
    return groups

def pop_chains(field):
    """4個以上の連結グループを消して連鎖数を返す"""
    chain_count = 0
    while True:
        groups = find_groups(field)
        to_pop = [g for _, g in groups if len(g) >= 4]
        if not to_pop:
            break
        chain_count += 1
        grid = field_to_grid(field)
        # ぷよを消す
        pop_cells = set()
        for group in to_pop:
            for r, c in group:
                pop_cells.add((r, c))
                grid[r][c] = '.'
        # 隣接おじゃまも消す
        for r, c in list(pop_cells):
            for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
                nr, nc = r+dr, c+dc
                if 0<=nr<13 and 0<=nc<6 and grid[nr][nc]=='#':
                    grid[nr][nc] = '.'
        grid = apply_gravity(grid)
        field = grid_to_field(grid)
    return field, chain_count

# ─────────────────────────────────────────────
# tokopuyo バイナリ呼び出し
# ─────────────────────────────────────────────

def ask_tokopuyo(field, queue, binary="./bin/tokopuyo/tokopuyo.exe"):
    req = {
        "field": field,
        "queue": [[a, b] for a, b in queue],
        "options": {"weights": "build"}
    }
    result = subprocess.run(
        [binary],
        input=json.dumps(req) + "\n",
        capture_output=True, text=True
    )
    resp = json.loads(result.stdout.strip())
    if "error" in resp:
        raise RuntimeError(resp["error"])
    return resp["candidates"]

# ─────────────────────────────────────────────
# ツモ生成 (色をローテート)
# ─────────────────────────────────────────────

COLORS = ['R', 'Y', 'G', 'B']

def make_queue(offset, count=4):
    return [
        (COLORS[(offset + i*2) % 4], COLORS[(offset + i*2 + 1) % 4])
        for i in range(count)
    ]

# ─────────────────────────────────────────────
# 表示
# ─────────────────────────────────────────────

COLOR_MAP = {
    'R': '\033[31mR\033[0m',
    'Y': '\033[33mY\033[0m',
    'G': '\033[32mG\033[0m',
    'B': '\033[34mB\033[0m',
    '#': '\033[37m#\033[0m',
    '.': '.',
}

def colorize(row):
    return "".join(COLOR_MAP.get(c, c) for c in row)

def print_field(field, header=""):
    if header:
        print(header)
    print("  123456")
    for i, row in enumerate(field):
        row_num = 13 - i
        print(f"{row_num:2} {colorize(row)}")
    print()

# ─────────────────────────────────────────────
# メインループ
# ─────────────────────────────────────────────

def main():
    n_moves = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    binary = sys.argv[2] if len(sys.argv) > 2 else "./bin/tokopuyo/tokopuyo.exe"

    field = empty_field()
    print_field(field, "=== 初期盤面 ===")

    total_chains = 0

    for move_num in range(1, n_moves + 1):
        queue = make_queue((move_num - 1) * 2, 4)
        pair = queue[0]

        try:
            candidates = ask_tokopuyo(field, queue, binary)
        except Exception as e:
            print(f"Move {move_num}: エラー - {e}")
            break

        best = candidates[0]
        x = best["x"]
        r = best["r"]
        score = best["expected_score"]

        field = apply_move(field, x, r, pair)
        field, chains = pop_chains(field)
        total_chains += chains

        chain_str = f"  ★{chains}連鎖!" if chains else ""
        header = f"=== Move {move_num:2d}: {pair[0]}{pair[1]} → x={x} r={r:<5} score={score:6d}{chain_str} ==="
        print_field(field, header)

    print(f"30手終了 | 総連鎖数: {total_chains}")

if __name__ == "__main__":
    main()
