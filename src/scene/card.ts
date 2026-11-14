// A monolith's size and its face. The face is drawn on a canvas and used as
// a texture: one draw call per side, fonts from the page (no font fetch from
// a worker, which the CSP would have to allow), and it stays readable.

import { formatRows } from '../schema/graph';
import type { Column, Index, Table } from '../schema/types';

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

/** Folded, a face still lists its key columns (the ones relationships hang on), up to this many. */
const MAX_KEYS = 6;
/** The colors of a primary key and of a foreign key, on the faces and on the ends of the lines. */
export const KEY_COLOR = { pk: '#fbbf24', fk: '#67e8f9' } as const;
/** Indexes, and the one being tried out. */
const INDEX_COLOR = '#c4b5fd';
const WHAT_IF_COLOR = '#5eead4';
/** Unfolded, a face lists its indexes under the columns, up to this many, after a gap that holds the heading. */
const MAX_INDEXES = 5;
const INDEX_GAP = 0.26;

type Listed = Pick<Table, 'columns' | 'fks'> & { indexes?: Index[] };

/** The rows the index list takes on an unfolded face, the "+ n more" row included. */
const indexRows = (table: Listed) => Math.min(table.indexes?.length ?? 0, MAX_INDEXES) + ((table.indexes?.length ?? 0) > MAX_INDEXES ? 1 : 0);
type Face = { rows: Column[]; /** Columns that are not listed. */ more: number; /** Whether the "+ n more" row is always there (a line may end on it). */ footer: boolean };
const faces = new WeakMap<Listed, [folded: Face, unfolded: Face]>();

/** The rows on a table's face: every column when unfolded, only the keys when folded. */
export function faceRows(table: Listed, expanded: boolean): Face {
  let hit = faces.get(table);
  if (!hit) {
    const keys = table.columns.filter((c) => c.pk || table.fks.some((f) => f.column === c.name));
    const all = table.columns.slice(0, MAX_ROWS);
    const some = keys.slice(0, MAX_KEYS);
    hit = [
      { rows: some, more: table.columns.length - some.length, footer: keys.length > MAX_KEYS },
      { rows: all, more: table.columns.length - all.length, footer: table.columns.length > MAX_ROWS },
    ];
    faces.set(table, hit);
  }
  return hit[expanded ? 1 : 0];
}

/** A monolith is as tall as its row count makes it, and never shorter than the rows on its face. */
export function heightOf(table: Listed, rows: number, expanded: boolean): number {
  const face = faceRows(table, expanded);
  const indexes = expanded ? indexRows(table) : 0;
  return Math.max(foldedHeight(rows), HEADER_H + (face.rows.length + (face.footer ? 1 : 0) + indexes) * ROW_H + (indexes ? INDEX_GAP : 0) + PAD * 2);
}

/** Where a column's row sits, as a height above the monolith's centre; the header when the face doesn't list it. */
export function columnY(table: Table, column: string, height: number, expanded: boolean): number {
  const face = faceRows(table, expanded);
  let i = face.rows.findIndex((c) => c.name === column);
  if (i < 0) {
    if (!face.footer || !table.columns.some((c) => c.name === column)) return height / 2 - HEADER_H / 2;
    i = face.rows.length;
  }
  return height / 2 - HEADER_H - PAD - (i + 0.5) * ROW_H;
}

export type CardStyle = {
  color: string;
  expanded: boolean;
  rows: number;
  ghost?: boolean;
  subtitle?: string;
  selected?: boolean;
  /** Columns at the end of a highlighted relationship: their rows light up. */
  linked?: ReadonlySet<string> | null;
};

const FONT_HEAD = '600 50px "Space Grotesk", "Inter", system-ui, sans-serif';
const FONT_META = '500 27px "JetBrains Mono", ui-monospace, monospace';
const FONT_ROW = '500 27px "JetBrains Mono", ui-monospace, monospace';
const FONT_REF = '500 22px "JetBrains Mono", ui-monospace, monospace';
const FONT_BADGE = '600 19px "JetBrains Mono", ui-monospace, monospace';

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 3 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

const shortType = (t: string) => t.replace('timestamptz', 'timestamp').replace(/^varchar/, 'varchar');

