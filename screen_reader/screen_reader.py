#!/usr/bin/env python3
"""
ぷよぷよ対戦画面スクショから盤面情報をama形式で抽出する

Usage:
    python screen_reader.py <image_path>
    python screen_reader.py <image_path> --debug  # debug.png を出力

出力形式:
    {
      "p1": { "field": ["..R...", ...], "queue": [["R","G"], ...], "garbage": 0 },
      "p2": { "field": ["..R...", ...], "queue": [["Y","Y"], ...], "garbage": 8 }
    }

field: row0=最上段(非表示行/常に空), row1..row12=画面表示行, 各行6文字
       R=赤, Y=黄, G=緑, B=青, P=紫, #=おじゃま, .=空
queue: [axis_color, child_color] のリスト, インデックス0=ネクスト先頭
garbage: 頭上のおじゃまぷよ数
"""

import sys
import json
import argparse
import numpy as np
from PIL import Image, ImageDraw
from typing import Optional, Tuple, List
from collections import Counter
from dataclasses import dataclass

FIELD_COLS = 6
DISPLAY_ROWS = 12   # ゲーム画面に表示される行数
FIELD_ROWS = 13     # ama形式の総行数 (row0=非表示 + DISPLAY_ROWS)
# ぷよぷよのセル縦横比: cell_h/cell_w（実測値）
# 底ボーダーは存在しないためセル幅から高さを推算する
CELL_ASPECT = 0.94
GARBAGE_ICON_VALUES = {
    'small': 1,
    'big': 6,
    'rock': 30,
    'star': 180,
    'moon': 360,
    'crown': 720,
    'comet': 1440,
}


# ───────────────────────────── 色分類 ─────────────────────────────

def rgb_to_hsv(r: float, g: float, b: float) -> Tuple[float, float, float]:
    rf, gf, bf = r / 255, g / 255, b / 255
    cmax = max(rf, gf, bf)
    cmin = min(rf, gf, bf)
    d = cmax - cmin
    v = cmax
    s = d / cmax if cmax > 0 else 0.0
    if d < 1e-6:
        h = 0.0
    elif cmax == rf:
        h = 60.0 * ((gf - bf) / d % 6)
    elif cmax == gf:
        h = 60.0 * ((bf - rf) / d + 2)
    else:
        h = 60.0 * ((rf - gf) / d + 4)
    return h, s, v


def classify_hsv(h: float, s: float, v: float) -> str:
    if v < 0.35:
        return '.'
    if s < 0.18:
        return '#' if v > 0.55 else '.'
    if h < 22 or h >= 345:
        return 'R'
    if 22 <= h < 55:
        return 'Y'
    if 55 <= h < 165:
        return 'G'
    if 165 <= h < 255:
        return 'B'
    if 255 <= h < 345:
        return 'P'
    return '.'


def classify_cell(arr: np.ndarray, cx: int, cy: int,
                  cell_w: float, cell_h: float,
                  colored_frac_threshold: float = 0.25) -> str:
    """着色ピクセル数の割合でセルを分類する。
    平均ではなく V>0.35 & S>0.20 を満たすピクセル数を全体で割った割合を判定し、
    実ぷよ（大）とゴーストぷよ（小）をサイズで区別する。
    着色ピクセルのみの平均色を取ることで顔（目・口等の暗部）の影響も除く。"""
    radius = int(min(cell_w, cell_h) * 0.48)
    y1 = max(0, cy - radius)
    y2 = min(arr.shape[0], cy + radius + 1)
    x1 = max(0, cx - radius)
    x2 = min(arr.shape[1], cx + radius + 1)
    region = arr[y1:y2, x1:x2, :3]
    total = region.shape[0] * region.shape[1]

    r = region[:, :, 0] / 255.0
    g = region[:, :, 1] / 255.0
    b = region[:, :, 2] / 255.0
    cmax = np.maximum(np.maximum(r, g), b)
    cmin = np.minimum(np.minimum(r, g), b)
    v = cmax
    d = cmax - cmin
    s = np.divide(d, cmax, out=np.zeros_like(cmax), where=cmax > 0)

    colored = (v > 0.35) & (s > 0.20)
    colored_frac = float(colored.sum()) / total
    gray_garbage = (v > 0.46) & (s < 0.24)
    gray_garbage_frac = float(gray_garbage.sum()) / total

    # 盤面内に落ちたおじゃまぷよは低彩度の白〜灰色が大部分を占める。
    # 色ぷよの目・ハイライトにも低彩度部分はあるため、十分な面積を要求する。
    if gray_garbage_frac > 0.30 and colored_frac < 0.18:
        return '#'

    # 落下中ツモの着地点を示す小さい色マーカーは、本物のぷよより着色面積が小さく、
    # 目・ハイライト由来の低彩度部分も少ないため盤面から除外する。
    if colored_frac < 0.38 and gray_garbage_frac < 0.12:
        return '.'

    if colored_frac < colored_frac_threshold:
        return '.'

    rm = float(region[:, :, 0][colored].mean())
    gm = float(region[:, :, 1][colored].mean())
    bm = float(region[:, :, 2][colored].mean())
    return classify_hsv(*rgb_to_hsv(rm, gm, bm))


