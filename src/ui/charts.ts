// Canvas charts drawn to one scale, with a crosshair and a tooltip. Colors come from theme tokens.
import type { Bar } from '../data.ts';
import { fmtDate, fmtDateShort } from '../time.ts';
import { clear, cssVar, fmtNum, fmtPct, h } from './dom.ts';

export type MarkerKind = 'QUAL' | 'ENTRY' | 'ADD' | 'TRIM' | 'EXIT';

export interface ChartMarker {
  idx: number;
  kind: MarkerKind;
  real: boolean; // a recorded real transaction (solid) vs an algorithm signal (hollow)
  label: string;
}

export interface PriceChartData {
  bars: Bar[];
  sma: (number | null)[];
  smaLabel?: string; // default 'SMA200'
  /** A second, faster moving average (SMA50 for the crossover strategy). */
  fast?: { values: (number | null)[]; label: string } | null;
  /** Draw the Claude V2 entry/exit threshold band around the SMA (default true). */
  bands?: boolean;
  entryPct: number;
  exitPct: number;
  markers: ChartMarker[];
  log: boolean;
  live: { price: number; at: string } | null;
}

interface Palette {
  surface: string; grid: string; axis: string; text: string; text2: string; text3: string;
  accent: string; bull: string; risk: string; wait: string; band: string;
}

function palette(): Palette {
  return {
    surface: cssVar('--panel'), grid: cssVar('--grid'), axis: cssVar('--line-strong'), text: cssVar('--fg'),
    text2: cssVar('--fg-2'), text3: cssVar('--fg-3'), accent: cssVar('--sma'), bull: cssVar('--bull'),
    risk: cssVar('--risk'), wait: cssVar('--wait'), band: cssVar('--band'),
  };
}

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

function linearTicks(min: number, max: number, target = 5): number[] {
  const step = niceStep(max - min, target);
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

function logTicks(min: number, max: number): number[] {
  const out: number[] = [];
  const seq = [1, 2, 5];
  for (let e = Math.floor(Math.log10(min)) - 1; e <= Math.ceil(Math.log10(max)); e++) {
    for (const m of seq) {
      const v = m * Math.pow(10, e);
      if (v >= min && v <= max) out.push(v);
    }
  }
  if (out.length < 3) return linearTicks(min, max, 4);
  if (out.length > 7) return out.filter((_, i) => i % 2 === 0);
  return out;
}

function setupCanvas(canvas: HTMLCanvasElement, host: HTMLElement): { ctx: CanvasRenderingContext2D; w: number; hgt: number } | null {
  const w = host.clientWidth;
  const hgt = host.clientHeight;
  if (w < 20 || hgt < 20) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hgt * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = hgt + 'px';
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, hgt };
}

function dateTicks(dates: string[], plotW: number): number[] {
  const n = dates.length;
  if (!n) return [];
  const maxTicks = Math.max(2, Math.floor(plotW / 78));
  const spans: ((a: string, b: string) => boolean)[] = [
    (a, b) => a.slice(0, 7) !== b.slice(0, 7), // month
    (a, b) => a.slice(0, 7) !== b.slice(0, 7) && ['01', '04', '07', '10'].includes(b.slice(5, 7)), // quarter
    (a, b) => a.slice(0, 4) !== b.slice(0, 4), // year
    (a, b) => a.slice(0, 4) !== b.slice(0, 4) && Number(b.slice(0, 4)) % 2 === 0,
    (a, b) => a.slice(0, 4) !== b.slice(0, 4) && Number(b.slice(0, 4)) % 5 === 0,
  ];
  for (const f of spans) {
    const idx: number[] = [];
    for (let i = 1; i < n; i++) if (f(dates[i - 1], dates[i])) idx.push(i);
    if (idx.length <= maxTicks) return idx;
  }
  return [];
}

function tickLabel(d: string, all: string[], ticks: number[]): string {
  const multiYear = all.length && all[0].slice(0, 4) !== all[all.length - 1].slice(0, 4);
  const yearsOnly = ticks.length > 1 && ticks.every((i) => all[i].slice(5, 7) === '01' || all[i - 1]?.slice(0, 4) !== all[i].slice(0, 4)) && ticks.length >= 2 && all.length > 600;
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(d.slice(5, 7)) - 1];
  if (yearsOnly) return d.slice(0, 4);
  if (d.slice(5, 7) === '01' && multiYear) return d.slice(0, 4);
  return m;
}

// ---------------------------------------------------------------------------------------------

