import { createMosaicTiles, mosaicColor } from "../lib/polygon-mosaic.js";

for (const element of document.querySelectorAll<HTMLElement>("[data-mosaic-photo]")) {
  const image = element.querySelector<HTMLImageElement>(".mosaic-source");
  const canvas = element.querySelector<HTMLCanvasElement>("canvas");
  if (!image || !canvas) continue;
  const render = async () => {
    try {
      await image.decode();
      if (element.dataset.mosaicSource === image.currentSrc) return;
      const width = Math.min(image.naturalWidth, 1024);
      const height = Math.round(width * image.naturalHeight / image.naturalWidth);
      const source = document.createElement("canvas");
      source.width = width; source.height = height;
      const sample = source.getContext("2d", { willReadFrequently: true });
      canvas.width = width; canvas.height = height;
      const output = canvas.getContext("2d");
      if (!sample || !output) return;
      const mosaic = document.createElement("canvas");
      mosaic.width = width; mosaic.height = height;
      const facets = mosaic.getContext("2d");
      if (!facets) return;
      sample.drawImage(image, 0, 0, width, height);
      const pixels = sample.getImageData(0, 0, width, height).data;
      const columns = Math.max(8, Math.min(40, Number(element.dataset.columns) || 20));
      const pattern = element.dataset.pattern === "hexagon" ? "hexagon" : "triangle";
      // The original image underneath avoids transparent seams between the facets．
      facets.drawImage(source, 0, 0);
      for (const tile of createMosaicTiles(width, height, width / columns, pattern)) {
        const color = mosaicColor(pixels, width, height, tile);
        if (!color) continue;
        facets.beginPath();
        tile.forEach(([x,y], index) => index ? facets.lineTo(x,y) : facets.moveTo(x,y));
        facets.closePath(); facets.fillStyle = color; facets.fill();
        facets.strokeStyle = color; facets.lineWidth = 0.6; facets.stroke();
      }
      const clearAreas: [number, number][][] = JSON.parse(element.dataset.clearAreas ?? "[]");
      if (!clearAreas.length || clearAreas.some(area => area.length < 3 || area.some(point => point.length !== 2 || point.some(value => !Number.isFinite(value) || value < 0 || value > 1)))) return;
      const mosaicAreas: [number, number][][] = JSON.parse(element.dataset.mosaicAreas ?? "[]");
      if (!mosaicAreas.length || mosaicAreas.some(area => area.length < 3 || area.some(point => point.length !== 2 || point.some(value => !Number.isFinite(value) || value < 0 || value > 1)))) return;
      output.drawImage(source, 0, 0);
      output.save(); output.beginPath();
      for (const area of mosaicAreas) {
        area.forEach(([x,y], index) => index ? output.lineTo(x * width,y * height) : output.moveTo(x * width,y * height));
        output.closePath();
      }
      output.clip(); output.drawImage(mosaic, 0, 0); output.restore();
      // Restore real source pixels inside the protected book area，without redrawing it．
      for (const area of clearAreas) {
        output.save(); output.beginPath();
        area.forEach(([x,y], index) => index ? output.lineTo(x * width,y * height) : output.moveTo(x * width,y * height));
        output.closePath(); output.clip(); output.drawImage(source, 0, 0); output.restore();
      }
      canvas.hidden = false;
      element.dataset.ready = "true";
      element.dataset.mosaicSource = image.currentSrc;
    } catch {
      // Keep the CSS blur fallback if the image cannot be decoded or sampled．
    }
  };
  image.addEventListener("load", render);
  if (image.complete && image.naturalWidth) void render();
}