/** Draws a table's face. The canvas is resized to the card's height. */
export function drawCard(canvas: HTMLCanvasElement, table: Pick<Table, 'name' | 'columns' | 'fks'> & { indexes?: Index[] }, height: number, style: CardStyle): void {
  const w = Math.round(CARD_W * PX);
  const h = Math.round(height * PX);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  const pad = 30;
  const fkOf = new Map(table.fks.map((f) => [f.column, f]));
  const pks = table.columns.filter((c) => c.pk).length;
  const { color } = style;
  const indexes = table.indexes ?? [];
  // how a lookup by each column is served: "uq" by a unique index on it alone, "ix" by an index it leads
  const served = new Map<string, 'uq' | 'ix'>();
  for (const ix of indexes) {
    const one = ix.unique && ix.columns.length === 1;
    if (one || !served.has(ix.columns[0])) served.set(ix.columns[0], one ? 'uq' : 'ix');
  }

  // a dark pane behind the text keeps it readable over any backdrop; the header carries the domain's color
  const headPx = HEADER_H * PX;
  if (!style.ghost) {
    const pane = ctx.createLinearGradient(0, 0, 0, h);
    pane.addColorStop(0, 'rgba(7,12,24,0.84)');
    pane.addColorStop(1, 'rgba(4,7,14,0.62)');
    ctx.fillStyle = pane;
    ctx.fillRect(0, 0, w, h);
    const band = ctx.createLinearGradient(0, 0, w, headPx);
    band.addColorStop(0, `${color}${style.selected ? 'b8' : '80'}`);
    band.addColorStop(1, `${color}${style.selected ? '40' : '1a'}`);
    ctx.fillStyle = band;
    ctx.fillRect(0, 0, w, headPx);
    const sheen = ctx.createLinearGradient(0, 0, 0, headPx * 0.6);
    sheen.addColorStop(0, 'rgba(255,255,255,0.12)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, w, headPx * 0.6);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 9, headPx);
    ctx.fillStyle = `${color}${style.selected ? 'ff' : '99'}`;
    ctx.fillRect(0, headPx - 3, w, 3);
  }

  // header: a small table glyph, the name, then the size and the key counts
  ctx.textBaseline = 'middle';
  const ink = style.ghost ? color : '#f8fafc';
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(pad, 31, 38, 34, 7);
  ctx.stroke();
  ctx.fillRect(pad, 41, 38, 3);
  ctx.fillRect(pad + 13, 42, 3, 22);
  ctx.font = FONT_HEAD;
  ctx.fillText(fit(ctx, table.name, w - pad * 2 - 54), pad + 54, 50);
  ctx.font = FONT_META;
  ctx.fillStyle = style.ghost ? color : '#e2e8f0';
  const meta = style.subtitle ?? `${formatRows(style.rows)} rows · ${table.columns.length} cols`;
  const fkText = fkOf.size ? `  FK ${fkOf.size}` : '';
  const ixText = indexes.length ? `  IX ${indexes.length}` : '';
  const keysW = ctx.measureText(`PK ${pks}${fkText}${ixText}`).width;
  ctx.globalAlpha = style.ghost ? 1 : 0.82;
  ctx.fillText(fit(ctx, meta, w - pad * 2 - keysW - 24), pad, 104);
  ctx.globalAlpha = 1;
  // key counts, right-aligned
  ctx.textAlign = 'right';
  ctx.fillStyle = KEY_COLOR.pk;
  ctx.fillText(`PK ${pks}`, w - pad - ctx.measureText(fkText + ixText).width, 104);
  ctx.fillStyle = KEY_COLOR.fk;
  ctx.fillText(fkText, w - pad - ctx.measureText(ixText).width, 104);
  ctx.fillStyle = INDEX_COLOR;
  ctx.fillText(ixText, w - pad, 104);
  ctx.textAlign = 'left';

  const { rows: shown, more, footer } = faceRows(table, style.expanded);
  const top = HEADER_H * PX + PAD * PX;
  const rowPx = ROW_H * PX;
  if (style.ghost && style.expanded) {
    ctx.strokeStyle = `${color}66`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad, top - PAD * PX * 0.6);
    ctx.lineTo(w - pad, top - PAD * PX * 0.6);
    ctx.stroke();
  }

  const nameX = pad + 58;
  shown.forEach((c: Column, i) => {
    const y = top + (i + 0.5) * rowPx;
    const fk = fkOf.get(c.name);
    const key = c.pk ? KEY_COLOR.pk : fk ? KEY_COLOR.fk : null;
    const lit = !!style.linked?.has(c.name);
    if (style.ghost) {
      ctx.font = FONT_ROW;
      ctx.fillStyle = key ?? '#475569';
      ctx.fillText(c.pk ? '◆' : fk ? '→' : '·', pad, y);
    } else if (key) {
      // key rows are tinted, and tabbed on both edges where their lines plug in
      ctx.fillStyle = `${key}${lit ? '47' : '1a'}`;
      if (lit) {
        // edge to edge: the row carries on around the slab's side as the pad its line plugs into
        ctx.fillRect(0, y - rowPx / 2 + 3, w, rowPx - 6);
        ctx.fillStyle = key;
        ctx.fillRect(0, y - rowPx / 2 + 3, w, 2.5);
        ctx.fillRect(0, y + rowPx / 2 - 5.5, w, 2.5);
        ctx.fillRect(0, y - rowPx / 2 + 3, 9, rowPx - 6);
        ctx.fillRect(w - 9, y - rowPx / 2 + 3, 9, rowPx - 6);
      } else {
        ctx.beginPath();
        ctx.roundRect(12, y - rowPx / 2 + 3, w - 24, rowPx - 6, 8);
        ctx.fill();
        ctx.fillStyle = `${key}b0`;
        ctx.fillRect(0, y - rowPx / 2 + 8, 6, rowPx - 16);
        ctx.fillRect(w - 6, y - rowPx / 2 + 8, 6, rowPx - 16);
      }
      // the PK / FK badge
      ctx.fillStyle = lit ? key : `${key}2e`;
      ctx.beginPath();
      ctx.roundRect(pad - 8, y - 14, 46, 28, 7);
      ctx.fill();
      ctx.font = FONT_BADGE;
      ctx.textAlign = 'center';
      ctx.fillStyle = lit ? '#07101d' : key;
      ctx.fillText(c.pk ? 'PK' : 'FK', pad + 15, y + 1.5);
      ctx.textAlign = 'left';
    } else {
      if (i % 2 === 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(12, y - rowPx / 2, w - 24, rowPx);
      }
      ctx.fillStyle = '#475569';
      ctx.beginPath();
      ctx.arc(pad + 15, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // on the right: what a foreign key points at, or the column's type
    const room = w - pad - nameX;
    ctx.textAlign = 'right';
    let rightW: number;
    if (fk && !style.ghost) {
      ctx.font = FONT_ROW;
      const nameW = ctx.measureText(c.name).width;
      ctx.font = FONT_REF;
      const ref = fit(ctx, `→ ${fk.refTable}.${fk.refColumn}`, Math.max(room * 0.42, room - nameW - 18));
      rightW = ctx.measureText(ref).width;
      ctx.fillStyle = lit ? '#ecfeff' : '#5cc4d8';
      ctx.fillText(ref, w - pad, y + 1);
    } else {
      ctx.font = FONT_ROW;
      const type = shortType(c.type) + (c.nullable ? '?' : '');
      rightW = ctx.measureText(type).width;
      ctx.fillStyle = '#64748b';
      ctx.fillText(type, w - pad, y);
    }
    ctx.textAlign = 'left';
    ctx.font = FONT_ROW;
    ctx.fillStyle = lit ? '#ffffff' : c.pk ? '#fde68a' : fk ? '#a5f3fc' : '#cbd5e1';
    const mark = style.ghost ? undefined : served.get(c.name);
    const name = fit(ctx, c.name, room - rightW - 18 - (mark ? 38 : 0));
    ctx.fillText(name, nameX, y);
    if (mark) {
      // indexed columns say so, which matters most on a foreign key
      const x = nameX + ctx.measureText(name).width + 10;
      ctx.font = FONT_BADGE;
      ctx.fillStyle = INDEX_COLOR;
      ctx.fillText(mark, x, y - 7);
    }
  });

  // what the face leaves out; folded, only where the monolith is tall enough to have the room
  const fits = Math.floor((h - top - PAD * PX) / rowPx + 0.01) > shown.length;
  if (more > 0 && (footer || (shown.length > 0 && fits))) {
    ctx.font = FONT_ROW;
    ctx.fillStyle = '#64748b';
    ctx.fillText(`+ ${more} more columns`, nameX, top + (shown.length + 0.5) * rowPx);
  }

  // unfolded, the indexes are listed under the columns
  if (!style.expanded || style.ghost || !indexes.length) return;
  const gap = INDEX_GAP * PX;
  const y0 = top + (shown.length + (footer ? 1 : 0)) * rowPx;
  ctx.fillStyle = `${INDEX_COLOR}40`;
  ctx.fillRect(pad - 8, y0 + 8, w - pad * 2 + 16, 2);
  ctx.font = FONT_BADGE;
  ctx.fillStyle = `${INDEX_COLOR}cc`;
  ctx.fillText('INDEXES', pad - 8, y0 + gap - 9);
  indexes.slice(0, MAX_INDEXES).forEach((ix, i) => {
    const y = y0 + gap + (i + 0.5) * rowPx;
    const tone = ix.whatIf ? WHAT_IF_COLOR : INDEX_COLOR;
    ctx.fillStyle = `${tone}2e`;
    ctx.beginPath();
    ctx.roundRect(pad - 8, y - 14, 46, 28, 7);
    ctx.fill();
    if (ix.whatIf) {
      // not in the database yet: outlined in dashes, like the ghosts
      ctx.strokeStyle = tone;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.font = FONT_BADGE;
    ctx.textAlign = 'center';
    ctx.fillStyle = tone;
    ctx.fillText(ix.unique ? 'UQ' : 'IX', pad + 15, y + 1.5);
    ctx.textAlign = 'right';
    ctx.font = FONT_REF;
    const note = ix.whatIf ? 'what-if' : ix.unique ? 'unique' : '';
    ctx.fillStyle = ix.whatIf ? tone : '#64748b';
    ctx.fillText(note, w - pad, y + 1);
    const noteW = note ? ctx.measureText(note).width + 18 : 0;
    ctx.textAlign = 'left';
    ctx.font = FONT_ROW;
    ctx.fillStyle = ix.whatIf ? '#ccfbf1' : '#ddd6fe';
    ctx.fillText(fit(ctx, `(${ix.columns.join(', ')})`, w - pad - nameX - noteW), nameX, y);
  });
  if (indexes.length > MAX_INDEXES) {
    ctx.font = FONT_ROW;
    ctx.fillStyle = '#64748b';
    ctx.fillText(`+ ${indexes.length - MAX_INDEXES} more indexes`, nameX, y0 + gap + (MAX_INDEXES + 0.5) * rowPx);
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
