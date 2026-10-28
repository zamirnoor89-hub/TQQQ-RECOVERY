#!/usr/bin/env python3
"""Independent reference backtest for TQQQ Recovery V2.0.

Re-implements the documented methodology from the written rules, separately from the app's
TypeScript engine, so the two can be compared trade by trade on identical input files:

  * inputs: research/data/{QQQ,TQQQ}_1day.csv (Twelve Data, split-adjusted, not dividend-adjusted)
            research/data/{QQQ,TQQQ}_dividends.csv
  * signals at completed closes, execution at the next session's open
  * actual TQQQ prices, cash rate compounded by calendar days, no margin
  * costs = bps of traded value + fixed fee per transaction
  * monthly rebalance decided at the last session of each month, executed at the next open,
    trades below 0.1% of equity skipped

Usage:
  python3 -I research/reference_backtest.py [--fee-bps 5] [--dividends] [--cash-rate 0]
         [--start 2010-02-01] [--end 2026-12-31] [--json out.json]
"""
import argparse
import json
import math
import os
import sys
from datetime import date

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

BASELINE = dict(entry=2.0, confirm=2, first=2.5, wait=20, target=5.0, trim=6.0, exit=3.0, sma=200)
EPS = 1e-9
MIN_TRADE_FRAC = 0.001


def load(symbol):
    df = pd.read_csv(os.path.join(DATA, f"{symbol}_1day.csv"), dtype={"date": str})
    df = df.sort_values("date").drop_duplicates("date").reset_index(drop=True)
    return df


def load_divs(symbol):
    path = os.path.join(DATA, f"{symbol}_dividends.csv")
    if not os.path.exists(path):
        return []
    df = pd.read_csv(path, dtype={"ex_date": str})
    return list(zip(df["ex_date"], df["amount"].astype(float)))


def days(a, b):
    ya, ma, da = map(int, a.split("-"))
    yb, mb, db = map(int, b.split("-"))
    return (date(yb, mb, db) - date(ya, ma, da)).days


class Account:
    def __init__(self, cash):
        self.q = 0.0
        self.t = 0.0
        self.cash = cash
        self.trades = []


