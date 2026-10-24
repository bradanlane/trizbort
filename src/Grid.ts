import { App } from './App'
import { Canvas } from './drawing/canvas'
import { Dispatcher } from './Dispatcher'
import { AppEvent } from './enums'

type SvgUnit = 'px' | 'mm' | 'cm'

export class Grid {
  private backgroundImage: HTMLImageElement;
  private backgroundLoaded = false;
  private backgroundPath = '';
  private backgroundSourceKey = '';
  private backgroundLoadToken = 0;
  private backgroundWidth = 0;
  private backgroundHeight = 0;
  private backgroundWidthUnit: SvgUnit = 'px';
  private backgroundHeightUnit: SvgUnit = 'px';

  constructor() {
    this.backgroundImage = new Image();
    this.ensureBackgroundSource();
  }

  private isSameOrigin(path: string) {
    try {
      const url = new URL(path, window.location.href);
      return url.origin === window.location.origin;
    } catch {
      return false;
    }
  }

  private resetBackground() {
    this.backgroundLoaded = false;
    this.backgroundPath = '';
    this.backgroundWidth = 0;
    this.backgroundHeight = 0;
    this.backgroundWidthUnit = 'px';
    this.backgroundHeightUnit = 'px';
  }

  private getBackgroundCandidates() {
    const url = (App.map.settings.grid.backgroundUrl || '').trim();

	// Loading hierarchy:
    // 1) User-provided URL from Map Settings (if present)
    // 2) Local fallback files in priority order: svg, png, jpg
    
	// change to only support a URL; avoids error loading resources in console log
	// const defaults = ['background.svg', 'background.png', 'background.jpg'];
    // return (url ? [url, ...defaults] : defaults);
    return (url ? [url] : []);
  }

  private ensureBackgroundSource() {
    const candidates = this.getBackgroundCandidates();
    const key = candidates.join('|');
    if(key === this.backgroundSourceKey) return;

    this.backgroundSourceKey = key;
    this.resetBackground();
    this.loadBackground(candidates, 0, ++this.backgroundLoadToken);
  }

  private loadBackground(candidates: string[], index = 0, token = this.backgroundLoadToken) {
    if(index >= candidates.length) return;

    const imagePath = candidates[index];

    this.backgroundImage.onload = () => {
      if(token !== this.backgroundLoadToken) return;
      this.backgroundLoaded = true;
      this.backgroundPath = imagePath;

      // For raster images, naturalWidth/naturalHeight are pixel dimensions.
      // We also use these values as fallback dimensions for SVG.
      this.backgroundWidth = this.backgroundImage.naturalWidth;
      this.backgroundHeight = this.backgroundImage.naturalHeight;
      this.backgroundWidthUnit = 'px';
      this.backgroundHeightUnit = 'px';

      if(!Number.isFinite(App.map.settings.grid.backgroundScale) || App.map.settings.grid.backgroundScale <= 0) {
        App.map.settings.grid.backgroundScale = 100;
      }

      // If SVG is selected, refine dimensions/units from SVG metadata.
      // Only do this for same-origin assets to avoid CORS fetch failures.
      if(imagePath.toLowerCase().endsWith('.svg') && this.isSameOrigin(imagePath)) {
        this.readBackgroundMetadata(imagePath);
      }

      Dispatcher.notify(AppEvent.Refresh, null);
    };

    this.backgroundImage.onerror = () => {
      if(token !== this.backgroundLoadToken) return;
      // If one candidate fails, try the next source in the hierarchy.
      this.loadBackground(candidates, index + 1, token);
    };

    this.backgroundImage.src = imagePath;
  }

