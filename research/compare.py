#!/usr/bin/env python3
"""Compare the app's TypeScript engine with the independent Python reference, trade by trade.

  python3 -I research/compare.py            # runs both engines for three cost/dividend settings
Prints, per model: final values, CAGR difference, largest relative equity gap, and whether every
trade matches on date, signal close, symbol, side, kind, shares, price and fee.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CASES = [("costs 5 bps, price return", "5", "0", "0"), ("costs 5 bps, dividends, cash 2%", "5", "1", "2"), ("no costs, price return", "0", "0", "0")]


def run_case(label, bps, div, rate, tmp):
    ts_json = os.path.join(tmp, f"ts_{bps}_{div}_{rate}.json")
    py_json = os.path.join(tmp, f"py_{bps}_{div}_{rate}.json")
    subprocess.run(["node", "--disable-warning=ExperimentalWarning", "--experimental-strip-types", os.path.join(HERE, "export_ts.ts"), ts_json, bps, div, rate], check=True, cwd=ROOT, capture_output=True)
    ts = json.load(open(ts_json))
    args = [sys.executable, "-I", os.path.join(HERE, "reference_backtest.py"), "--fee-bps", bps, "--cash-rate", rate, "--json", py_json, "--last-is-month-end", "1" if ts["lastIsMonthEnd"] else "0"]
    if div == "1":
        args.append("--dividends")
    subprocess.run(args, check=True, capture_output=True)
    py = json.load(open(py_json))
    print(f"\n== {label}: TS {ts['start']}→{ts['end']} ({ts['sessions']}) · Python {py['start']}→{py['end']} ({py['sessions']})")
    ok_all = ts["start"] == py["start"] and ts["sessions"] == py["sessions"]
    for m, pr in py["models"].items():
        tr = ts["models"].get(m)
        if tr is None:
            print(f"  {m:13s} missing in TS")
            ok_all = False
            continue
        gap = max(abs(a - b) / b for a, b in zip(tr["equity"], pr["equity"]))
        tt, pt = tr["trades"], pr["trades"]
        mism = None
        if len(tt) != len(pt):
            mism = f"trade count {len(tt)} vs {len(pt)}"
        else:
            for i, (a, b) in enumerate(zip(tt, pt)):
                same = a[0] == b[0] and a[1] == b[1] and a[2] == b[2] and a[3] == b[3] and a[7] == b[7] and abs(a[4] - b[4]) <= 1e-9 * max(1, abs(b[4])) and abs(a[5] - b[5]) < 1e-9 and abs(a[6] - b[6]) <= 1e-9 * max(1, abs(b[6]))
                if not same:
                    mism = f"trade {i}: TS {a} vs PY {b}"
                    break
        ok = mism is None and gap < 1e-9
        ok_all &= ok
        print(f"  {m:13s} TS {tr['final']:>14,.2f}  PY {pr['final']:>14,.2f}  ΔCAGR {tr['cagr'] - pr['cagr']:+.2e}  max equity gap {gap:.1e}  trades {len(tt):4d}  {'MATCH' if ok else 'DIFFER: ' + str(mism)}")
    return ok_all


def main():
    with tempfile.TemporaryDirectory() as tmp:
        results = [run_case(*c, tmp) for c in CASES]
    print("\nALL MATCH" if all(results) else "\nDIFFERENCES FOUND")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
