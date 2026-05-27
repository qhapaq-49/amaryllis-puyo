'use strict';

const SR_FIELD_COLS = 6;
const SR_DISPLAY_ROWS = 12;
const SR_FIELD_ROWS = 13;
const SR_CELL_ASPECT = 0.94;
const SR_GARBAGE_ICON_VALUES = {
  small: 1,
  big: 6,
  rock: 30,
  star: 180,
  moon: 360,
  crown: 720,
  comet: 1440,
};

function srRgbToHsv(r, g, b) {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const cmax = Math.max(rf, gf, bf);
  const cmin = Math.min(rf, gf, bf);
  const d = cmax - cmin;
  let h = 0;
  const s = cmax > 0 ? d / cmax : 0;
  const v = cmax;
  if (d >= 1e-6) {
    if (cmax === rf) h = 60 * (((gf - bf) / d) % 6);
    else if (cmax === gf) h = 60 * ((bf - rf) / d + 2);
    else h = 60 * ((rf - gf) / d + 4);
    if (h < 0) h += 360;
  }
  return [h, s, v];
}

function srClassifyHsv(h, s, v) {
  if (v < 0.35) return '.';
  if (s < 0.18) return v > 0.55 ? '#' : '.';
  if (h < 22 || h >= 345) return 'R';
  if (h < 55) return 'Y';
  if (h < 165) return 'G';
  if (h < 255) return 'B';
  if (h < 345) return 'P';
  return '.';
}

function srPixel(image, x, y) {
  const i = (y * image.width + x) * 4;
  const d = image.data;
  return [d[i], d[i + 1], d[i + 2]];
}

function srForRegion(image, cx, cy, radius, fn) {
  const x1 = Math.max(0, Math.floor(cx - radius));
  const x2 = Math.min(image.width - 1, Math.floor(cx + radius));
  const y1 = Math.max(0, Math.floor(cy - radius));
  const y2 = Math.min(image.height - 1, Math.floor(cy + radius));
  let count = 0;
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      const i = (y * image.width + x) * 4;
      fn(image.data[i], image.data[i + 1], image.data[i + 2], x - x1, y - y1, x2 - x1 + 1, y2 - y1 + 1);
      count++;
    }
  }
  return count;
}

function srClassifyCell(image, cx, cy, cellW, cellH, coloredFracThreshold = 0.25) {
  const radius = Math.floor(Math.min(cellW, cellH) * 0.48);
  let coloredCount = 0;
  let grayGarbageCount = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  const total = srForRegion(image, cx, cy, radius, (r, g, b) => {
    const cmax = Math.max(r, g, b) / 255;
    const cmin = Math.min(r, g, b) / 255;
    const d = cmax - cmin;
    const s = cmax > 0 ? d / cmax : 0;
    const v = cmax;
    const colored = v > 0.35 && s > 0.20;
    if (colored) {
      coloredCount++;
      sr += r;
      sg += g;
      sb += b;
    }
    if (v > 0.46 && s < 0.24) grayGarbageCount++;
  });
  if (total === 0) return '.';
  const coloredFrac = coloredCount / total;
  const grayGarbageFrac = grayGarbageCount / total;
  if (grayGarbageFrac > 0.30 && coloredFrac < 0.18) return '#';
  if (coloredFrac < 0.38 && grayGarbageFrac < 0.12) return '.';
  if (coloredFrac < coloredFracThreshold || coloredCount === 0) return '.';
  return srClassifyHsv(...srRgbToHsv(sr / coloredCount, sg / coloredCount, sb / coloredCount));
}

class SrFieldBounds {
  constructor(x1, y1, x2, y2) {
    this.x1 = x1;
    this.y1 = y1;
    this.x2 = x2;
    this.y2 = y2;
  }
  get cellW() { return (this.x2 - this.x1) / SR_FIELD_COLS; }
  get cellH() { return (this.y2 - this.y1) / SR_DISPLAY_ROWS; }
  cellCenter(row, col) {
    return [
      Math.floor(this.x1 + (col + 0.5) * this.cellW),
      Math.floor(this.y1 + (row + 0.5) * this.cellH),
    ];
  }
}

function srBorderMaskPixel(r, g, b, color) {
  if (color === 'B') return b - r > 80 && b > 100;
  return r - b > 80 && r > 100;
}

function srFindBorderEdges(counts, threshold, gap = 15) {
  const strong = [];
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > threshold) strong.push(i);
  }
  if (strong.length === 0) return [];
  const groups = [];
  let start = strong[0];
  let prev = strong[0];
  for (let i = 1; i < strong.length; i++) {
    const x = strong[i];
    if (x - prev < gap) {
      prev = x;
    } else {
      groups.push([start, prev]);
      start = prev = x;
    }
  }
  groups.push([start, prev]);
  return groups;
}

