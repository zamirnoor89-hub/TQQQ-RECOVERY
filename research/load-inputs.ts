// Loads the fixed research inputs (real Twelve Data answers saved on 27 Oct 2026).
import { readFileSync } from 'node:fs';
import type { Bar, Dividend } from '../src/data.ts';

const here = new URL('./data/', import.meta.url);

function readCsv(name: string): string[][] {
  return readFileSync(new URL(name, here), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
}

export function loadBars(symbol: 'QQQ' | 'TQQQ'): Bar[] {
  return readCsv(`${symbol}_1day.csv`).map(([d, o, h, l, c, v]) => ({ d, o: +o, h: +h, l: +l, c: +c, v: v === '' ? null : +v }));
}

export function loadDividends(symbol: 'QQQ' | 'TQQQ'): Dividend[] {
  return readCsv(`${symbol}_dividends.csv`).map(([d, a]) => ({ exDate: d, amount: +a }));
}
