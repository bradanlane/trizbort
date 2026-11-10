import { Map, Box, Room, Note, Block, Connector } from "./models";
import { Direction, LineStyle, RoomShape } from "./enums";
import { MarkdownParser, TextSegment } from "./util/MarkdownParser";
import { TextAlign } from "./drawing/IScreen";
import * as opentype from 'opentype.js';

type SvgTextAnchor = 'start' | 'middle' | 'end';
type SvgTextBaselineMode = 'middle' | 'bottom';

//
// The SvgExporter exports the map to an SVG file.
//
export class SvgExporter {
  private map: Map;
  private left: number;
  private top: number;
  private width: number;
  private height: number;
  private padding: number = 50;

  // Embedded background image payload and intrinsic dimensions.
  // If empty/zero, export falls back to plain color background only.
  private backgroundDataUrl = '';
  private backgroundWidth = 0;
  private backgroundHeight = 0;
  private backgroundExportFailed = false;
  private loadedFonts = new globalThis.Map<string, opentype.Font>();

  public constructor(map: Map) {
    this.map = map;
  }

  private isHandDrawnEnabled(): boolean {
    return !!this.map.settings.basic.handdrawn;
  }

  private getEffectiveFontFamily(): string {
    return this.isHandDrawnEnabled() ? 'danielbd' : this.map.settings.basic.fontFamily;
  }

  private handDrawnFilterAttribute(): string {
    // Compatibility: many non-browser SVG tools (including some Inkscape
    // versions/configurations) do not reliably apply filter effects.
    // Hand-drawn appearance is generated directly in path geometry.
    return '';
  }

  private shouldOutlineText(): boolean {
    return !!this.map.settings.basic.svgTextAsOutlines;
  }

  //
  // Export the current map to an SVG file.
  //
  public async export(): Promise<boolean> {
    this.backgroundExportFailed = false;

    // Load fonts as base64
    const fontStyles = await this.loadFonts();

    // Load optional background image as embedded data URL so the SVG is
    // self-contained and does not rely on remote assets after download.
    await this.loadBackgroundImage();

    if((this.map.settings.grid.backgroundUrl || '').trim() && !this.backgroundDataUrl) {
      this.backgroundExportFailed = true;
    }

    // Calculate bounding box after background dimensions are known so
    // export area includes either object or background extents.
    this.calculateBounds();

    // Generate SVG content
    const svg = this.generateSvg(fontStyles);

    // Download
    this.download(svg);
    return !this.backgroundExportFailed;
  }