function srDetectField(image, borderColor, searchX, fieldHeight = null) {
  const H = image.height;
  const [sx0, sx1] = searchX;
  const colCounts = Array(Math.max(0, sx1 - sx0)).fill(0);
  for (let y = 0; y < H; y++) {
    for (let x = sx0; x < sx1; x++) {
      const [r, g, b] = srPixel(image, x, y);
      if (srBorderMaskPixel(r, g, b, borderColor)) colCounts[x - sx0]++;
    }
  }
  const xGroups = srFindBorderEdges(colCounts, H * 0.4);
  if (xGroups.length < 2) return null;
  const lx = sx0 + xGroups[0][1] + 1;
  const rx = sx0 + xGroups[xGroups.length - 1][0] - 1;
  if (rx <= lx) return null;

  const rowCounts = Array(H).fill(0);
  for (let y = 0; y < H; y++) {
    let count = 0;
    for (let x = lx; x < rx; x++) {
      const [r, g, b] = srPixel(image, x, y);
      if (srBorderMaskPixel(r, g, b, borderColor)) count++;
    }
    rowCounts[y] = count;
  }
  const rowLen = rx - lx;
  let yGroups = srFindBorderEdges(rowCounts, rowLen * 0.70);
  if (yGroups.length === 0) yGroups = srFindBorderEdges(rowCounts, rowLen * 0.30);
  if (yGroups.length === 0) return null;

  const hHalf = Math.floor(H / 2);
  let topGroupEnd = yGroups[0][1];
  let maxGap = 0;
  for (let i = 0; i < yGroups.length; i++) {
    const [gs, ge] = yGroups[i];
    if (gs > hHalf) break;
    const nextStart = i + 1 < yGroups.length ? yGroups[i + 1][0] : hHalf;
    const gap = nextStart - ge;
    if (gap > maxGap) {
      maxGap = gap;
      topGroupEnd = ge;
    }
  }
  const ty = topGroupEnd + 1;
  const cellW = (rx - lx) / SR_FIELD_COLS;
  let y2;
  if (fieldHeight !== null && fieldHeight !== undefined) {
    y2 = ty + fieldHeight;
  } else {
    const fieldScoreRatio = 12.0 / 12.854;
    const bottomGap = 12;
    const minFieldH = Math.floor(SR_DISPLAY_ROWS * cellW * 0.5);
    let gsBottom = null;
    for (const [gs] of yGroups) {
      if (gs > ty + minFieldH) {
        gsBottom = gs;
        break;
      }
    }
    if (gsBottom !== null) {
      const yBoundary = gsBottom - bottomGap;
      y2 = ty + Math.floor((yBoundary - ty) * fieldScoreRatio);
    } else {
      y2 = ty + Math.floor(SR_DISPLAY_ROWS * cellW * SR_CELL_ASPECT);
    }
  }
  if (y2 <= ty) return null;
  return new SrFieldBounds(lx, ty, rx, y2);
}

function srExtractField(image, bounds) {
  const rows = ['......'];
  for (let row = 0; row < SR_DISPLAY_ROWS; row++) {
    const cells = [];
    for (let col = 0; col < SR_FIELD_COLS; col++) {
      const [cx, cy] = bounds.cellCenter(row, col);
      cells.push(srClassifyCell(image, cx, cy, bounds.cellW, bounds.cellH));
    }
    if (row === 0) cells[2] = '.';
    rows.push(cells.join(''));
  }
  return rows;
}

function srMeanRegionHsv(image, cx, cy, radius) {
  let rsum = 0;
  let gsum = 0;
  let bsum = 0;
  const total = srForRegion(image, cx, cy, radius, (r, g, b) => {
    rsum += r;
    gsum += g;
    bsum += b;
  });
  if (total === 0) return [0, 0, 0];
  return srRgbToHsv(rsum / total, gsum / total, bsum / total);
}

