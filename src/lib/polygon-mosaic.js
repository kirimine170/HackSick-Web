/** @typedef {[number, number]} Point */
/** @typedef {"triangle" | "hexagon"} MosaicPattern */

/**
 * Shared geometric vocabulary for photo mosaics．The original photo supplies every colour．
 * @param {number} width
 * @param {number} height
 * @param {number} cellSize
 * @param {MosaicPattern} pattern
 * @returns {Point[][]}
 */
export function createMosaicTiles(width, height, cellSize, pattern = "triangle") {
  if (![width, height, cellSize].every(value => Number.isFinite(value) && value > 0)) throw new RangeError("Invalid mosaic dimensions");
  if (pattern !== "triangle" && pattern !== "hexagon") throw new TypeError("Unknown mosaic pattern");
  /** @type {Point[][]} */
  const tiles = [];
  if (pattern === "hexagon") {
    const radius = cellSize / 1.5;
    const rowHeight = Math.sqrt(3) * radius;
    for (let column = -1; column <= Math.ceil(width / cellSize) + 1; column++) {
      for (let row = -1; row <= Math.ceil(height / rowHeight) + 1; row++) {
        const cx = column * cellSize;
        const cy = row * rowHeight + (Math.abs(column) % 2) * rowHeight / 2;
        tiles.push(Array.from({ length: 6 }, (_, corner) => {
          const angle = corner * Math.PI / 3;
          return /** @type {Point} */ ([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
        }));
      }
    }
  } else {
    const rowHeight = cellSize * Math.sqrt(3) / 2;
    for (let row = -1; row <= Math.ceil(height / rowHeight); row++) {
      const y = row * rowHeight;
      const offset = (Math.abs(row) % 2) * cellSize / 2;
      for (let column = -2; column <= Math.ceil(width / cellSize); column++) {
        const x = column * cellSize + offset;
        tiles.push([[x, y + rowHeight], [x + cellSize / 2, y], [x + cellSize, y + rowHeight]]);
        tiles.push([[x + cellSize / 2, y], [x + cellSize * 1.5, y], [x + cellSize, y + rowHeight]]);
      }
    }
  }
  return tiles;
}

/** @param {number} x @param {number} y @param {Point[]} polygon */
function contains(x, y, polygon) {
  let inside = false;
  for (let i = 0, previous = polygon.length - 1; i < polygon.length; previous = i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[previous];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/** @param {Uint8ClampedArray} pixels @param {number} width @param {number} height @param {Point[]} polygon */
export function mosaicColor(pixels, width, height, polygon) {
  const left = Math.max(0, Math.floor(Math.min(...polygon.map(point => point[0]))));
  const right = Math.min(width, Math.ceil(Math.max(...polygon.map(point => point[0]))));
  const top = Math.max(0, Math.floor(Math.min(...polygon.map(point => point[1]))));
  const bottom = Math.min(height, Math.ceil(Math.max(...polygon.map(point => point[1]))));
  const stride = Math.max(1, Math.floor(Math.min(right - left, bottom - top) / 7));
  let red = 0, green = 0, blue = 0, count = 0;
  for (let y = top; y < bottom; y += stride) {
    for (let x = left; x < right; x += stride) {
      if (!contains(x + 0.5, y + 0.5, polygon)) continue;
      const index = (y * width + x) * 4;
      red += pixels[index]; green += pixels[index + 1]; blue += pixels[index + 2]; count++;
    }
  }
  return count ? `rgb(${Math.round(red / count)},${Math.round(green / count)},${Math.round(blue / count)})` : null;
}