class Sim:
    def __init__(self, args):
        self.a = args
        q = load("QQQ")
        t = load("TQQQ")
        self.q = q
        closes = q["close"].astype(float)
        # Independent SMA: pandas rolling mean of completed closes.
        self.sma = {n: closes.rolling(n, min_periods=n).mean().to_numpy() for n in (50, 200)}
        self.qi = {d: i for i, d in enumerate(q["date"])}
        tmap = {r.date: r for r in t.itertuples(index=False)}
        self.tmap = tmap
        self.closes = closes.to_numpy()
        need = 200
        self.dates = [d for i, d in enumerate(q["date"]) if args.start <= d <= args.end and d in tmap and i >= need - 1]
        self.qrow = {r.date: r for r in q.itertuples(index=False)}
        # Dividends: credited on the ex-date to shares held at the prior close; implausible ones dropped.
        self.divs = {"QQQ": {}, "TQQQ": {}}
        if args.dividends:
            for sym, frame in (("QQQ", q), ("TQQQ", t)):
                ds = list(frame["date"])
                cs = list(frame["close"].astype(float))
                for ex, amt in load_divs(sym):
                    prev = None
                    for k in range(len(ds) - 1, -1, -1):
                        if ds[k] < ex:
                            prev = cs[k]
                            break
                    if prev is None or amt / prev > 0.1:
                        continue
                    self.divs[sym][ex] = self.divs[sym].get(ex, 0.0) + amt

    # ---- prices
    def px(self, k, sym, field):
        d = self.dates[k]
        row = self.qrow[d] if sym == "QQQ" else self.tmap[d]
        return float(getattr(row, field))

    def fee(self, value):
        return value * self.a.fee_bps / 10000 + self.a.fee_fixed if value > 0 else 0.0

    def div_between(self, sym, after, upto):
        return sum(a for d, a in self.divs[sym].items() if after < d <= upto)

    # ---- trading primitives
    def trade(self, acc, sym, dsh, price, k, kind, sig):
        if not abs(dsh) > 1e-12:
            return
        if dsh > 0:
            value = dsh * price
            if value + self.fee(value) > acc.cash:  # no borrowing
                value = max(0.0, (acc.cash - self.a.fee_fixed) / (1 + self.a.fee_bps / 10000))
                dsh = value / price
            if value <= 1e-9:
                return
            f = self.fee(value)
            acc.cash -= value + f
            if sym == "QQQ":
                acc.q += dsh
            else:
                acc.t += dsh
            acc.trades.append((self.dates[k], sig, sym, "BUY", dsh, price, f, kind))
        else:
            held = acc.q if sym == "QQQ" else acc.t
            sh = min(held, -dsh)
            value = sh * price
            if value <= 1e-9:
                return
            f = self.fee(value)
            acc.cash += value - f
            if sym == "QQQ":
                acc.q -= sh
            else:
                acc.t -= sh
                if acc.t < 1e-12:
                    acc.t = 0.0
            acc.trades.append((self.dates[k], sig, sym, "SELL", sh, price, f, kind))

    def rebalance(self, acc, k, wq, wt, kind, sig):
        qo, to = self.px(k, "QQQ", "open"), self.px(k, "TQQQ", "open")
        E = acc.q * qo + acc.t * to + acc.cash
        dq = 0.0 if wq is None else wq * E / qo - acc.q
        dt = 0.0 if wt is None else wt * E / to - acc.t
        big = lambda d, p: abs(d * p) >= MIN_TRADE_FRAC * E
        if dq < 0 and big(dq, qo):
            self.trade(acc, "QQQ", dq, qo, k, kind, sig)
        if dt < 0 and big(dt, to):
            self.trade(acc, "TQQQ", dt, to, k, kind, sig)
        if dt > 0 and big(dt, to):
            self.trade(acc, "TQQQ", dt, to, k, kind, sig)
        if dq > 0 and big(dq, qo):
            self.trade(acc, "QQQ", dq, qo, k, kind, sig)

    def buy_tqqq_to(self, acc, k, pct, kind, sig):
        qo, to = self.px(k, "QQQ", "open"), self.px(k, "TQQQ", "open")
        E = acc.q * qo + acc.t * to + acc.cash
        w = pct / 100
        x = (w * (E - self.a.fee_fixed) - acc.t * to) / (1 + w * self.a.fee_bps / 10000)
        if x > 0:
            self.trade(acc, "TQQQ", x / to, to, k, kind, sig)

    def trim_tqqq_to(self, acc, k, pct, kind, sig):
        qo, to = self.px(k, "QQQ", "open"), self.px(k, "TQQQ", "open")
        E = acc.q * qo + acc.t * to + acc.cash
        excess = acc.t * to - pct / 100 * E
        if excess > 0:
            self.trade(acc, "TQQQ", -excess / to, to, k, kind, sig)

    def month_end(self, k):
        if k + 1 < len(self.dates):
            return self.dates[k + 1][:7] != self.dates[k][:7]
        # last session in the data: decide by the calendar month of the next trading day
        return None