# ───────────────────────────── フィールド境界検出 ─────────────────────────────

@dataclass
class FieldBounds:
    x1: int
    y1: int
    x2: int
    y2: int

    @property
    def cell_w(self) -> float:
        return (self.x2 - self.x1) / FIELD_COLS

    @property
    def cell_h(self) -> float:
        # 表示行数でセル高さを計算 (ama row0=非表示分は含まない)
        return (self.y2 - self.y1) / DISPLAY_ROWS

    def cell_center(self, row: int, col: int) -> Tuple[int, int]:
        cx = int(self.x1 + (col + 0.5) * self.cell_w)
        cy = int(self.y1 + (row + 0.5) * self.cell_h)
        return cx, cy


def _border_mask(arr: np.ndarray, color: str) -> np.ndarray:
    if color == 'B':
        return ((arr[:, :, 2].astype(int) - arr[:, :, 0].astype(int) > 80)
                & (arr[:, :, 2] > 100))
    else:  # 'R'
        return ((arr[:, :, 0].astype(int) - arr[:, :, 2].astype(int) > 80)
                & (arr[:, :, 0] > 100))


def _find_border_edges(counts: np.ndarray, threshold: float,
                       gap: int = 15) -> List[Tuple[int, int]]:
    strong = [i for i, c in enumerate(counts) if c > threshold]
    if not strong:
        return []
    groups: List[List[int]] = []
    cur = [strong[0]]
    for x in strong[1:]:
        if x - cur[-1] < gap:
            cur.append(x)
        else:
            groups.append(cur)
            cur = [x]
    groups.append(cur)
    return [(g[0], g[-1]) for g in groups]


def detect_field(arr: np.ndarray, border_color: str,
                 search_x: Tuple[int, int],
                 field_height: Optional[int] = None) -> Optional[FieldBounds]:
    """フィールド境界を検出する。
    field_height: 既知のフィールド高さ(px)。Noneの場合は底ボーダーから推算。
    同一スクリーンの他プレイヤーから先に算出した値を渡すとy2精度が向上する。
    """
    H = arr.shape[0]
    mask = _border_mask(arr, border_color)

    col_counts = mask[:, search_x[0]:search_x[1]].sum(axis=0)
    x_groups = _find_border_edges(col_counts, threshold=H * 0.4)
    if len(x_groups) < 2:
        return None
    lx = search_x[0] + x_groups[0][1] + 1
    rx = search_x[0] + x_groups[-1][0] - 1

    row_counts = mask[:, lx:rx].sum(axis=1)
    row_len = rx - lx
    # 70%閾値でグループ検出。フィールド上方にUIや背景など散在する同色ピクセルがある場合、
    # 複数グループが現れることがある。実際の上端ボーダーは「直後に最長のギャップ(フィールド内部)
    # が続くグループ」であるため、画像上半分のグループのうち直後ギャップが最大のものを選ぶ。
    y_groups = _find_border_edges(row_counts, threshold=row_len * 0.70)
    if not y_groups:
        y_groups = _find_border_edges(row_counts, threshold=row_len * 0.30)
    if not y_groups:
        return None
    H_half = H // 2
    # 上半分のグループで直後ギャップが最大のものを上端ボーダーとする
    top_group_end = y_groups[0][1]
    max_gap = 0
    for i, (gs, ge) in enumerate(y_groups):
        if gs > H_half:
            break
        next_start = y_groups[i + 1][0] if i + 1 < len(y_groups) else H_half
        gap = next_start - ge
        if gap > max_gap:
            max_gap = gap
            top_group_end = ge
    ty = top_group_end + 1

    cell_w = (rx - lx) / FIELD_COLS

    if field_height is not None:
        # 他プレイヤーから計算済みのフィールド高さを使用（同解像度のため同一）
        y2 = ty + field_height
    else:
        # 底ボーダー開始位置(gs_bottom)からy2を逆算する。
        # gs_bottom の直前には「スコア表示+ギャップ」が存在し、
        # その合計高さは field_h * (1/FIELD_SCORE_RATIO - 1) に相当する。
        # FIELD_SCORE_RATIO = 12/12.854 ≈ 0.933 (実測: P1青ボーダーより)
        FIELD_SCORE_RATIO = 12.0 / 12.854
        BOTTOM_GAP = 12  # スコア表示底とボーダー底横棒の間の空白(px, 実測)
        min_field_h = int(DISPLAY_ROWS * cell_w * 0.5)
        gs_bottom = None
        for gs, ge in y_groups:
            if gs > ty + min_field_h:
                gs_bottom = gs
                break
        if gs_bottom is not None:
            y_boundary = gs_bottom - BOTTOM_GAP
            y2 = ty + int((y_boundary - ty) * FIELD_SCORE_RATIO)
        else:
            y2 = ty + int(DISPLAY_ROWS * cell_w * CELL_ASPECT)

    if rx <= lx or y2 <= ty:
        return None
    return FieldBounds(x1=lx, y1=ty, x2=rx, y2=y2)


