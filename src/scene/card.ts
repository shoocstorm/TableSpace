// A monolith's size and its face. The face is drawn on a canvas and used as
// a texture: one draw call per side, fonts from the page (no font fetch from
// a worker, which the CSP would have to allow), and it stays readable.

import { formatRows } from '../schema/graph';
import type { Column, Table } from '../schema/types';

export const CARD_W = 3.6;
const HEADER_H = 0.92;
const ROW_H = 0.3;
const PAD = 0.16;
/** Canvas pixels per world unit. */
const PX = 150;
/** More columns than this are summed up in a last "+ n more" row. */
export const MAX_ROWS = 14;

/** Folded, a monolith's height comes from its row count (log scale). */
export const foldedHeight = (rows: number) => 1.25 + Math.log10(rows + 1) * 0.5;
/** So does its depth: volume grows with the data. */
export const depthOf = (rows: number) => 0.4 + Math.log10(rows + 1) * 0.17;

export const shownRows = (columns: number) => Math.min(columns, MAX_ROWS) + (columns > MAX_ROWS ? 1 : 0);
export const unfoldedHeight = (columns: number) => HEADER_H + shownRows(columns) * ROW_H + PAD * 2;
export const heightOf = (rows: number, columns: number, expanded: boolean) => (expanded ? Math.max(foldedHeight(rows), unfoldedHeight(columns)) : foldedHeight(rows));

/** Where a column's row sits, as a height above the monolith's centre; the header when it isn't shown. */
export function columnY(table: Table, column: string, height: number, expanded: boolean): number {
  const i = table.columns.findIndex((c) => c.name === column);
  if (!expanded || i < 0) return height / 2 - HEADER_H / 2;
  const row = Math.min(i, MAX_ROWS);
  return height / 2 - HEADER_H - PAD - (row + 0.5) * ROW_H;
}

export type CardStyle = { color: string; expanded: boolean; rows: number; ghost?: boolean; subtitle?: string };

const FONT_HEAD = '600 50px "Space Grotesk", "Inter", system-ui, sans-serif';
const FONT_META = '500 27px "JetBrains Mono", ui-monospace, monospace';
const FONT_ROW = '500 27px "JetBrains Mono", ui-monospace, monospace';

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 3 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

const shortType = (t: string) => t.replace('timestamptz', 'timestamp').replace(/^varchar/, 'varchar');

/** Draws a table's face. The canvas is resized to the card's height. */
export function drawCard(canvas: HTMLCanvasElement, table: Pick<Table, 'name' | 'columns' | 'fks'>, height: number, style: CardStyle): void {
  const w = Math.round(CARD_W * PX);
  const h = Math.round(height * PX);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  const pad = 30;
  const fkCols = new Set(table.fks.map((f) => f.column));
  const pks = table.columns.filter((c) => c.pk).length;

  // a dark pane behind the text keeps it readable over any backdrop; the header carries the domain's color
  const headPx = HEADER_H * PX;
  if (!style.ghost) {
    ctx.fillStyle = 'rgba(5,9,17,0.6)';
    ctx.fillRect(0, 0, w, h);
    const band = ctx.createLinearGradient(0, 0, w, 0);
    band.addColorStop(0, `${style.color}66`);
    band.addColorStop(1, `${style.color}14`);
    ctx.fillStyle = band;
    ctx.fillRect(0, 0, w, headPx);
    ctx.fillStyle = style.color;
    ctx.fillRect(0, 0, 9, headPx);
    ctx.fillStyle = `${style.color}55`;
    ctx.fillRect(0, headPx - 2, w, 2);
  }

  // header
  ctx.textBaseline = 'middle';
  ctx.fillStyle = style.ghost ? style.color : '#f1f5f9';
  ctx.font = FONT_HEAD;
  ctx.fillText(fit(ctx, table.name, w - pad * 2), pad, 50);
  ctx.font = FONT_META;
  ctx.fillStyle = style.color;
  const meta = style.subtitle ?? `${formatRows(style.rows)} rows · ${table.columns.length} cols`;
  const fkText = fkCols.size ? `  FK ${fkCols.size}` : '';
  const keysW = ctx.measureText(`PK ${pks}${fkText}`).width;
  ctx.fillText(fit(ctx, meta, w - pad * 2 - keysW - 24), pad, 104);
  // key counts, right-aligned
  ctx.textAlign = 'right';
  ctx.fillStyle = '#fbbf24';
  ctx.fillText(`PK ${pks}`, w - pad - ctx.measureText(fkText).width, 104);
  ctx.fillStyle = '#67e8f9';
  ctx.fillText(fkText, w - pad, 104);
  ctx.textAlign = 'left';

  if (!style.expanded) return;
  const top = HEADER_H * PX + PAD * PX;
  if (style.ghost) {
    ctx.strokeStyle = `${style.color}66`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad, top - PAD * PX * 0.6);
    ctx.lineTo(w - pad, top - PAD * PX * 0.6);
    ctx.stroke();
  }

  ctx.font = FONT_ROW;
  const rowPx = ROW_H * PX;
  const shown = table.columns.slice(0, MAX_ROWS);
  shown.forEach((c: Column, i) => {
    const y = top + (i + 0.5) * rowPx;
    const isFk = fkCols.has(c.name);
    if (!style.ghost && (c.pk || isFk)) {
      // key rows are tinted, so the columns that relationships hang on stand out
      ctx.fillStyle = c.pk ? 'rgba(251,191,36,0.1)' : 'rgba(103,232,249,0.09)';
      ctx.fillRect(12, y - rowPx / 2 + 2, w - 24, rowPx - 4);
    } else if (!style.ghost && i % 2 === 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(12, y - rowPx / 2, w - 24, rowPx);
    }
    ctx.fillStyle = c.pk ? '#fbbf24' : isFk ? '#67e8f9' : '#475569';
    ctx.fillText(c.pk ? '◆' : isFk ? '→' : '·', pad, y);
    const type = shortType(c.type) + (c.nullable ? '?' : '');
    ctx.textAlign = 'right';
    ctx.fillStyle = '#64748b';
    ctx.fillText(type, w - pad, y);
    const typeW = ctx.measureText(type).width;
    ctx.textAlign = 'left';
    ctx.fillStyle = c.pk ? '#fde68a' : isFk ? '#a5f3fc' : '#cbd5e1';
    ctx.fillText(fit(ctx, c.name, w - pad * 2 - 40 - typeW - 16), pad + 40, y);
  });
  if (table.columns.length > MAX_ROWS) {
    ctx.fillStyle = '#64748b';
    ctx.fillText(`+ ${table.columns.length - MAX_ROWS} more columns`, pad + 40, top + (MAX_ROWS + 0.5) * rowPx);
  }
}

/** A small label on a canvas: cardinality tags and warning badges. */
export function drawPill(canvas: HTMLCanvasElement, text: string, opts: { color: string; fill: string; font?: string; icon?: string; /** The outline, when it differs from the text. */ stroke?: string }): { w: number; h: number } {
  const ctx = canvas.getContext('2d')!;
  const font = opts.font ?? '600 30px "JetBrains Mono", ui-monospace, monospace';
  ctx.font = font;
  const label = opts.icon ? `${opts.icon} ${text}` : text;
  const w = Math.ceil(ctx.measureText(label).width) + 44;
  const h = 60;
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  ctx.fillStyle = opts.fill;
  ctx.strokeStyle = opts.stroke ?? opts.color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, h - 4, 18);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = opts.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(label, w / 2, h / 2 + 2);
  return { w, h };
}