  // Fetch the configured background image and cache it as a data URL.
  // Failures are intentionally non-fatal so SVG export still succeeds.
  // Cross-origin URLs are attempted and will work when the source allows
  // CORS for this app origin.
  private async loadBackgroundImage(): Promise<void> {
    this.backgroundDataUrl = '';
    this.backgroundWidth = 0;
    this.backgroundHeight = 0;

    const url = (this.map.settings.grid.backgroundUrl || '').trim();
    if (!url) return;

    try {
      const response = await fetch(url);
      if (!response.ok) return;

      const blob = await response.blob();
      this.backgroundDataUrl = await this.blobToBase64(blob);

      const objectUrl = URL.createObjectURL(blob);
      try {
        const dims = await this.getImageDimensions(objectUrl);
        this.backgroundWidth = dims.width;
        this.backgroundHeight = dims.height;
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch {
      // If the image fails to load, keep exporting without it.
    }
  }

  // Resolve intrinsic image dimensions for correct scaled placement.
  private getImageDimensions(url: string): Promise<{ width: number, height: number }> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      };
      image.onerror = () => reject(new Error('Could not load image dimensions'));
      image.src = url;
    });
  }

  //
  // Load fonts and convert to base64 for embedding.
  //
  private async loadFonts(): Promise<string> {
    const fonts: { name: string, url: string, weight: string, style: string }[] = [
      { name: 'danielbd', url: 'fonts/danielbd.woff', weight: 'normal', style: 'normal' },
      { name: 'Roboto', url: 'fonts/roboto-v20-latin-regular.woff2', weight: '400', style: 'normal' }
    ];

    const fontFaces: string[] = [];
    this.loadedFonts.clear();

    for (const font of fonts) {
      try {
        const response = await fetch(font.url);
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          const blob = new Blob([buffer]);
          const base64 = await this.blobToBase64(blob);
          const format = font.url.endsWith('.woff') ? 'woff' : 'woff2';
          fontFaces.push(`
      @font-face {
        font-family: '${font.name}';
        src: url(${base64}) format('${format}');
        font-weight: ${font.weight};
        font-style: ${font.style};
      }`);

          try {
            const parsed = opentype.parse(buffer);
            this.loadedFonts.set(font.name.toLowerCase(), parsed);
          } catch {
            // Keep export working even if one font cannot be parsed for
            // outline conversion; text falls back to standard <text> output.
          }
        }
      } catch (e) {
        // Font not available, skip it
        console.warn(`Could not load font: ${font.name}`);
      }
    }

    return fontFaces.join('\n');
  }

  //
  // Convert a Blob to a base64 data URL.
  //
  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  //
  // Calculate the bounding box of all elements.
  //
  private calculateBounds() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    this.map.elements.forEach((model) => {
      if (model instanceof Box) {
        if (model.x < minX) minX = model.x;
        if (model.y < minY) minY = model.y;
        if (model.x + model.width > maxX) maxX = model.x + model.width;
        if (model.y + model.height > maxY) maxY = model.y + model.height;
      } else if (model instanceof Connector) {
        // Include connector endpoints
        const points = this.getConnectorPoints(model);
        points.forEach(p => {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        });
      }
    });

    // Handle empty map
    if (minX === Infinity) {
      minX = 0;
      minY = 0;
      maxX = 100;
      maxY = 100;
    }

    // Expand object bounds with background bounds (if present).
    const backgroundBounds = this.getBackgroundBounds();
    if (backgroundBounds) {
      minX = Math.min(minX, backgroundBounds.minX);
      minY = Math.min(minY, backgroundBounds.minY);
      maxX = Math.max(maxX, backgroundBounds.maxX);
      maxY = Math.max(maxY, backgroundBounds.maxY);
    }

    this.left = minX - this.padding;
    this.top = minY - this.padding;
    this.width = maxX - minX + this.padding * 2;
    this.height = maxY - minY + this.padding * 2;
  }

  // Get background image bounds in world coordinates (centered at 0,0).
  private getBackgroundBounds() {
    if (!this.backgroundDataUrl || this.backgroundWidth <= 0 || this.backgroundHeight <= 0) {
      return null;
    }

    const scalePercent = Number(this.map.settings.grid.backgroundScale ?? 100);
    const clampedScalePercent = Math.min(400, Math.max(0, scalePercent));
    if (clampedScalePercent <= 0) return null;

    // Export uses the same centered placement as render: background is
    // anchored around world origin and scaled by backgroundScale.
    const scale = clampedScalePercent / 100;
    const drawWidth = this.backgroundWidth * scale;
    const drawHeight = this.backgroundHeight * scale;

    return {
      minX: -drawWidth / 2,
      minY: -drawHeight / 2,
      maxX: drawWidth / 2,
      maxY: drawHeight / 2
    };
  }

  //
  // Get all points of a connector for bounds calculation.
  //
  private getConnectorPoints(conn: Connector): { x: number, y: number }[] {
    const points: { x: number, y: number }[] = [];

    if (conn.dockStart) {
      const pos = conn.dockStart.directionToPos(conn.startDir, false);
      points.push(pos);
    } else {
      points.push({ x: conn.startX, y: conn.startY });
    }

    if (conn.dockEnd) {
      const pos = conn.dockEnd.directionToPos(conn.endDir, false);
      points.push(pos);
    } else {
      points.push({ x: conn.endX, y: conn.endY });
    }

    return points;
  }

  //
  // Generate the complete SVG markup.
  //
  private generateSvg(fontStyles: string): string {
    const parts: string[] = [];

    // SVG header
    parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${this.left} ${this.top} ${this.width} ${this.height}" width="${this.width}" height="${this.height}">`);

    // Embedded fonts and optional hand-drawn filter.
    if (fontStyles || this.isHandDrawnEnabled()) {
      parts.push(`  <defs>`);

      if (fontStyles) {
        parts.push(`    <style type="text/css">`);
        parts.push(fontStyles);
        parts.push(`    </style>`);
      }

      if (this.isHandDrawnEnabled()) {
        // Mild displacement gives exported SVG a sketched look that better
        // matches canvas hand-drawn rendering.
        parts.push(`    <filter id="handdrawn-rough" x="-5%" y="-5%" width="110%" height="110%">`);
        parts.push(`      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="7" result="noise"/>`);
        parts.push(`      <feDisplacementMap in="SourceGraphic" in2="noise" scale="0.8" xChannelSelector="R" yChannelSelector="G"/>`);
        parts.push(`    </filter>`);
      }

      parts.push(`  </defs>`);
    }

    // Background color
    parts.push(`  <rect x="${this.left}" y="${this.top}" width="${this.width}" height="${this.height}" fill="${this.map.settings.grid.background}"/>`);

    // Optional background image, centered on map origin like in editor view.
    if (this.backgroundDataUrl && this.backgroundWidth > 0 && this.backgroundHeight > 0) {
      const scalePercent = Number(this.map.settings.grid.backgroundScale ?? 100);
      const clampedScalePercent = Math.min(400, Math.max(0, scalePercent));
      const opacityPercent = Number(this.map.settings.grid.backgroundOpacity ?? 100);
      const opacity = Math.min(100, Math.max(0, opacityPercent)) / 100;

      if (clampedScalePercent > 0 && opacity > 0) {
        const scale = clampedScalePercent / 100;
        const drawWidth = this.backgroundWidth * scale;
        const drawHeight = this.backgroundHeight * scale;
        const x = -drawWidth / 2;
        const y = -drawHeight / 2;

        parts.push(`  <image x="${x}" y="${y}" width="${drawWidth}" height="${drawHeight}" href="${this.backgroundDataUrl}" opacity="${opacity}" preserveAspectRatio="none"/>`);
      }
    }

    // Draw blocks first (behind everything)
    this.map.elements.forEach((model) => {
      if (model instanceof Block) {
        parts.push(this.renderBlock(model));
      }
    });

    // Draw connectors (behind rooms but above blocks)
    this.map.elements.forEach((model) => {
      if (model instanceof Connector) {
        parts.push(this.renderConnector(model));
      }
    });

    // Draw rooms and notes
    this.map.elements.forEach((model) => {
      if (model instanceof Room) {
        parts.push(this.renderRoom(model));
      } else if (model instanceof Note) {
        parts.push(this.renderNote(model));
      }
    });

    parts.push(`</svg>`);

    return parts.join('\n');
  }

  //
  // Convert LineStyle to SVG stroke-dasharray.
  //
  private lineStyleToDashArray(style: LineStyle): string {
    const arr = LineStyle.toArray(style);
    return arr.length > 0 ? arr.join(',') : 'none';
  }

  //
  // Generate SVG shape path for a box (room/note/block).
  //
  private getShapePath(box: Box): string {
    if (this.isHandDrawnEnabled()) {
      return this.getHandDrawnShapePath(box);
    }

    const x = box.x;
    const y = box.y;
    const w = box.width;
    const h = box.height;
    const r = Math.min(box.rounding || 0, w / 4, h / 4);

    switch (box.shape) {
      case RoomShape.Ellipse:
        const cx = x + w / 2;
        const cy = y + h / 2;
        const rx = w / 2;
        const ry = h / 2;
        return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} Z`;

      case RoomShape.Octagon:
        const cut = Math.min(w, h) * 0.25;
        return `M ${x + cut} ${y} L ${x + w - cut} ${y} L ${x + w} ${y + cut} L ${x + w} ${y + h - cut} L ${x + w - cut} ${y + h} L ${x + cut} ${y + h} L ${x} ${y + h - cut} L ${x} ${y + cut} Z`;

      default: // Rectangle with optional rounding
        if (r > 0) {
          return `M ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} L ${x + r} ${y + h} Q ${x} ${y + h} ${x} ${y + h - r} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} Z`;
        }
        return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
    }
  }

  private createSeededRandom(seed: number): () => number {
    let state = (seed >>> 0) || 1;
    return () => {
      state |= 0;
      state = (state + 0x6D2B79F5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  private roughLineCommands(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    rand: () => number,
    includeMove = false
  ): string {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const steps = Math.max(2, Math.ceil(len / 22));
    const nx = len > 0 ? -dy / len : 0;
    const ny = len > 0 ? dx / len : 0;
    const amp = Math.min(2.8, Math.max(0.5, len * 0.025));

    const commands: string[] = [];
    if (includeMove) {
      commands.push(`M ${x0} ${y0}`);
    }

    for (let i = 1; i <= steps; i++) {
      const t0 = (i - 1) / steps;
      const t1 = i / steps;
      const xm = x0 + dx * ((t0 + t1) * 0.5);
      const ym = y0 + dy * ((t0 + t1) * 0.5);
      const ex = x0 + dx * t1;
      const ey = y0 + dy * t1;

      const jitter = (rand() - 0.5) * 2 * amp;
      const cx = xm + nx * jitter;
      const cy = ym + ny * jitter;

      commands.push(`Q ${cx} ${cy} ${ex} ${ey}`);
    }

    return commands.join(' ');
  }

  private roughPolylinePath(points: Array<{ x: number, y: number }>, seed: number, closed: boolean): string {
    if (points.length < 2) return '';
    const rand = this.createSeededRandom(seed);
    const commands: string[] = [];

    commands.push(this.roughLineCommands(points[0].x, points[0].y, points[1].x, points[1].y, rand, true));

    for (let i = 1; i < points.length - 1; i++) {
      commands.push(this.roughLineCommands(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, rand, false));
    }

    if (closed) {
      commands.push(this.roughLineCommands(points[points.length - 1].x, points[points.length - 1].y, points[0].x, points[0].y, rand, false));
      commands.push('Z');
    }

    return commands.join(' ');
  }

  private roughEllipsePath(cx: number, cy: number, rx: number, ry: number, seed: number): string {
    const rand = this.createSeededRandom(seed);
    const steps = 24;
    const jitterScale = Math.min(2.4, Math.max(0.6, Math.min(rx, ry) * 0.03));
    const points: Array<{ x: number, y: number }> = [];

    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const radial = 1 + ((rand() - 0.5) * 2 * (jitterScale / Math.max(1, Math.min(rx, ry))));
      points.push({
        x: cx + Math.cos(t) * rx * radial,
        y: cy + Math.sin(t) * ry * radial
      });
    }

    return this.roughPolylinePath(points, seed + 17, true);
  }

  private getHandDrawnShapePath(box: Box): string {
    const x = box.x;
    const y = box.y;
    const w = box.width;
    const h = box.height;
    const seed = box.id * 131 + 17;

    if (box.shape === RoomShape.Ellipse) {
      return this.roughEllipsePath(x + w / 2, y + h / 2, w / 2, h / 2, seed);
    }

    if (box.shape === RoomShape.Octagon) {
      const cut = Math.min(w, h) * 0.25;
      const points = [
        { x: x + cut, y },
        { x: x + w - cut, y },
        { x: x + w, y: y + cut },
        { x: x + w, y: y + h - cut },
        { x: x + w - cut, y: y + h },
        { x: x + cut, y: y + h },
        { x, y: y + h - cut },
        { x, y: y + cut }
      ];
      return this.roughPolylinePath(points, seed, true);
    }

    const rectPoints = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h }
    ];
    return this.roughPolylinePath(rectPoints, seed, true);
  }

  private sampleQuadratic(
    x0: number,
    y0: number,
    cx: number,
    cy: number,
    x1: number,
    y1: number,
    count = 14
  ): Array<{ x: number, y: number }> {
    const points: Array<{ x: number, y: number }> = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const mt = 1 - t;
      points.push({
        x: mt * mt * x0 + 2 * mt * t * cx + t * t * x1,
        y: mt * mt * y0 + 2 * mt * t * cy + t * t * y1
      });
    }
    return points;
  }

  private sampleCubic(
    x0: number,
    y0: number,
    cx1: number,
    cy1: number,
    cx2: number,
    cy2: number,
    x1: number,
    y1: number,
    count = 18
  ): Array<{ x: number, y: number }> {
    const points: Array<{ x: number, y: number }> = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const mt = 1 - t;
      points.push({
        x: mt * mt * mt * x0 + 3 * mt * mt * t * cx1 + 3 * mt * t * t * cx2 + t * t * t * x1,
        y: mt * mt * mt * y0 + 3 * mt * mt * t * cy1 + 3 * mt * t * t * cy2 + t * t * t * y1
      });
    }
    return points;
  }

  //
  // Escape text for XML.
  //
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  //
  // Get SVG style attributes for a text segment.
  //
  private getSegmentStyle(segment: TextSegment): string {
    const styles: string[] = [];
    if (segment.bold) {
      styles.push('font-weight="bold"');
    }
    if (segment.italic) {
      styles.push('font-style="italic"');
    }
    return styles.length > 0 ? ' ' + styles.join(' ') : '';
  }

  private markdownToPlainText(text: string): string {
    return MarkdownParser.parse(text).map(segment => segment.text).join('');
  }

  private getOutlineFont(fontFamily: string): opentype.Font | null {
    const family = (fontFamily || '').trim().toLowerCase();
    if (family && this.loadedFonts.has(family)) {
      return this.loadedFonts.get(family);
    }

    const effective = this.getEffectiveFontFamily().toLowerCase();
    if (this.loadedFonts.has(effective)) {
      return this.loadedFonts.get(effective);
    }

    if (this.loadedFonts.has('roboto')) {
      return this.loadedFonts.get('roboto');
    }

    return null;
  }

  private buildOutlinedTextPath(
    text: string,
    x: number,
    y: number,
    fontSize: number,
    fontFamily: string,
    anchor: SvgTextAnchor,
    baselineMode: SvgTextBaselineMode = 'middle'
  ): string | null {
    if (!text) return null;

    const font = this.getOutlineFont(fontFamily);
    if (!font || !font.unitsPerEm) return null;

    try {
      const width = font.getAdvanceWidth(text, fontSize, { kerning: true });
      let drawX = x;
      if (anchor === 'middle') drawX -= width / 2;
      else if (anchor === 'end') drawX -= width;

      const scale = fontSize / font.unitsPerEm;
      let baselineY = y;

      if (baselineMode === 'middle') {
        const middleOffset = ((font.ascender + font.descender) / 2) * scale;
        baselineY = y + middleOffset;
      } else {
        // Canvas TextBaseline.Bottom positions y at the text bottom edge.
        // Convert that to a font baseline for glyph path generation.
        baselineY = y + font.descender * scale;
      }

      const path = font.getPath(text, drawX, baselineY, fontSize, { kerning: true });
      const pathData = path.toPathData(3);
      if (!pathData || /NaN|Infinity/.test(pathData)) return null;
      return pathData;
    } catch {
      return null;
    }
  }

  private renderPlainText(
    text: string,
    x: number,
    y: number,
    fontSize: number,
    fontFamily: string,
    color: string,
    anchor: SvgTextAnchor = 'middle',
    baselineMode: SvgTextBaselineMode = 'middle'
  ): string {
    if (!text) return '';

    if (this.shouldOutlineText()) {
      const outlined = this.buildOutlinedTextPath(text, x, y, fontSize, fontFamily, anchor, baselineMode);
      if (outlined) {
        return `    <path d="${outlined}" fill="${color}" stroke="none"/>`;
      }
    }

    const dominantBaseline = baselineMode === 'bottom' ? 'text-after-edge' : 'middle';
    return `    <text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="${dominantBaseline}" fill="${color}" font-size="${fontSize}" font-family="${fontFamily}">${this.escapeXml(text)}</text>`;
  }

  private lineHeight(fontSize: number): number {
    return Math.ceil(fontSize) + 1;
  }

  private measureTextWidth(text: string, fontSize: number, fontFamily: string): number {
    if (!text) return 0;

    const font = this.getOutlineFont(fontFamily);
    if (font) {
      return font.getAdvanceWidth(text, fontSize, { kerning: true });
    }

    // Fallback approximation when font metrics are unavailable.
    return text.length * fontSize * 0.6;
  }

  private wrapSegments(segments: TextSegment[], maxWidth: number, fontSize: number, fontFamily: string): TextSegment[][] {
    const safeWidth = Math.max(50, maxWidth);
    const lines: TextSegment[][] = [];
    let currentLine: TextSegment[] = [];
    let currentWidth = 0;

    for (const segment of segments) {
      const words = segment.text.split(' ');

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const wordWithSpace = i < words.length - 1 ? `${word} ` : word;
        const wordWidth = this.measureTextWidth(wordWithSpace, fontSize, fontFamily);

        if (currentWidth + wordWidth > safeWidth && currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = [];
          currentWidth = 0;
        }

        if (currentLine.length > 0) {
          const last = currentLine[currentLine.length - 1];
          if (last.bold === segment.bold && last.italic === segment.italic) {
            last.text += (last.text.endsWith(' ') || last.text === '' ? '' : ' ') + wordWithSpace;
          } else {
            currentLine.push({ text: wordWithSpace, bold: segment.bold, italic: segment.italic });
          }
        } else {
          currentLine.push({ text: wordWithSpace, bold: segment.bold, italic: segment.italic });
        }

        currentWidth += wordWidth;
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }

    for (const line of lines) {
      if (line.length > 0) {
        line[line.length - 1].text = line[line.length - 1].text.trimEnd();
      }
    }

    return lines.length > 0 ? lines : [[{ text: '', bold: false, italic: false }]];
  }

  private wrapMarkdownText(text: string, maxWidth: number, fontSize: number, fontFamily: string): TextSegment[][] {
    const paragraphs = text.split('\n');
    const wrapped: TextSegment[][] = [];

    for (const paragraph of paragraphs) {
      if (paragraph.trim() === '') {
        wrapped.push([{ text: '', bold: false, italic: false }]);
        continue;
      }

      const segments = MarkdownParser.parse(paragraph);
      wrapped.push(...this.wrapSegments(segments, maxWidth, fontSize, fontFamily));
    }

    return wrapped;
  }

  private splitMarkdownLines(text: string): TextSegment[][] {
    const lines = text.split('\n');
    return lines.length > 0
      ? lines.map(line => MarkdownParser.parse(line))
      : [[{ text: '', bold: false, italic: false }]];
  }

  private renderSegmentLine(
    segments: TextSegment[],
    x: number,
    y: number,
    fontSize: number,
    fontFamily: string,
    color: string,
    anchor: SvgTextAnchor,
    baselineMode: SvgTextBaselineMode = 'middle'
  ): string {
    const plain = segments.map(segment => segment.text).join('');

    if (this.shouldOutlineText()) {
      return this.renderPlainText(plain, x, y, fontSize, fontFamily, color, anchor, baselineMode);
    }

    const dominantBaseline = baselineMode === 'bottom' ? 'text-after-edge' : 'middle';
    let result = `    <text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="${dominantBaseline}" fill="${color}" font-size="${fontSize}" font-family="${fontFamily}">`;
    for (const segment of segments) {
      const style = this.getSegmentStyle(segment);
      if (style) {
        result += `<tspan${style}>${this.escapeXml(segment.text)}</tspan>`;
      } else {
        result += this.escapeXml(segment.text);
      }
    }
    result += `</text>`;
    return result;
  }

  private renderWrappedCenteredText(
    parts: string[],
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fontSize: number,
    fontFamily: string,
    color: string
  ): void {
    const lines = this.wrapMarkdownText(text, width, fontSize, fontFamily);
    const lineHeight = this.lineHeight(fontSize);
    const startY = y - (lines.length - 1) * lineHeight / 2 + height / 2;
    const xPos = x + width / 2;

    lines.forEach((line, index) => {
      parts.push(this.renderSegmentLine(line, xPos, startY + index * lineHeight, fontSize, fontFamily, color, 'middle'));
    });
  }

  private renderWrappedAlignedText(
    parts: string[],
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fontSize: number,
    fontFamily: string,
    color: string,
    align: TextAlign
  ): void {
    let horizontalPadding = 0;
    let availableWidth = width;

    if (align !== TextAlign.Center) {
      horizontalPadding = 4;
      availableWidth -= horizontalPadding;
    }

    const lines = this.wrapMarkdownText(text, availableWidth, fontSize, fontFamily);
    const lineHeight = this.lineHeight(fontSize);
    const startY = y - (lines.length - 1) * lineHeight / 2 + height / 2;

    const anchor: SvgTextAnchor = align === TextAlign.Left ? 'start' : align === TextAlign.Right ? 'end' : 'middle';
    const xPos = align === TextAlign.Left
      ? x + horizontalPadding
      : align === TextAlign.Right
        ? (x + availableWidth) - horizontalPadding
        : x + availableWidth / 2;

    lines.forEach((line, index) => {
      parts.push(this.renderSegmentLine(line, xPos, startY + index * lineHeight, fontSize, fontFamily, color, anchor));
    });
  }

  private renderWrappedBottomCenteredText(
    parts: string[],
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fontSize: number,
    fontFamily: string,
    color: string
  ): void {
    const lines = this.wrapMarkdownText(text, width, fontSize, fontFamily);
    const lineHeight = this.lineHeight(fontSize);
    const xPos = x + width / 2;
    const startBaselineY = y + height - (lines.length - 1) * lineHeight;

    lines.forEach((line, index) => {
      parts.push(this.renderSegmentLine(line, xPos, startBaselineY + index * lineHeight, fontSize, fontFamily, color, 'middle', 'bottom'));
    });
  }

  //
  // Render a single line of text with markdown support.
  //
  private renderMarkdownText(text: string, x: number, y: number, fontSize: number, fontFamily: string, color: string): string {
    if (this.shouldOutlineText()) {
      return this.renderPlainText(this.markdownToPlainText(text), x, y, fontSize, fontFamily, color, 'middle');
    }

    const segments = MarkdownParser.parse(text);
    let result = `    <text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" fill="${color}" font-size="${fontSize}" font-family="${fontFamily}">`;

    for (const segment of segments) {
      const style = this.getSegmentStyle(segment);
      if (style) {
        result += `<tspan${style}>${this.escapeXml(segment.text)}</tspan>`;
      } else {
        result += this.escapeXml(segment.text);
      }
    }

    result += `</text>`;
    return result;
  }

  //
  // Render a room to SVG.
  //
  private renderRoom(room: Room): string {
    const parts: string[] = [];
    const path = this.getShapePath(room);
    const dashArray = this.lineStyleToDashArray(room.lineStyle);
    const groupFilter = this.handDrawnFilterAttribute();

    parts.push(`  <g class="room"${groupFilter}>`);

    // Fill
    parts.push(`    <path d="${path}" fill="${room.fillColor}" stroke="none"/>`);

    // Darkness indicator (diagonal stripe in top-right)
    if (room.dark) {
      const darkColor = this.map.settings.room.darkColor;
      const stripeSize = Math.min(room.width, room.height) * 0.3;
      parts.push(`    <clipPath id="dark-clip-${room.id}">`);
      parts.push(`      <path d="${path}"/>`);
      parts.push(`    </clipPath>`);
      parts.push(`    <polygon points="${room.x + room.width - stripeSize},${room.y} ${room.x + room.width},${room.y} ${room.x + room.width},${room.y + stripeSize}" fill="${darkColor}" clip-path="url(#dark-clip-${room.id})"/>`);
    }

    // Border
    if (room.lineStyle !== LineStyle.None) {
      const strokeDash = dashArray !== 'none' ? ` stroke-dasharray="${dashArray}"` : '';
      parts.push(`    <path d="${path}" fill="none" stroke="${room.borderColor}" stroke-width="${room.lineWidth}"${strokeDash}/>`);
    }

    // Room name with markdown wrapping support (matches canvas drawText behavior).
    const fontSize = this.map.settings.basic.fontSize;
    const fontFamily = this.getEffectiveFontFamily();
    this.renderWrappedCenteredText(
      parts,
      room.name,
      room.x,
      room.y,
      room.width,
      room.height,
      fontSize,
      fontFamily,
      room.nameColor
    );

    // Subtitle with markdown support
    if (room.subtitle) {
      const subtitleSize = fontSize * 0.8;
      this.renderWrappedBottomCenteredText(
        parts,
        room.subtitle,
        room.x,
        room.y,
        room.width,
        room.height - 5,
        subtitleSize,
        fontFamily,
        room.subtitleColor
      );
    }

    parts.push(`  </g>`);

    return parts.join('\n');
  }

  //
  // Render a note to SVG.
  //
  private renderNote(note: Note): string {
    const parts: string[] = [];
    const path = this.getShapePath(note);
    const dashArray = this.lineStyleToDashArray(note.lineStyle);
    const groupFilter = this.handDrawnFilterAttribute();

    parts.push(`  <g class="note"${groupFilter}>`);

    // Fill
    parts.push(`    <path d="${path}" fill="${note.fillColor}" stroke="none"/>`);

    // Fold corner (diagonal line in corner)
    const foldSize = note.height * 0.15;
    parts.push(`    <line x1="${note.x + note.width - foldSize}" y1="${note.y}" x2="${note.x + note.width}" y2="${note.y + foldSize}" stroke="${note.borderColor}" stroke-width="${note.lineWidth / 2}"/>`);

    // Border
    if (note.lineStyle !== LineStyle.None) {
      const strokeDash = dashArray !== 'none' ? ` stroke-dasharray="${dashArray}"` : '';
      parts.push(`    <path d="${path}" fill="none" stroke="${note.borderColor}" stroke-width="${note.lineWidth}"${strokeDash}/>`);
    }

    // Text with markdown wrapping support (matches canvas drawText behavior).
    const fontSize = this.map.settings.basic.fontSize;
    const fontFamily = this.getEffectiveFontFamily();
    const noteTextAlign = this.map.settings.note.alignment;
    this.renderWrappedAlignedText(
      parts,
      note.text,
      note.x,
      note.y,
      note.width,
      note.height,
      fontSize,
      fontFamily,
      note.textColor,
      noteTextAlign
    );

    parts.push(`  </g>`);

    return parts.join('\n');
  }

  //
  // Render a block to SVG.
  //
  private renderBlock(block: Block): string {
    const parts: string[] = [];
    const path = this.getShapePath(block);
    const dashArray = this.lineStyleToDashArray(block.lineStyle);
    const groupFilter = this.handDrawnFilterAttribute();

    parts.push(`  <g class="block"${groupFilter}>`);

    // Fill
    parts.push(`    <path d="${path}" fill="${block.fillColor}" stroke="none"/>`);

    // Border
    if (block.lineStyle !== LineStyle.None) {
      const strokeDash = dashArray !== 'none' ? ` stroke-dasharray="${dashArray}"` : '';
      parts.push(`    <path d="${path}" fill="none" stroke="${block.borderColor}" stroke-width="${block.lineWidth}"${strokeDash}/>`);
    }

    parts.push(`  </g>`);

    return parts.join('\n');
  }

  //
  // Render a connector to SVG.
  //
  private renderConnector(conn: Connector): string {
    const parts: string[] = [];
    const dashArray = this.lineStyleToDashArray(conn.lineStyle);
    const groupFilter = this.handDrawnFilterAttribute();

    // Get start and end points
    let startX: number, startY: number, endX: number, endY: number;
    let startDir: Direction, endDir: Direction;

    if (conn.dockStart) {
      const pos = conn.dockStart.directionToPos(conn.startDir, false);
      startX = pos.x;
      startY = pos.y;
      startDir = conn.startDir;
    } else {
      startX = conn.startX;
      startY = conn.startY;
      startDir = conn.startDir;
    }

    if (conn.dockEnd) {
      const pos = conn.dockEnd.directionToPos(conn.endDir, false);
      endX = pos.x;
      endY = pos.y;
      endDir = conn.endDir;
    } else {
      endX = conn.endX;
      endY = conn.endY;
      endDir = conn.endDir;
    }

    parts.push(`  <g class="connector"${groupFilter}>`);

    // Draw connector path
    let pathD: string;
    if (conn.isCurve && conn.dockStart && conn.dockEnd) {
      // Curved connector (cubic Bezier)
      const stalkLength = 15;
      const { x: vx1, y: vy1 } = Direction.toVector(startDir);
      const { x: vx2, y: vy2 } = Direction.toVector(endDir);

      const cp1x = startX + vx1 * stalkLength * 3;
      const cp1y = startY + vy1 * stalkLength * 3;
      const cp2x = endX + vx2 * stalkLength * 3;
      const cp2y = endY + vy2 * stalkLength * 3;

      if (this.isHandDrawnEnabled()) {
        const points = this.sampleCubic(startX, startY, cp1x, cp1y, cp2x, cp2y, endX, endY, 18);
        pathD = this.roughPolylinePath(points, conn.id * 313 + 29, false);
      } else {
        pathD = `M ${startX} ${startY} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${endX} ${endY}`;
      }
    } else {
      // Straight connector with stalks
      const stalkLength = 15;
      const { x: vx1, y: vy1 } = Direction.toVector(startDir);
      const { x: vx2, y: vy2 } = Direction.toVector(endDir);

      const stalk1x = startX + vx1 * stalkLength;
      const stalk1y = startY + vy1 * stalkLength;
      const stalk2x = endX + vx2 * stalkLength;
      const stalk2y = endY + vy2 * stalkLength;

      if (this.isHandDrawnEnabled()) {
        pathD = this.roughPolylinePath([
          { x: startX, y: startY },
          { x: stalk1x, y: stalk1y },
          { x: stalk2x, y: stalk2y },
          { x: endX, y: endY }
        ], conn.id * 313 + 31, false);
      } else {
        pathD = `M ${startX} ${startY} L ${stalk1x} ${stalk1y} L ${stalk2x} ${stalk2y} L ${endX} ${endY}`;
      }
    }

    const strokeDash = dashArray !== 'none' ? ` stroke-dasharray="${dashArray}"` : '';
    parts.push(`    <path d="${pathD}" fill="none" stroke="${conn.color}" stroke-width="${conn.lineWidth}" stroke-linecap="round" stroke-linejoin="round"${strokeDash}/>`);

    // One-way arrows
    if (conn.oneWay) {
      // Draw arrow at 50% along the path
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2;
      const angle = Math.atan2(endY - startY, endX - startX);

      const arrowSize = 8;
      const arrowPoints = this.getArrowPoints(midX, midY, angle, arrowSize);
      parts.push(`    <polygon points="${arrowPoints}" fill="${conn.color}"/>`);
    }

    // Connector name label
    if (conn.name) {
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2;
      const fontSize = this.map.settings.basic.fontSize * 0.7;
      const fontFamily = this.getEffectiveFontFamily();
      const maxWidth = Math.max(0, conn.nameMaxWidth || 0);
      const padding = 4;
      const rawTextWidth = this.measureTextWidth(conn.name, fontSize, fontFamily);
      const textAreaWidth = maxWidth > 0 ? Math.min(rawTextWidth, maxWidth) : rawTextWidth;
      const lineHeight = this.lineHeight(fontSize);
      const wrappedLines = maxWidth > 0
        ? this.wrapMarkdownText(conn.name, textAreaWidth, fontSize, fontFamily)
        : this.splitMarkdownLines(conn.name);
      const textAreaHeight = wrappedLines.length * lineHeight;

      const labelW = textAreaWidth + padding * 2;
      const labelH = textAreaHeight + padding * 2;
      const labelX = midX - labelW / 2;
      const labelY = midY - labelH / 2;

      if (this.isHandDrawnEnabled()) {
        const labelPath = this.roughPolylinePath([
          { x: labelX, y: labelY },
          { x: labelX + labelW, y: labelY },
          { x: labelX + labelW, y: labelY + labelH },
          { x: labelX, y: labelY + labelH }
        ], conn.id * 313 + 43, true);
        parts.push(`    <path d="${labelPath}" fill="white" stroke="black" stroke-width="1"/>`);
      } else {
        parts.push(`    <rect x="${labelX}" y="${labelY}" width="${labelW}" height="${labelH}" fill="white" stroke="black" stroke-width="1" rx="3"/>`);
      }

      const lineStartY = labelY + padding + lineHeight / 2;
      wrappedLines.forEach((line, index) => {
        parts.push(this.renderSegmentLine(line, midX, lineStartY + index * lineHeight, fontSize, fontFamily, '#000000', 'middle'));
      });
    }

    parts.push(`  </g>`);

    return parts.join('\n');
  }

  //
  // Get arrow polygon points.
  //
  private getArrowPoints(x: number, y: number, angle: number, size: number): string {
    const points: { x: number, y: number }[] = [
      { x: x + Math.cos(angle) * size, y: y + Math.sin(angle) * size },
      { x: x + Math.cos(angle + 2.5) * size, y: y + Math.sin(angle + 2.5) * size },
      { x: x + Math.cos(angle - 2.5) * size, y: y + Math.sin(angle - 2.5) * size }
    ];
    return points.map(p => `${p.x},${p.y}`).join(' ');
  }

  //
  // Download the SVG as a file.
  //
  private download(svg: string) {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    let title = this.map.title;
    if (!title) title = "untitled";

    // Use same download mechanism as PNG export
    if ((navigator as any).msSaveBlob) {
      (navigator as any).msSaveBlob(blob, `${title}.svg`);
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${title}.svg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }
}