# ───────────────────────────── フィールド抽出 ─────────────────────────────

def extract_field(arr: np.ndarray, bounds: FieldBounds) -> List[str]:
    """
    フィールドを13行×6列のリスト(ama形式)で返す。
    row0='......' (非表示行), row1..row12=画面表示行。
    """
    rows = ['......']  # ama row0: 画面に表示されない非表示行
    for row in range(DISPLAY_ROWS):
        cells = []
        for col in range(FIELD_COLS):
            cx, cy = bounds.cell_center(row, col)
            cells.append(classify_cell(arr, cx, cy, bounds.cell_w, bounds.cell_h))
        # 表示最上段3列目の赤い×は死亡判定位置のUIマーカーで、盤面セルではない。
        if row == 0:
            cells[2] = '.'
        rows.append(''.join(cells))
    return rows


def extract_falling_piece(arr: np.ndarray, bounds: FieldBounds,
                          field: List[str],
                          frame_color: str = '') -> Tuple[Optional[List[str]], List[str]]:
    """
    フィールド上部(row1-4)に浮いている落下中ツモを検出して除外する。
    メインフィールド抽出より小さいradius(0.35)で再サンプリングし、
    X状マーカー等の低彩度要素を除外しつつぷよを確実に検出する。

    frame_color: フレームの色 ('R' or 'B')。row_disp=0でフレーム色と一致する
                 候補をノイズとして除外するために使用。

    戻り値: (current_piece, field_without_piece)
      current_piece: [axis_color, child_color] or None
    """
    field = list(field)
    cw, ch = bounds.cell_w, bounds.cell_h

    # radius=0.35 で上部行を再サンプリング（Xマーカー等の低彩度ノイズを除去）
    candidates: List[Tuple[int, int, str]] = []
    for row_disp in range(0, 4):  # display rows 0-3 = ama rows 1-4
        for col in range(FIELD_COLS):
            if row_disp == 0 and col == 2:
                continue  # 死亡判定位置の赤い×マーカー
            cx, cy = bounds.cell_center(row_disp, col)
            # ama row1 (disp row0): 落下中ツモはフィールド上端より上に半分はみ出すため
            # フィールド上端 y1 を中心にサンプリングして本体を確実に捉える
            if row_disp == 0:
                cy = bounds.y1
            r = int(min(cw, ch) * 0.35)
            y1 = max(0, cy - r); y2 = min(arr.shape[0], cy + r + 1)
            x1 = max(0, cx - r); x2 = min(arr.shape[1], cx + r + 1)
            region = arr[y1:y2, x1:x2, :3]
            rm = float(region[:,:,0].mean())
            gm = float(region[:,:,1].mean())
            bm = float(region[:,:,2].mean())
            h, s, v = rgb_to_hsv(rm, gm, bm)
            # S>0.25 を要求してXマーカー(灰色, S低)を除外
            if v > 0.35 and s > 0.25:
                c = classify_hsv(h, s, v)
                if c in ('.', '#'):
                    continue
                # row_disp=0はフレーム上端に近いため、フレームと同色のぷよは除外
                # (P2赤フレームがrow_disp=0の全列でRとして検出される問題を防ぐ)
                if row_disp == 0 and frame_color and c == frame_color:
                    continue
                candidates.append((row_disp + 1, col, c))  # ama row

    if len(candidates) != 2:
        return None, field

    (r1, c1, color1), (r2, c2, color2) = candidates

    # 縦隣接 or 横隣接でなければ落下ツモではない
    if not ((r1 == r2 and abs(c1 - c2) == 1) or
            (c1 == c2 and abs(r1 - r2) == 1)):
        return None, field

    # フィールドからツモセルを消去
    rows = [list(r) for r in field]
    rows[r1][c1] = '.'
    rows[r2][c2] = '.'
    field_clean = [''.join(r) for r in rows]

    # axis = 下側 (row番号大 = 画面下), child = 上側 (row番号小 = 画面上)
    if r1 < r2 or (r1 == r2 and c1 < c2):
        child_color, axis_color = color1, color2
    else:
        child_color, axis_color = color2, color1

    return [axis_color, child_color], field_clean


