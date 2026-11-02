import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createMosaicTiles, mosaicColor } from "../src/lib/polygon-mosaic.js";

for (const pattern of ["triangle", "hexagon"]) {
  test(`${pattern} covers the whole photograph including edges`, async () => {
    const width = 203, height = 139;
    const tiles = createMosaicTiles(width, height, 19, pattern);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/>${tiles.map(tile => `<polygon points="${tile.map(point => point.join(",")).join(" ")}" fill="black"/>`).join("")}</svg>`;
    const result = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer();
    assert.equal(result.some(value => value !== 0), false, "Mosaic must not leave readable gaps");
  });
  test(`${pattern} keeps the original source colours without a brand tint`, () => {
    const width = 41, height = 29;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([23, 114, 207, 255], i);
    for (const tile of createMosaicTiles(width, height, 11, pattern)) {
      const color = mosaicColor(pixels, width, height, tile);
      if (color) assert.equal(color, "rgb(23,114,207)");
    }
  });
}
test("invalid dimensions and unknown patterns fail explicitly", () => {
  assert.throws(() => createMosaicTiles(0, 20, 10), RangeError);
  assert.throws(() => createMosaicTiles(20, 20, 0), RangeError);
  assert.throws(() => createMosaicTiles(20, 20, 10, "square"), TypeError);
});