  private parseSvgDimension(dim?: string): { value: number, unit: SvgUnit } | null {
    if(!dim) return null;
    // Accept numeric values with optional px/mm/cm unit suffix.
    const match = dim.trim().match(/^([+-]?\d*\.?\d+)(px|mm|cm)?$/i);
    if(!match) return null;
    const value = Number(match[1]);
    if(Number.isNaN(value) || value <= 0) return null;
    const unit = ((match[2] || 'px').toLowerCase() as SvgUnit);
    return { value, unit };
  }

  private readBackgroundMetadata(path: string) {
    fetch(path)
      .then((response) => {
        if(!response.ok) return '';
        return response.text();
      })
      .then((svgText) => {
        if(!svgText) return;
        const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const svg = doc.documentElement;
        if(!svg || svg.tagName.toLowerCase() !== 'svg') return;

        let updated = false;

        const parsedWidth = this.parseSvgDimension(svg.getAttribute('width'));
        const parsedHeight = this.parseSvgDimension(svg.getAttribute('height'));

        // Prefer explicit width/height units from the SVG root element
        // so we can apply the requested px/mm/cm mapping rules.
        if(parsedWidth && parsedHeight) {
          this.backgroundWidth = parsedWidth.value;
          this.backgroundHeight = parsedHeight.value;
          this.backgroundWidthUnit = parsedWidth.unit;
          this.backgroundHeightUnit = parsedHeight.unit;
          updated = true;
        }

        if(!updated) {
          // If width/height are not provided, use viewBox dimensions as px.
          const viewBox = svg.getAttribute('viewBox');
          if(viewBox) {
            const parts = viewBox.trim().split(/\s+/);
            if(parts.length === 4) {
              const vbWidth = Number(parts[2]);
              const vbHeight = Number(parts[3]);
              if(vbWidth > 0 && vbHeight > 0) {
                this.backgroundWidth = vbWidth;
                this.backgroundHeight = vbHeight;
                this.backgroundWidthUnit = 'px';
                this.backgroundHeightUnit = 'px';
                updated = true;
              }
            }
          }
        }

        if(updated && this.backgroundLoaded && this.backgroundPath.toLowerCase().endsWith('.svg')) {
          Dispatcher.notify(AppEvent.Refresh, null);
        }
      })
      .catch(() => {
        // Metadata parsing is best-effort; rendering still works using
        // intrinsic image pixel dimensions when metadata cannot be read.
      });
  }

  private backgroundUnitScale(unit: SvgUnit, gridSize: number) {
    // Mapping rule:
    // - px  => 1 SVG px equals 1 world px
    // - mm/cm => 1 SVG unit equals 1 grid cell (gridSize world px)
    if(unit === 'px') return 1;
    return gridSize;
  }

  private getBackgroundBaseSizePx() {
    const settings = App.map.settings.grid;
    const widthPx = this.backgroundWidth * this.backgroundUnitScale(this.backgroundWidthUnit, settings.size) * App.zoom * App.devicePixelRatio;
    const heightPx = this.backgroundHeight * this.backgroundUnitScale(this.backgroundHeightUnit, settings.size) * App.zoom * App.devicePixelRatio;
    return { width: widthPx, height: heightPx };
  }

  drawBackground(htmlCanvas: HTMLCanvasElement, canvas: Canvas) {
    this.ensureBackgroundSource();
    if(!this.backgroundLoaded) return;

    // Limitation note:
    // Browsers may block remote images because of cross-origin resource
    // policies set by the image host. In that case the loader falls back
    // to the next candidate source.

    const imageWidth = this.backgroundWidth;
    const imageHeight = this.backgroundHeight;
    if(imageWidth <= 0 || imageHeight <= 0) return;

    const settings = App.map.settings.grid;
    const dpr = App.devicePixelRatio;
    const originX = Math.floor(htmlCanvas.offsetWidth / 2) + App.centerX;
    const originY = Math.floor(htmlCanvas.offsetHeight / 2) + App.centerY;
    const opacity = Number(settings.backgroundOpacity ?? 100);
    const clampedOpacity = Math.min(100, Math.max(0, opacity)) / 100;

    const baseSizePx = this.getBackgroundBaseSizePx();
    const defaultWidthPx = baseSizePx.width;
    const defaultHeightPx = baseSizePx.height;
    const scalePercent = Number(settings.backgroundScale ?? 100);
    const clampedScalePercent = Math.min(400, Math.max(0, scalePercent));
    const scaleFactor = clampedScalePercent / 100;
    const drawWidth = defaultWidthPx * scaleFactor;
    const drawHeight = defaultHeightPx * scaleFactor;
    const drawX = originX - drawWidth / 2;
    const drawY = originY - drawHeight / 2;

    canvas.save();
    canvas.globalAlpha(clampedOpacity);
    canvas.drawImage(this.backgroundImage, drawX, drawY, drawWidth, drawHeight);
    canvas.restore();
  }