def remove_floating_cells(field: List[str]) -> List[str]:
    """amaに渡す盤面から、重力で存在し得ない浮いたセルを除外する。

    落下中ツモや着地点マーカーがフィールドセルとして残った場合の保険。
    正常な確定盤面では、各列のぷよは底から隙間なく積まれている。
    """
    rows = [list(r) for r in field]
    for col in range(FIELD_COLS):
        seen_empty_below = False
        for row in range(FIELD_ROWS - 1, 0, -1):
            if rows[row][col] == '.':
                seen_empty_below = True
            elif seen_empty_below:
                rows[row][col] = '.'
    return [''.join(r) for r in rows]


# ───────────────────────────── おじゃまぷよ数検出 ─────────────────────────────

def classify_garbage_icon(arr: np.ndarray, cx: int, cy: int,
                          slot_w: float) -> int:
    """頭上おじゃまの1スロットを個数に換算する。

    返り値は実おじゃま個数。アイコンなしなら0。
    ぷよぷよの予告おじゃまは 小=1, 大=6, 岩=30, 星=180, 月=360,
    王冠=720, 彗星=1440 として扱う。
    """
    radius = max(4, int(slot_w * 0.34))
    y1 = max(0, cy - radius)
    y2 = min(arr.shape[0], cy + radius + 1)
    x1 = max(0, cx - radius)
    x2 = min(arr.shape[1], cx + radius + 1)
    region = arr[y1:y2, x1:x2, :3] / 255.0
    if region.size == 0:
        return 0

    cmax = np.max(region, axis=2)
    cmin = np.min(region, axis=2)
    d = cmax - cmin
    s = np.divide(d, cmax, out=np.zeros_like(cmax), where=cmax > 0)
    v = cmax

    fg = (v > 0.45) & ((s > 0.12) | (v > 0.62))
    if not fg.any():
        return 0

    ys, xs = np.where(fg)
    bbox_h = int(ys.max() - ys.min() + 1)
    bbox_w = int(xs.max() - xs.min() + 1)
    fg_frac = float(fg.sum()) / fg.size
    if fg_frac < 0.045 or bbox_h < slot_w * 0.25 or bbox_w < slot_w * 0.20:
        return 0

    colored = fg & (s > 0.22)
    gray = fg & (s < 0.24)
    colored_frac = float(colored.sum()) / fg.size
    gray_frac = float(gray.sum()) / fg.size

    if gray_frac > max(0.07, colored_frac * 1.25):
        # 小ぷよは小さく目がない。大ぷよはスロットを大きく占め、白目も多い。
        return GARBAGE_ICON_VALUES['small'] if fg_frac < 0.65 else GARBAGE_ICON_VALUES['big']

    if not colored.any():
        return 0

    # フレームや背景ロゴは彩度のある塗りが多い一方、実アイコンにある目・ハイライトの
    # 低彩度ピクセルが少ない。ここで頭上アイコン以外の装飾を落とす。
    if gray_frac < 0.14:
        return 0

    rgb = region[colored].mean(axis=0) * 255.0
    h, sat, val = rgb_to_hsv(float(rgb[0]), float(rgb[1]), float(rgb[2]))
    if val < 0.35 or sat < 0.18:
        return 0

    if 165 <= h < 255:
        aspect = bbox_w / max(1, bbox_h)
        fill = float(fg.sum()) / (bbox_h * bbox_w)
        if aspect < 1.15 or fill > 0.78:
            return 0
        return GARBAGE_ICON_VALUES['comet']
    if h < 22 or h >= 345:
        return GARBAGE_ICON_VALUES['rock']
    if 22 <= h < 65:
        # オレンジ系は星・月・王冠が近い色なので、オレンジ本体の分布も見る。
        hue = np.zeros_like(cmax)
        mask = d > 1e-6
        red_max = (region[:, :, 0] == cmax) & mask
        green_max = (region[:, :, 1] == cmax) & mask
        blue_max = (region[:, :, 2] == cmax) & mask
        hue[red_max] = 60.0 * (((region[:, :, 1][red_max] - region[:, :, 2][red_max]) / d[red_max]) % 6)
        hue[green_max] = 60.0 * (((region[:, :, 2][green_max] - region[:, :, 0][green_max]) / d[green_max]) + 2)
        hue[blue_max] = 60.0 * (((region[:, :, 0][blue_max] - region[:, :, 1][blue_max]) / d[blue_max]) + 4)
        orange = (v > 0.42) & (s > 0.28) & (hue >= 15) & (hue < 65)

        if orange.any():
            mid_x = orange.shape[1] // 2
            mid_y = orange.shape[0] // 2
            left = float(orange[:, :mid_x].sum())
            right = float(orange[:, mid_x:].sum())
            top = float(orange[:mid_y, :].sum())
            bottom = float(orange[mid_y:, :].sum())
            if left / max(1.0, right) > 1.10 and top / max(1.0, bottom) > 0.55:
                return GARBAGE_ICON_VALUES['crown']

        if h >= 26:
            return GARBAGE_ICON_VALUES['star']
        return GARBAGE_ICON_VALUES['moon']

    return 0