def run(args):
    S = Sim(args)
    D = S.dates
    N = len(D)
    # Calendar check for the final session's month-end status, taken from the app's calendar output
    # (passed in by the comparison script) when available; otherwise assume it is not a month end.
    last_is_month_end = bool(args.last_is_month_end)

    def is_month_end(k):
        r = S.month_end(k)
        return last_is_month_end if r is None else r

    models = ["QQQ100", "QQQ_CASH", "QQQ_TQQQ_M", "SMA200_ROT", "CLAUDE_V2", "SMA_CROSS", "QQQ_TQQQ_BH"]
    acc = {m: Account(args.capital) for m in models}
    eq = {m: [] for m in models}
    pending = {m: [] for m in models}
    invested = {"SMA200_ROT": False, "SMA_CROSS": False}
    # Claude V2 state
    cv = dict(active=False, first_exec=-1, second=False, cycle_end=-1)
    P = BASELINE
    sma200 = S.sma[200]
    sma50 = S.sma[50]
    # qualifying run bookkeeping on the full QQQ index
    nq = len(S.closes)
    qual = [None] * nq
    exitz = [None] * nq
    run_len = [0] * nq
    last_non = [-1] * nq
    r, ln = 0, -1
    for i in range(nq):
        s = sma200[i]
        c = S.closes[i]
        if math.isnan(s):
            qual[i] = None
            exitz[i] = None
        else:
            qual[i] = c >= s * (1 + P["entry"] / 100) - EPS * s
            exitz[i] = c <= s * (1 - P["exit"] / 100) + EPS * s
        if qual[i]:
            r += 1
        else:
            r = 0
            ln = i
        run_len[i] = r
        last_non[i] = ln

    def claude_decide(k, E, a):
        qi = S.qi[D[k]]
        if math.isnan(sma200[qi]):
            return []
        w = (a.t * S.px(k, "TQQQ", "close")) / E if E > 0 else None
        if cv["active"]:
            if exitz[qi]:
                return ["EXIT"]
            out = []
            if not cv["second"] and cv["first_exec"] >= 0:
                elapsed = qi - cv["first_exec"] + 1
                pair = run_len[qi] >= P["confirm"] and qi - P["confirm"] + 1 >= cv["first_exec"]
                if elapsed >= P["wait"] and pair:
                    out.append("ADD_AT_TARGET" if (w is not None and w >= P["target"] / 100 - 1e-12) else "ADD")
            if w is not None and w > P["trim"] / 100 and "ADD" not in out:
                out.append("TRIM")
            return out
        if run_len[qi] >= P["confirm"] and last_non[qi] >= cv["cycle_end"]:
            return ["ENTRY"]
        return []

    def monthly(m, k, sig):
        a = acc[m]
        qo, to = S.px(k, "QQQ", "open"), S.px(k, "TQQQ", "open")
        E = a.q * qo + a.t * to + a.cash
        if m in ("QQQ100", "QQQ_TQQQ_BH"):
            S.rebalance(a, k, 1 - a.t * to / E, None, "SWEEP", sig)
        elif m == "QQQ_CASH":
            S.rebalance(a, k, 0.95, None, "REBALANCE", sig)
        elif m == "QQQ_TQQQ_M":
            S.rebalance(a, k, 0.95, 0.05, "REBALANCE", sig)
        elif m in invested:
            S.rebalance(a, k, 0.95, 0.05 if invested[m] else None, "REBALANCE", sig)
        elif m == "CLAUDE_V2":
            tw = a.t * to / E
            S.rebalance(a, k, 1 - tw - max(0.0, P["target"] / 100 - tw), None, "REBALANCE", sig)

    for k in range(N):
        d = D[k]
        for m in models:
            a = acc[m]
            if k == 0:
                if m == "QQQ100":
                    S.rebalance(a, 0, 1.0, None, "START", None)
                elif m in ("QQQ_TQQQ_M", "QQQ_TQQQ_BH"):
                    S.rebalance(a, 0, 0.95, 0.05, "START", None)
                else:
                    S.rebalance(a, 0, 0.95, None, "START", None)
            else:
                prev = D[k - 1]
                if args.cash_rate > 0 and a.cash > 0:
                    a.cash *= (1 + args.cash_rate / 100) ** (days(prev, d) / 365)
                if args.dividends:
                    a.cash += a.q * S.div_between("QQQ", prev, d) + a.t * S.div_between("TQQQ", prev, d)
                orders = pending[m]
                pending[m] = []
                for op in [o for o in orders if o[0] != "monthly"]:
                    kind, sig = op[0], op[1]
                    if kind == "to_pct":
                        S.buy_tqqq_to(a, k, op[2], op[3], sig)
                        if m in invested:
                            invested[m] = True
                    elif kind == "trim":
                        S.trim_tqqq_to(a, k, op[2], "TRIM", sig)
                    elif kind == "sell_all":
                        S.trade(a, "TQQQ", -a.t, S.px(k, "TQQQ", "open"), k, "EXIT", sig)
                        if m in invested:
                            invested[m] = False
                    elif kind == "mark":
                        dec, sig_qi = op[2], op[3]
                        exec_qi = S.qi[d]
                        if dec == "ENTRY":
                            cv.update(active=True, first_exec=exec_qi, second=False)
                        elif dec in ("ADD", "ADD_AT_TARGET"):
                            cv["second"] = True
                        elif dec == "EXIT":
                            cv.update(active=False, first_exec=-1, second=False, cycle_end=sig_qi)
                for op in [o for o in orders if o[0] == "monthly"]:
                    monthly(m, k, op[1])
            E = a.q * S.px(k, "QQQ", "close") + a.t * S.px(k, "TQQQ", "close") + a.cash
            eq[m].append(E)
            # decisions at this close
            qi = S.qi[d]
            if m == "SMA200_ROT":
                on = S.closes[qi] > sma200[qi]
                if on and not invested[m]:
                    pending[m].append(("to_pct", d, 5.0, "ENTRY"))
                if not on and invested[m]:
                    pending[m].append(("sell_all", d))
            if m == "SMA_CROSS":
                on = sma50[qi] > sma200[qi]
                if on and not invested[m]:
                    pending[m].append(("to_pct", d, 5.0, "ENTRY"))
                if not on and invested[m]:
                    pending[m].append(("sell_all", d))
            if m == "CLAUDE_V2":
                for dec in claude_decide(k, E, a):
                    if dec == "ENTRY":
                        pending[m].append(("to_pct", d, P["first"], "INITIAL"))
                    elif dec == "ADD":
                        pending[m].append(("to_pct", d, P["target"], "ADD"))
                    elif dec == "TRIM":
                        pending[m].append(("trim", d, P["target"]))
                    elif dec == "EXIT":
                        pending[m].append(("sell_all", d))
                    pending[m].append(("mark", d, dec, qi))
            if is_month_end(k):
                pending[m].append(("monthly", d))

    years = days(D[0], D[-1]) / 365.25
    rf = (1 + args.cash_rate / 100) ** (1 / 252) - 1
    out = {"start": D[0], "end": D[-1], "sessions": N, "models": {}}
    for m in models:
        e = eq[m]
        peak, mdd = e[0], 0.0
        for x in e:
            peak = max(peak, x)
            mdd = min(mdd, x / peak - 1)
        rets = [e[i] / e[i - 1] - 1 for i in range(1, N)]
        mean = sum(rets) / len(rets)
        sd = math.sqrt(sum((x - mean) ** 2 for x in rets) / (len(rets) - 1))
        out["models"][m] = {
            "final": e[-1],
            "cagr": ((e[-1] / args.capital) ** (1 / years) - 1) * 100,
            "maxDD": mdd * 100,
            "sharpe": (mean - rf) / sd * math.sqrt(252) if sd > 0 else None,
            "equity": e,
            "trades": [list(x) for x in acc[m].trades],
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2010-02-01")
    ap.add_argument("--end", default="2026-12-31")
    ap.add_argument("--capital", type=float, default=100000.0)
    ap.add_argument("--fee-bps", type=float, default=5.0)
    ap.add_argument("--fee-fixed", type=float, default=0.0)
    ap.add_argument("--cash-rate", type=float, default=0.0)
    ap.add_argument("--dividends", action="store_true")
    ap.add_argument("--last-is-month-end", type=int, default=0)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    out = run(args)
    if args.json:
        with open(args.json, "w") as f:
            json.dump(out, f)
    print(f"{out['start']} to {out['end']} · {out['sessions']} sessions")
    for m, r in out["models"].items():
        print(f"{m:13s} final {r['final']:>14,.2f}  CAGR {r['cagr']:7.3f}%  maxDD {r['maxDD']:7.2f}%  trades {len(r['trades'])}")


if __name__ == "__main__":
    sys.exit(main())