  private drawGridLineV(htmlCanvas: HTMLCanvasElement, canvas: Canvas, x: number) {
    let y1 = Math.floor(-htmlCanvas.offsetHeight) + 0.5;
    let y2 = Math.floor(htmlCanvas.offsetHeight) + 0.5;
    x = Math.floor(x) + 0.5;
    canvas
      .beginPath()
      .moveTo(x, y1)
      .lineTo(x, y2)
      .stroke();
  }

  private drawGridLineH(htmlCanvas: HTMLCanvasElement, canvas: Canvas, y: number) {
    let x1 = Math.floor(-htmlCanvas.offsetWidth) + 0.5;
    let x2 = Math.floor(htmlCanvas.offsetWidth) + 0.5;
    y = Math.floor(y) + 0.5;    
    canvas
      .beginPath()
      .moveTo(x1, y)
      .lineTo(x2, y)
      .stroke();
  }  

  draw(htmlCanvas: HTMLCanvasElement, canvas: Canvas) {
    // Do not draw grid if grid not visible.
    let settings = App.map.settings.grid;
    if(!settings.visible) return;

    const dpr = App.devicePixelRatio;
    canvas
      .save()
      .strokeStyle(settings.color)
      .lineWidth(settings.lineWidth * dpr);
    var x = htmlCanvas.offsetWidth / 2 + App.centerX;
    while(x > 0) { this.drawGridLineV(htmlCanvas, canvas, x); x -= settings.size * App.zoom * dpr; }
    var x = htmlCanvas.offsetWidth / 2 + App.centerX + settings.size * App.zoom * dpr;
    while(x < htmlCanvas.offsetWidth) { this.drawGridLineV(htmlCanvas, canvas, x); x += settings.size * App.zoom * dpr; }
    var y = htmlCanvas.offsetHeight / 2 + App.centerY;
    while(y > 0) { this.drawGridLineH(htmlCanvas,canvas, y); y -=  settings.size * App.zoom * dpr; }
    var y = htmlCanvas.offsetHeight / 2 + App.centerY + settings.size * App.zoom * dpr;
    while(y < htmlCanvas.offsetHeight) { this.drawGridLineH(htmlCanvas, canvas, y); y += settings.size * App.zoom * dpr; }

    // Draw origin if necessary
    if(settings.origin) {
      x = Math.floor(htmlCanvas.offsetWidth / 2) + App.centerX;
      y = Math.floor(htmlCanvas.offsetHeight / 2) + App.centerY;
      canvas
        .beginPath()
        .lineWidth(settings.originWidth * dpr)
        .moveTo(x, y - settings.size * App.zoom * dpr)
        .lineTo(x, y + settings.size * App.zoom * dpr)
        .moveTo(x - settings.size * App.zoom * dpr, y)
        .lineTo(x + settings.size * App.zoom * dpr, y)
        .stroke();
    }

    canvas.restore();    
  }

  static snap(a: number) {
    let settings = App.map.settings.grid;
    if(!settings.snap) return a;
    return Math.floor(a / settings.size) * settings.size;
  }
}