def count_garbage(arr: np.ndarray, bounds: FieldBounds,
                  border_color: str = '') -> int:
    """
    フィールド上部のおじゃまぷよ表示エリアをスキャンし、アイコン数を返す。

    各列の上に出る予告おじゃまアイコンを読み取り、アイコン種別ごとの個数に換算する。
    """
    del border_color  # 旧実装との互換用。現在は形状でフレーム線を除外する。

    cw = bounds.cell_w
    center_y = int(bounds.y1 - cw * 0.52)
    if center_y <= 0:
        return 0

    total = 0
    for col in range(FIELD_COLS):
        cx = int(bounds.x1 + (col + 0.5) * cw)
        total += classify_garbage_icon(arr, cx, center_y, cw)
    return total


# ───────────────────────────── ネクストピース抽出 ─────────────────────────────

def _sample_puyo_color(arr: np.ndarray, cx: int, cy: int,
                       cell_w: float, cell_h: float,
                       exclude_color: str = '') -> str:
    """指定座標付近のぷよ色をサンプリングする。
    radius=0.35のサンプル領域でV>0.40 S>0.20のピクセルの多数決を取る。"""
    r = int(min(cell_w, cell_h) * 0.35)
    y1 = max(0, cy - r); y2 = min(arr.shape[0], cy + r + 1)
    x1 = max(0, cx - r); x2 = min(arr.shape[1], cx + r + 1)
    region = arr[y1:y2, x1:x2, :3]
    colors: List[str] = []
    for ry in range(region.shape[0]):
        for rx in range(region.shape[1]):
            rv, gv, bv = region[ry, rx, :3]
            h, s, v = rgb_to_hsv(float(rv), float(gv), float(bv))
            if v > 0.40 and s > 0.20:
                c = classify_hsv(h, s, v)
                if c not in ('.', exclude_color):
                    colors.append(c)
    if not colors:
        rm = float(region[:, :, 0].mean())
        gm = float(region[:, :, 1].mean())
        bm = float(region[:, :, 2].mean())
        c = classify_hsv(*rgb_to_hsv(rm, gm, bm))
        return c if c != exclude_color else '.'
    return Counter(colors).most_common(1)[0][0]