export class PriceChart {
  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private tip: HTMLElement;
  private data: PriceChartData | null = null;
  private hover: number | null = null;
  private ro: ResizeObserver | null = null;
  private geom: { padL: number; slot: number; n: number; plotW: number } | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    this.canvas = h('canvas', { role: 'img', 'aria-label': 'QQQ Daily price with SMA200 and strategy thresholds' }) as HTMLCanvasElement;
    this.tip = h('div', { class: 'chart-tip', hidden: true });
    host.append(this.canvas, this.tip);
    const move = (e: PointerEvent) => {
      if (!this.geom) return;
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const i = Math.floor((x - this.geom.padL) / this.geom.slot);
      const ni = i >= 0 && i < this.geom.n ? i : null;
      if (ni !== this.hover) {
        this.hover = ni;
        this.draw();
      }
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerdown', move);
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.draw();
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.draw());
      this.ro.observe(host);
    }
  }

  set(data: PriceChartData): void {
    this.data = data;
    this.hover = null;
    this.draw();
  }

  destroy(): void {
    this.ro?.disconnect();
  }

  draw(): void {
    const s = setupCanvas(this.canvas, this.host);
    const d = this.data;
    if (!s || !d) return;
    const { ctx, w, hgt } = s;
    const c = palette();
    ctx.clearRect(0, 0, w, hgt);
    const n = d.bars.length + (d.live ? 1 : 0);
    if (n < 2) return;
    const padL = 6, padR = 60, padT = 14, padB = 24;
    const plotW = w - padL - padR, plotH = hgt - padT - padB;
    const slot = plotW / n;
    this.geom = { padL, slot, n: d.bars.length, plotW };
    const xOf = (i: number) => padL + slot * (i + 0.5);
    const bands = d.bands !== false;

    let lo = Infinity, hi = -Infinity;
    d.bars.forEach((b, i) => {
      lo = Math.min(lo, b.l);
      hi = Math.max(hi, b.h);
      const sm = d.sma[i];
      if (sm !== null) {
        lo = Math.min(lo, bands ? sm * (1 - d.exitPct / 100) : sm);
        hi = Math.max(hi, bands ? sm * (1 + d.entryPct / 100) : sm);
      }
      const fv = d.fast?.values[i];
      if (fv !== null && fv !== undefined) { lo = Math.min(lo, fv); hi = Math.max(hi, fv); }
    });
    if (d.live) { lo = Math.min(lo, d.live.price); hi = Math.max(hi, d.live.price); }
    const useLog = d.log && lo > 0;
    const tf = (v: number) => (useLog ? Math.log(v) : v);
    let tlo = tf(lo), thi = tf(hi);
    const pad = (thi - tlo) * 0.05 || 1;
    tlo -= pad; thi += pad;
    const yOf = (v: number) => padT + plotH * (1 - (tf(v) - tlo) / (thi - tlo));

    // grid + price axis
    ctx.font = '11px ' + (cssVar('--font-mono') || 'monospace');
    ctx.textBaseline = 'middle';
    const ticks = useLog ? logTicks(Math.exp(tlo), Math.exp(thi)) : linearTicks(lo - (hi - lo) * 0.05, hi + (hi - lo) * 0.05, 5);
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    for (const tv of ticks) {
      const y = Math.round(yOf(tv)) + 0.5;
      if (y < padT - 1 || y > padT + plotH + 1) continue;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = c.text3;
      ctx.textAlign = 'left';
      ctx.fillText(fmtNum(tv, tv >= 100 ? 0 : 2), padL + plotW + 8, y);
    }
    // date axis
    const dates = d.bars.map((b) => b.d);
    const dt = dateTicks(dates, plotW);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let lastX = -999;
    for (const i of dt) {
      const x = xOf(i);
      if (x - lastX < 44) continue;
      lastX = x;
      ctx.fillStyle = c.text3;
      ctx.fillText(tickLabel(dates[i], dates, dt), x, padT + plotH + 7);
      ctx.strokeStyle = c.grid;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, padT + plotH);
      ctx.lineTo(Math.round(x) + 0.5, padT + plotH + 4);
      ctx.stroke();
    }
    ctx.strokeStyle = c.axis;
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH + 0.5);
    ctx.lineTo(padL + plotW, padT + plotH + 0.5);
    ctx.stroke();

    // threshold band (between SMA-exit and SMA+entry), then the three lines
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();
    const segs: number[][] = [];
    let cur: number[] = [];
    d.sma.forEach((v, i) => {
      if (v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(i);
    });
    if (cur.length) segs.push(cur);
    for (const seg of segs) {
      if (bands) {
        ctx.fillStyle = c.band;
        ctx.beginPath();
        seg.forEach((i, k) => {
          const y = yOf((d.sma[i] as number) * (1 + d.entryPct / 100));
          if (k === 0) ctx.moveTo(xOf(i), y); else ctx.lineTo(xOf(i), y);
        });
        for (let k = seg.length - 1; k >= 0; k--) ctx.lineTo(xOf(seg[k]), yOf((d.sma[seg[k]] as number) * (1 - d.exitPct / 100)));
        ctx.closePath();
        ctx.fill();
      }
      const line = (mult: number, color: string, width: number) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        seg.forEach((i, k) => {
          const y = yOf((d.sma[i] as number) * mult);
          if (k === 0) ctx.moveTo(xOf(i), y); else ctx.lineTo(xOf(i), y);
        });
        ctx.stroke();
      };
      if (bands) {
        line(1 + d.entryPct / 100, c.bull, 1);
        line(1 - d.exitPct / 100, c.risk, 1);
      }
      line(1, c.accent, 2);
    }
    if (d.fast) {
      ctx.strokeStyle = cssVar('--fast');
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let on = false;
      d.fast.values.forEach((v, i) => {
        if (v === null) { on = false; return; }
        if (!on) { ctx.moveTo(xOf(i), yOf(v)); on = true; } else ctx.lineTo(xOf(i), yOf(v));
      });
      ctx.stroke();
    }

    // candles or a close line when they get too dense to read
    const candleMode = slot >= 3;
    if (candleMode) {
      const bw = Math.max(1, Math.min(9, Math.floor(slot * 0.62)));
      d.bars.forEach((b, i) => {
        const x = Math.round(xOf(i));
        const up = b.c >= b.o;
        ctx.strokeStyle = up ? c.bull : c.risk;
        ctx.fillStyle = up ? c.bull : c.risk;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, yOf(b.h));
        ctx.lineTo(x + 0.5, yOf(b.l));
        ctx.stroke();
        const y1 = yOf(Math.max(b.o, b.c)), y2 = yOf(Math.min(b.o, b.c));
        ctx.fillRect(x - Math.floor(bw / 2) + 0.5, y1, bw, Math.max(1, y2 - y1));
      });
    } else {
      ctx.strokeStyle = c.text2;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      d.bars.forEach((b, i) => (i === 0 ? ctx.moveTo(xOf(i), yOf(b.c)) : ctx.lineTo(xOf(i), yOf(b.c))));
      ctx.stroke();
    }
    // live (incomplete) price: hollow, never part of the confirmed series
    if (d.live) {
      const i = d.bars.length;
      const x = xOf(i), y = yOf(d.live.price);
      ctx.strokeStyle = c.text2;
      ctx.lineWidth = 1.5;
      ctx.fillStyle = c.surface;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // markers
    for (const m of d.markers) {
      if (m.idx < 0 || m.idx >= d.bars.length) continue;
      const b = d.bars[m.idx];
      const x = xOf(m.idx);
      const col = m.kind === 'EXIT' ? c.risk : m.kind === 'TRIM' ? c.wait : m.kind === 'QUAL' ? c.text2 : c.bull;
      ctx.lineWidth = 2;
      ctx.strokeStyle = m.real ? c.surface : col;
      ctx.fillStyle = m.real ? col : c.surface;
      const sz = m.kind === 'QUAL' ? 4 : 6;
      ctx.beginPath();
      if (m.kind === 'QUAL') {
        const sm = d.sma[m.idx];
        const y = sm !== null && bands ? yOf(sm * (1 + d.entryPct / 100)) : yOf(b.c);
        ctx.moveTo(x, y - sz); ctx.lineTo(x + sz, y); ctx.lineTo(x, y + sz); ctx.lineTo(x - sz, y); ctx.closePath();
      } else if (m.kind === 'ENTRY' || m.kind === 'ADD') {
        const y = yOf(b.l) + 6;
        ctx.moveTo(x, y); ctx.lineTo(x + sz, y + sz * 1.6); ctx.lineTo(x - sz, y + sz * 1.6); ctx.closePath();
        if (m.kind === 'ADD') { ctx.moveTo(x, y + sz * 1.6 + 2); ctx.lineTo(x + sz, y + sz * 3.2 + 2); ctx.lineTo(x - sz, y + sz * 3.2 + 2); ctx.closePath(); }
      } else {
        const y = yOf(b.h) - 6;
        ctx.moveTo(x, y); ctx.lineTo(x + sz, y - sz * 1.6); ctx.lineTo(x - sz, y - sz * 1.6); ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
      if (m.real) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // crosshair + tooltip
    const tip = this.tip;
    if (this.hover !== null && this.hover < d.bars.length) {
      const i = this.hover;
      const b = d.bars[i];
      const x = Math.round(xOf(i)) + 0.5;
      ctx.strokeStyle = c.text3;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      clear(tip);
      const sm = d.sma[i];
      const dist = sm ? (b.c / sm - 1) * 100 : null;
      const row = (k: string, v: string) => h('div', { class: 'tip-row' }, h('b', null, v), h('span', null, k));
      tip.append(
        h('div', { class: 'tip-head' }, fmtDate(b.d)),
        row('close', fmtNum(b.c)),
        row('open · high · low', `${fmtNum(b.o)} · ${fmtNum(b.h)} · ${fmtNum(b.l)}`),
        ...(d.fast ? [row(d.fast.label, d.fast.values[i] !== null ? fmtNum(d.fast.values[i]) : '—')] : []),
        row(d.smaLabel ?? 'SMA200', sm ? fmtNum(sm) : '—'),
        row(`vs ${d.smaLabel ?? 'SMA200'}`, fmtPct(dist)),
        ...d.markers.filter((m) => m.idx === i).map((m) => h('div', { class: 'tip-ev' + (m.real ? ' real' : '') }, m.label)),
      );
      tip.hidden = false;
      const tw = tip.offsetWidth;
      const left = x + 14 + tw > w - padR ? x - 14 - tw : x + 14;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = padT + 4 + 'px';
    } else {
      tip.hidden = true;
    }
  }
}

// ---------------------------------------------------------------------------------------------

export interface LineSeries {
  id: string;
  name: string;
  color: string;
  values: number[];
}

export class LineChart {
  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private tip: HTMLElement;
  private dates: string[] = [];
  private series: LineSeries[] = [];
  private log = true;
  private hover: number | null = null;
  private ro: ResizeObserver | null = null;
  private geom: { padL: number; plotW: number; n: number } | null = null;
  private fmt: (v: number) => string = (v) => fmtNum(v, 0);

  constructor(host: HTMLElement, label: string) {
    this.host = host;
    this.canvas = h('canvas', { role: 'img', 'aria-label': label }) as HTMLCanvasElement;
    this.tip = h('div', { class: 'chart-tip', hidden: true });
    host.append(this.canvas, this.tip);
    const move = (e: PointerEvent) => {
      if (!this.geom) return;
      const r = this.canvas.getBoundingClientRect();
      const i = Math.round(((e.clientX - r.left - this.geom.padL) / this.geom.plotW) * (this.geom.n - 1));
      const ni = i >= 0 && i < this.geom.n ? i : null;
      if (ni !== this.hover) { this.hover = ni; this.draw(); }
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerdown', move);
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.draw());
      this.ro.observe(host);
    }
  }

  set(dates: string[], series: LineSeries[], log: boolean, fmt?: (v: number) => string): void {
    this.dates = dates;
    this.series = series;
    this.log = log;
    if (fmt) this.fmt = fmt;
    this.hover = null;
    this.draw();
  }

  destroy(): void {
    this.ro?.disconnect();
  }

  draw(): void {
    const s = setupCanvas(this.canvas, this.host);
    if (!s) return;
    const { ctx, w, hgt } = s;
    const c = palette();
    ctx.clearRect(0, 0, w, hgt);
    const n = this.dates.length;
    if (n < 2 || !this.series.length) return;
    const padL = 6, padR = 62, padT = 12, padB = 24;
    const plotW = w - padL - padR, plotH = hgt - padT - padB;
    this.geom = { padL, plotW, n };
    const xOf = (i: number) => padL + (plotW * i) / (n - 1);
    let lo = Infinity, hi = -Infinity;
    for (const sr of this.series) for (const v of sr.values) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const useLog = this.log && lo > 0;
    const tf = (v: number) => (useLog ? Math.log(v) : v);
    let tlo = tf(lo), thi = tf(hi);
    const pad = (thi - tlo) * 0.04 || 1;
    tlo -= pad; thi += pad;
    const yOf = (v: number) => padT + plotH * (1 - (tf(v) - tlo) / (thi - tlo));
    ctx.font = '11px ' + (cssVar('--font-mono') || 'monospace');
    ctx.textBaseline = 'middle';
    const ticks = useLog ? logTicks(Math.exp(tlo), Math.exp(thi)) : linearTicks(lo, hi, 5);
    for (const tv of ticks) {
      const y = Math.round(yOf(tv)) + 0.5;
      if (y < padT - 1 || y > padT + plotH + 1) continue;
      ctx.strokeStyle = c.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.fillStyle = c.text3;
      ctx.textAlign = 'left';
      ctx.fillText(this.fmt(tv), padL + plotW + 8, y);
    }
    const dt = dateTicks(this.dates, plotW);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let lastX = -999;
    for (const i of dt) {
      const x = xOf(i);
      if (x - lastX < 44) continue;
      lastX = x;
      ctx.fillStyle = c.text3;
      ctx.fillText(tickLabel(this.dates[i], this.dates, dt), x, padT + plotH + 7);
    }
    ctx.strokeStyle = c.axis;
    ctx.beginPath(); ctx.moveTo(padL, padT + plotH + 0.5); ctx.lineTo(padL + plotW, padT + plotH + 0.5); ctx.stroke();
    // thin when dense
    const step = Math.max(1, Math.floor(n / (plotW * 1.5)));
    for (const sr of this.series) {
      ctx.strokeStyle = sr.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < n; i += step) {
        const y = yOf(sr.values[i]);
        if (i === 0) ctx.moveTo(xOf(i), y); else ctx.lineTo(xOf(i), y);
      }
      ctx.lineTo(xOf(n - 1), yOf(sr.values[n - 1]));
      ctx.stroke();
      ctx.fillStyle = sr.color;
      ctx.strokeStyle = c.surface;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(xOf(n - 1), yOf(sr.values[n - 1]), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const tip = this.tip;
    if (this.hover !== null) {
      const i = this.hover;
      const x = Math.round(xOf(i)) + 0.5;
      ctx.strokeStyle = c.text3;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      clear(tip);
      tip.append(h('div', { class: 'tip-head' }, fmtDate(this.dates[i])));
      const rows = this.series.map((sr) => ({ sr, v: sr.values[i] })).sort((a, b) => b.v - a.v);
      for (const r of rows) {
        const key = h('i', { class: 'tip-key', style: `background:${r.sr.color}` });
        tip.append(h('div', { class: 'tip-row' }, key, h('b', null, this.fmt(r.v)), h('span', null, r.sr.name)));
      }
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = Math.max(4, x + 14 + tw > w - padR ? x - 14 - tw : x + 14) + 'px';
      tip.style.top = padT + 4 + 'px';
    } else tip.hidden = true;
  }
}

// ---------------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Distance from SMA200 over recent sessions, with the entry and exit levels as reference lines. */
export function distanceSpark(values: number[], dates: string[], entryPct: number, exitPct: number): SVGSVGElement {
  const W = 300, H = 64, padT = 6, padB = 6;
  const lo = Math.min(-exitPct - 1.5, ...values);
  const hi = Math.max(entryPct + 1.5, ...values);
  const y = (v: number) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  const x = (i: number) => (W - 8) * (i / Math.max(1, values.length - 1));
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spark', preserveAspectRatio: 'none', role: 'img', 'aria-label': `Distance from SMA200 over the last ${values.length} sessions` }) as SVGSVGElement;
  svg.appendChild(svgEl('rect', { x: 0, y: padT, width: W, height: Math.max(0, y(entryPct) - padT), fill: 'var(--bull-wash)' }));
  svg.appendChild(svgEl('rect', { x: 0, y: y(-exitPct), width: W, height: Math.max(0, H - padB - y(-exitPct)), fill: 'var(--risk-wash)' }));
  svg.appendChild(svgEl('line', { x1: 0, x2: W, y1: y(0), y2: y(0), stroke: 'var(--grid)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
  svg.appendChild(svgEl('line', { x1: 0, x2: W, y1: y(entryPct), y2: y(entryPct), stroke: 'var(--bull)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
  svg.appendChild(svgEl('line', { x1: 0, x2: W, y1: y(-exitPct), y2: y(-exitPct), stroke: 'var(--risk)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: 'var(--fg)', 'stroke-width': 1.75, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
  const last = values.length - 1;
  svg.appendChild(svgEl('circle', { cx: x(last), cy: y(values[last]), r: 3.5, fill: 'var(--fg)', stroke: 'var(--panel)', 'stroke-width': 2 }));
  const t = svgEl('title', {});
  t.textContent = `${fmtDateShort(dates[0])} to ${fmtDateShort(dates[last])}: latest ${fmtPct(values[last])}`;
  svg.appendChild(t);
  return svg;
}
