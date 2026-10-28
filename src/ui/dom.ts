// Small DOM helpers. Text always goes in through textContent; nothing from data is parsed as HTML.

export type Child = Node | string | number | null | undefined | false | Child[];

export function h(tag: string, attrs?: Record<string, unknown> | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'value' && (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) el.value = String(v);
      else if (k === 'checked' && el instanceof HTMLInputElement) el.checked = !!v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An inline icon from static path data authored in this file (never from data). */
export function icon(name: keyof typeof ICONS, size = 16, cls = 'ico'): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', cls);
  for (const d of ICONS[name]) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
  }
  return s;
}

export const ICONS = {
  check: ['M5 12.5l4.2 4.2L19 7'],
  dots: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  cross: ['M7 7l10 10', 'M17 7L7 17'],
  dash: ['M7 12h10'],
  sun: ['M12 4V2', 'M12 22v-2', 'M4 12H2', 'M22 12h-2', 'M5.6 5.6L4.2 4.2', 'M19.8 19.8l-1.4-1.4', 'M5.6 18.4l-1.4 1.4', 'M19.8 4.2l-1.4 1.4', 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z'],
  moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  bell: ['M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16z', 'M10 20.5a2 2 0 0 0 4 0'],
  plug: ['M9 3v5', 'M15 3v5', 'M6 8h12v3a6 6 0 0 1-12 0V8z', 'M12 17v4'],
  info: ['M12 11v6', 'M12 7.5h.01', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
  arrowUp: ['M12 19V5', 'M6 11l6-6 6 6'],
  arrowDown: ['M12 5v14', 'M6 13l6 6 6-6'],
  trash: ['M5 7h14', 'M10 7V5h4v2', 'M7 7l1 13h8l1-13'],
  plus: ['M12 5v14', 'M5 12h14'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  logout: ['M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3', 'M10 17l5-5-5-5', 'M15 12H4'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
};

// ---------- formatting

const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf4 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

export const MINUS = '−';

export function fmtNum(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const s = digits === 0 ? nf0.format(Math.abs(x)) : digits === 4 ? nf4.format(Math.abs(x)) : nf2.format(Math.abs(x));
  return (x < 0 ? MINUS : '') + s;
}

export function fmtUsd(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return (x < 0 ? MINUS : '') + '$' + (digits === 0 ? nf0.format(Math.abs(x)) : nf2.format(Math.abs(x)));
}

export function fmtMoney(x: number | null | undefined, currency: 'USD' | 'MYR', digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  if (currency === 'USD') return fmtUsd(x, digits);
  return (x < 0 ? MINUS : '') + 'RM' + (digits === 0 ? nf0.format(Math.abs(x)) : nf2.format(Math.abs(x)));
}

export function fmtPct(x: number | null | undefined, digits = 2, signed = true): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const sign = x > 0 && signed ? '+' : x < 0 ? MINUS : '';
  return sign + Math.abs(x).toFixed(digits) + '%';
}

export function fmtCompactUsd(x: number): string {
  const a = Math.abs(x);
  const s = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K' : a.toFixed(0);
  return (x < 0 ? MINUS : '') + '$' + s;
}

export function readNum(el: HTMLInputElement | null | undefined): number | null {
  if (!el) return null;
  const v = el.value.trim().replace(/,/g, '');
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the preference simply is not remembered */
  }
}