def extract_next_pieces(arr: np.ndarray, bounds: FieldBounds,
                        side: str, n_pairs: int = 2) -> List[List[str]]:
    """
    ネクストピース表示からn_pairsペアを抽出する。
    side: 'right' (P1: フィールド右側) or 'left' (P2: フィールド左側)
    戻り値: [[axis, child], ...] (インデックス0=ネクスト)

    P2 (side='left') では、ネクネクがメインネクストより左 (フィールドから遠い側) に
    表示されるため、ペア番号 i に応じて cx を 0.7*cw ずつ外側にシフトする。
    P1 (side='right') では全ペアで同じ cx が使える。
    """
    cw = bounds.cell_w
    ch = bounds.cell_h

    pairs: List[List[str]] = []
    for i in range(n_pairs):
        if side == 'right':
            # ネクネクはペア番号に比例して右にシフト
            cx = int(bounds.x2 + cw * (1.3 + 0.7 * i))
        else:
            # ネクネクはペア番号に比例して左にシフト
            cx = int(bounds.x1 - cw * (1.3 + 0.7 * i))

        child_y = int(bounds.y1 + (2 * i + 0.5) * ch)
        axis_y  = int(bounds.y1 + (2 * i + 1.5) * ch)

        child_c = _sample_puyo_color(arr, cx, child_y, cw, ch)
        axis_c  = _sample_puyo_color(arr, cx, axis_y,  cw, ch)
        pairs.append([axis_c, child_c])

    return pairs


# ───────────────────────────── メイン処理 ─────────────────────────────

def analyze_screen(image_path: str, debug: bool = False) -> dict:
    img = Image.open(image_path).convert('RGB')
    arr = np.array(img).astype(float)
    W = arr.shape[1]

    p1_bounds = detect_field(arr, 'B', (0, W // 2))
    # P2のy2はP1の計算済みfield_heightを流用する（同解像度のため同一）
    p1_field_h = (p1_bounds.y2 - p1_bounds.y1) if p1_bounds else None
    p2_bounds = detect_field(arr, 'R', (W // 2, W), field_height=p1_field_h)

    result = {}

    for player, bounds, next_side, border_color in [
        ('p1', p1_bounds, 'right', 'B'),
        ('p2', p2_bounds, 'left', 'R'),
    ]:
        if bounds is None:
            result[player] = {'error': 'field not detected'}
            continue

        field = extract_field(arr, bounds)
        current_piece, field = extract_falling_piece(arr, bounds, field, frame_color=border_color)
        field = remove_floating_cells(field)
        queue = extract_next_pieces(arr, bounds, next_side, n_pairs=2)
        garbage = count_garbage(arr, bounds, border_color)

        result[player] = {
            'field': field,
            'queue': queue,
            'current_piece': current_piece,
            'garbage': garbage,
            '_bounds': {'x1': bounds.x1, 'y1': bounds.y1,
                        'x2': bounds.x2, 'y2': bounds.y2},
        }

    if debug:
        _save_debug_image(img, result, 'debug.png')
        print('debug.png saved', file=sys.stderr)

    for p in result.values():
        p.pop('_bounds', None)

    return result


def _save_debug_image(img: Image.Image,
                      result: dict, path: str) -> None:
    debug = img.copy()
    draw = ImageDraw.Draw(debug)
    colors_draw = {'p1': (0, 255, 0), 'p2': (255, 165, 0)}

    for player, data in result.items():
        if 'error' in data:
            continue
        b = data.get('_bounds') or {}
        if not b:
            continue
        x1, y1, x2, y2 = b['x1'], b['y1'], b['x2'], b['y2']
        col = colors_draw[player]

        # フィールド境界
        draw.rectangle([x1, y1, x2, y2], outline=col, width=2)

        # セルグリッド (DISPLAY_ROWS=12行)
        cw = (x2 - x1) / FIELD_COLS
        ch = (y2 - y1) / DISPLAY_ROWS
        for row in range(DISPLAY_ROWS):
            for col_i in range(FIELD_COLS):
                cx = int(x1 + (col_i + 0.5) * cw)
                cy = int(y1 + (row + 0.5) * ch)
                draw.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], outline=col)

        # 頭上おじゃまぷよサンプル位置
        gy = int(y1 - cw * 0.52)
        gr = max(4, int(cw * 0.34))
        if gy > 0:
            for col_i in range(FIELD_COLS):
                gx = int(x1 + (col_i + 0.5) * cw)
                draw.ellipse([gx - gr, gy - gr, gx + gr, gy + gr],
                             outline=(255, 255, 0), width=1)
            draw.text((x1, max(0, gy - gr - 14)),
                      f"garbage={data.get('garbage', 0)}",
                      fill=(255, 255, 0))

    debug.save(path)


# ───────────────────────────── CLI ─────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='ぷよぷよ画面から盤面情報を抽出')
    parser.add_argument('image', help='スクリーンショット画像パス')
    parser.add_argument('--debug', action='store_true', help='debug.png を出力')
    args = parser.parse_args()

    result = analyze_screen(args.image, debug=args.debug)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