function srExtractFallingPiece(image, bounds, field, frameColor = '') {
  const cw = bounds.cellW;
  const ch = bounds.cellH;
  const candidates = [];
  for (let rowDisp = 0; rowDisp < 4; rowDisp++) {
    for (let col = 0; col < SR_FIELD_COLS; col++) {
      if (rowDisp === 0 && col === 2) continue;
      let [cx, cy] = bounds.cellCenter(rowDisp, col);
      if (rowDisp === 0) cy = bounds.y1;
      const radius = Math.floor(Math.min(cw, ch) * 0.35);
      const [h, s, v] = srMeanRegionHsv(image, cx, cy, radius);
      if (v > 0.35 && s > 0.25) {
        const c = srClassifyHsv(h, s, v);
        if (c === '.' || c === '#') continue;
        if (rowDisp === 0 && frameColor && c === frameColor) continue;
        candidates.push([rowDisp + 1, col, c]);
      }
    }
  }
  if (candidates.length !== 2) return [null, field];
  const [a, b] = candidates;
  const [r1, c1, color1] = a;
  const [r2, c2, color2] = b;
  const adjacent = (r1 === r2 && Math.abs(c1 - c2) === 1) || (c1 === c2 && Math.abs(r1 - r2) === 1);
  if (!adjacent) return [null, field];
  const rows = field.map(row => row.split(''));
  rows[r1][c1] = '.';
  rows[r2][c2] = '.';
  const fieldClean = rows.map(row => row.join(''));
  let childColor;
  let axisColor;
  if (r1 < r2 || (r1 === r2 && c1 < c2)) {
    childColor = color1;
    axisColor = color2;
  } else {
    childColor = color2;
    axisColor = color1;
  }
  return [[axisColor, childColor], fieldClean];
}

function srRemoveFloatingCells(field) {
  const rows = field.map(row => row.split(''));
  for (let col = 0; col < SR_FIELD_COLS; col++) {
    let seenEmptyBelow = false;
    for (let row = SR_FIELD_ROWS - 1; row >= 1; row--) {
      if (rows[row][col] === '.') seenEmptyBelow = true;
      else if (seenEmptyBelow) rows[row][col] = '.';
    }
  }
  return rows.map(row => row.join(''));
}

function srClassifyGarbageIcon(image, cx, cy, slotW) {
  const radius = Math.max(4, Math.floor(slotW * 0.34));
  const stats = {
    fg: 0,
    colored: 0,
    gray: 0,
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    cr: 0,
    cg: 0,
    cb: 0,
    orangeLeft: 0,
    orangeRight: 0,
    orangeTop: 0,
    orangeBottom: 0,
  };
  let regionW = 0;
  let regionH = 0;
  const total = srForRegion(image, cx, cy, radius, (r, g, b, lx, ly, w, hgt) => {
    regionW = w;
    regionH = hgt;
    const cmax255 = Math.max(r, g, b);
    const cmin255 = Math.min(r, g, b);
    const cmax = cmax255 / 255;
    const cmin = cmin255 / 255;
    const d = cmax - cmin;
    const s = cmax > 0 ? d / cmax : 0;
    const v = cmax;
    const fg = v > 0.45 && (s > 0.12 || v > 0.62);
    if (!fg) return;
    stats.fg++;
    stats.minX = Math.min(stats.minX, lx);
    stats.maxX = Math.max(stats.maxX, lx);
    stats.minY = Math.min(stats.minY, ly);
    stats.maxY = Math.max(stats.maxY, ly);
    if (s > 0.22) {
      stats.colored++;
      stats.cr += r;
      stats.cg += g;
      stats.cb += b;
    }
    if (s < 0.24) stats.gray++;
    const [hue] = srRgbToHsv(r, g, b);
    if (v > 0.42 && s > 0.28 && hue >= 15 && hue < 65) {
      if (lx < Math.floor(w / 2)) stats.orangeLeft++;
      else stats.orangeRight++;
      if (ly < Math.floor(hgt / 2)) stats.orangeTop++;
      else stats.orangeBottom++;
    }
  });
  if (total === 0 || stats.fg === 0) return 0;
  const bboxH = stats.maxY - stats.minY + 1;
  const bboxW = stats.maxX - stats.minX + 1;
  const fgFrac = stats.fg / total;
  if (fgFrac < 0.045 || bboxH < slotW * 0.25 || bboxW < slotW * 0.20) return 0;

  const coloredFrac = stats.colored / total;
  const grayFrac = stats.gray / total;
  if (grayFrac > Math.max(0.07, coloredFrac * 1.25)) {
    return fgFrac < 0.65 ? SR_GARBAGE_ICON_VALUES.small : SR_GARBAGE_ICON_VALUES.big;
  }
  if (stats.colored === 0) return 0;
  if (grayFrac < 0.14) return 0;

  const [h, sat, val] = srRgbToHsv(stats.cr / stats.colored, stats.cg / stats.colored, stats.cb / stats.colored);
  if (val < 0.35 || sat < 0.18) return 0;
  if (h >= 165 && h < 255) {
    const aspect = bboxW / Math.max(1, bboxH);
    const fill = stats.fg / Math.max(1, bboxH * bboxW);
    if (aspect < 1.15 || fill > 0.78) return 0;
    return SR_GARBAGE_ICON_VALUES.comet;
  }
  if (h < 22 || h >= 345) return SR_GARBAGE_ICON_VALUES.rock;
  if (h >= 22 && h < 65) {
    if (stats.orangeLeft + stats.orangeRight + stats.orangeTop + stats.orangeBottom > 0) {
      const leftRatio = stats.orangeLeft / Math.max(1, stats.orangeRight);
      const topRatio = stats.orangeTop / Math.max(1, stats.orangeBottom);
      if (leftRatio > 1.10 && topRatio > 0.55) return SR_GARBAGE_ICON_VALUES.crown;
    }
    if (h >= 26) return SR_GARBAGE_ICON_VALUES.star;
    return SR_GARBAGE_ICON_VALUES.moon;
  }
  return 0;
}

function srCountGarbage(image, bounds) {
  const cw = bounds.cellW;
  const centerY = Math.floor(bounds.y1 - cw * 0.52);
  if (centerY <= 0) return 0;
  let total = 0;
  for (let col = 0; col < SR_FIELD_COLS; col++) {
    const cx = Math.floor(bounds.x1 + (col + 0.5) * cw);
    total += srClassifyGarbageIcon(image, cx, centerY, cw);
  }
  return total;
}

function srSamplePuyoColor(image, cx, cy, cellW, cellH, excludeColor = '') {
  const radius = Math.floor(Math.min(cellW, cellH) * 0.35);
  const counts = {};
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  const total = srForRegion(image, cx, cy, radius, (r, g, b) => {
    totalR += r;
    totalG += g;
    totalB += b;
    const [h, s, v] = srRgbToHsv(r, g, b);
    if (v > 0.40 && s > 0.20) {
      const c = srClassifyHsv(h, s, v);
      if (c !== '.' && c !== excludeColor) counts[c] = (counts[c] || 0) + 1;
    }
  });
  let best = null;
  let bestCount = 0;
  for (const [c, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  if (best) return best;
  if (total === 0) return '.';
  const c = srClassifyHsv(...srRgbToHsv(totalR / total, totalG / total, totalB / total));
  return c !== excludeColor ? c : '.';
}

function srExtractNextPieces(image, bounds, side, nPairs = 2) {
  const cw = bounds.cellW;
  const ch = bounds.cellH;
  const pairs = [];
  for (let i = 0; i < nPairs; i++) {
    const cx = side === 'right'
      ? Math.floor(bounds.x2 + cw * (1.3 + 0.7 * i))
      : Math.floor(bounds.x1 - cw * (1.3 + 0.7 * i));
    const childY = Math.floor(bounds.y1 + (2 * i + 0.5) * ch);
    const axisY = Math.floor(bounds.y1 + (2 * i + 1.5) * ch);
    const child = srSamplePuyoColor(image, cx, childY, cw, ch);
    const axis = srSamplePuyoColor(image, cx, axisY, cw, ch);
    pairs.push([axis, child]);
  }
  return pairs;
}

function analyzeScreenImageData(imageData) {
  const image = { data: imageData.data, width: imageData.width, height: imageData.height };
  const W = image.width;
  const p1Bounds = srDetectField(image, 'B', [0, Math.floor(W / 2)]);
  const p1FieldH = p1Bounds ? p1Bounds.y2 - p1Bounds.y1 : null;
  const p2Bounds = srDetectField(image, 'R', [Math.floor(W / 2), W], p1FieldH);
  const result = {};
  for (const spec of [
    ['p1', p1Bounds, 'right', 'B'],
    ['p2', p2Bounds, 'left', 'R'],
  ]) {
    const [player, bounds, nextSide, borderColor] = spec;
    if (!bounds) {
      result[player] = { error: 'field not detected' };
      continue;
    }
    let field = srExtractField(image, bounds);
    const falling = srExtractFallingPiece(image, bounds, field, borderColor);
    const currentPiece = falling[0];
    field = srRemoveFloatingCells(falling[1]);
    result[player] = {
      field,
      queue: srExtractNextPieces(image, bounds, nextSide, 2),
      current_piece: currentPiece,
      garbage: srCountGarbage(image, bounds),
    };
  }
  return result;
}

function srLoadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした'));
    };
    img.src = url;
  });
}

async function analyzeScreenFile(file) {
  const img = await srLoadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return analyzeScreenImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

window.analyzeScreenFile = analyzeScreenFile;
window.analyzeScreenImageData = analyzeScreenImageData;
