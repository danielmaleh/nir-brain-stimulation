#!/usr/bin/env python3
"""Fit the device-sensor -> skin-surface correction and emit firmware constants.

The device's DS18B20 sits behind the contact surface: during a warming ramp it
reads several degrees LOW and ~90-100 s LATE (bench, 2026-09: surface 42.5 C
while the device read 34). The final device carries no surface probe, so the
firmware estimates the surface from the DS18B20 alone:

    surface = device + gap(device) + rate * (device - device_40s_ago) / 40

`gap(device)` is a lookup table over device-temperature ranges (piecewise-
linear between nodes every 2 C) -- "the gap in each temperature range" -- and
the `rate` term carries the lag. A table WITHOUT the rate term is ambiguous by
6-10 C, because the same device reading means a much hotter surface while
heating than while cooling. The two heat sources (LED array, heater ring) sit
differently relative to the sensor, so each gets its own table and rate.

The fit uses the SAME arithmetic the firmware uses (1 Hz samples, plain 40 s
backward difference, hat-function interpolation), so the accuracy reported
here is the accuracy the device will have -- not that of a fancier offline fit.

THE FIT IS A PROPERTY OF THE PHYSICAL BUILD. Two bench runs with the sensor
seated differently gave different tables. Re-run this whenever the DS18B20,
the LED array or the heater is remounted, then reflash. Inputs are the
aligned CSVs written by align_thermistor.py (probe at the skin-contact point).

Usage:
    python3 analysis/thermal/fit_surface_model.py ALIGNED_CSV [ALIGNED_CSV ...]
        [--out firmware/main/surface_model.h] [--model-id ID] [--margin 3.0]
"""

import argparse
import csv
import datetime as dt
import os
import sys

import numpy as np

NODE_T0, NODE_STEP, NODE_N = 16.0, 2.0, 16      # nodes 16..46 C
SLOPE_WINDOW_S = 40                              # must match the firmware ring buffer
SMOOTH_LAMBDA = 2.0                              # second-difference penalty on the gap nodes
MIN_NODE_SUPPORT = 15.0                          # summed hat weight a node needs before its value is trusted


def load(path):
    rows = []
    for r in csv.DictReader(open(path)):
        if r["Event"] != "TEMPERATURE" or not r["ThermistorTempC"]:
            continue
        rows.append((float(r["SessionTimeSec"]), float(r["TemperatureC"]),
                     float(r["ThermistorTempC"]), r["Condition"], r["Phase"]))
    rows.sort()
    t = np.array([x[0] for x in rows]); dev = np.array([x[1] for x in rows])
    sur = np.array([x[2] for x in rows])
    cond = np.array([x[3] for x in rows]); phase = np.array([x[4] for x in rows])
    # Firmware source selection: HEATER only while the heating condition is
    # stimulating; everything else (LED conditions, rest, transitions) is LED.
    heater = (cond == "Heating Control") & np.isin(phase, ["EMG", "RT"])
    return t, dev, sur, cond, heater


def firmware_slope(t, dev):
    """Plain backward difference over SLOPE_WINDOW_S, exactly as the Uno does it."""
    s = np.full(len(t), np.nan)
    for i in range(len(t)):
        j = np.searchsorted(t, t[i] - SLOPE_WINDOW_S)
        if j < i and t[i] - t[j] >= SLOPE_WINDOW_S * 0.75:
            s[i] = (dev[i] - dev[j]) / (t[i] - t[j])
    return s


def hat_basis(dev):
    """Piecewise-linear interpolation weights over the node grid (flat outside)."""
    x = np.clip((dev - NODE_T0) / NODE_STEP, 0, NODE_N - 1)
    i = np.minimum(x.astype(int), NODE_N - 2)
    f = x - i
    B = np.zeros((len(dev), NODE_N))
    B[np.arange(len(dev)), i] = 1 - f
    B[np.arange(len(dev)), i + 1] = f
    return B


def fit(dev, slope, gap_obs):
    """Least squares for [gap nodes..., rate] with a smoothness prior on the nodes."""
    B = hat_basis(dev)
    X = np.column_stack([B, slope])
    # second-difference penalty rows so sparsely-populated nodes follow neighbours
    D = np.zeros((NODE_N - 2, NODE_N + 1))
    for k in range(NODE_N - 2):
        D[k, k:k + 3] = [1, -2, 1]
    A = np.vstack([X, np.sqrt(SMOOTH_LAMBDA) * D])
    y = np.concatenate([gap_obs, np.zeros(NODE_N - 2)])
    coef = np.linalg.lstsq(A, y, rcond=None)[0]
    nodes, rate = coef[:NODE_N].copy(), coef[NODE_N]
    # Flat extrapolation beyond the temperature range the data actually covered.
    # The smoothness prior otherwise projects the local trend outward -- a heater
    # block that only spanned 25-26 C produced a -22 C "gap" at 46 C, which would
    # make the firmware UNDER-estimate the surface exactly where it matters. Flat
    # is also the conservative direction: the gap shrinks as a ramp levels off,
    # so holding the last well-supported value over-estimates, never under.
    support = B.sum(axis=0)
    good = np.where(support >= MIN_NODE_SUPPORT)[0]
    if len(good):
        nodes[:good[0]] = nodes[good[0]]
        nodes[good[-1] + 1:] = nodes[good[-1]]
    return nodes, rate


def predict(dev, slope, nodes, rate):
    return dev + hat_basis(dev) @ nodes + rate * slope


def stats(err):
    return np.sqrt(np.mean(err ** 2)), np.abs(err).max(), err.min(), err.max()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csvs", nargs="+")
    ap.add_argument("--out", default="firmware/main/surface_model.h")
    ap.add_argument("--model-id", default=None)
    ap.add_argument("--margin", type=float, default=3.0, help="safety margin subtracted from the cutoff (C)")
    args = ap.parse_args()

    T, DEV, SUR, COND, HEATER, SLOPE = [], [], [], [], [], []
    for p in args.csvs:
        t, dev, sur, cond, heater = load(p)
        T.append(t); DEV.append(dev); SUR.append(sur); COND.append(cond); HEATER.append(heater)
        SLOPE.append(firmware_slope(t, dev))
        print(f"loaded {os.path.basename(p)}: {len(t)} device readings")
    dev = np.concatenate(DEV); sur = np.concatenate(SUR); cond = np.concatenate(COND)
    heater = np.concatenate(HEATER); slope = np.concatenate(SLOPE)
    ok = ~np.isnan(slope)
    gap_obs = sur - dev

    out = {}
    for name, mask in (("LED", ~heater & ok), ("HEATER", heater & ok)):
        nodes, rate = fit(dev[mask], slope[mask], gap_obs[mask])
        err = sur[mask] - predict(dev[mask], slope[mask], nodes, rate)
        rms, mx, emin, emax = stats(err)
        # a table with NO rate term, for the record
        nodes0, _ = fit(dev[mask], np.zeros(mask.sum()), gap_obs[mask])
        rms0, mx0, _, _ = stats(sur[mask] - predict(dev[mask], np.zeros(mask.sum()), nodes0, 0.0))
        out[name] = dict(nodes=nodes, rate=rate, n=int(mask.sum()), rms=rms, max=mx, emin=emin, emax=emax)
        print(f"\n{name}: n={mask.sum()}  rate={rate:.1f} s")
        print(f"  with rate term : RMS {rms:.2f} C, worst {mx:.1f} C, residual range {emin:+.1f}..{emax:+.1f} C")
        print(f"  table only     : RMS {rms0:.2f} C, worst {mx0:.1f} C   <- why the rate term stays")
        print("  gap by device temperature (C at zero slope):")
        print("   " + "  ".join(f"{NODE_T0 + k * NODE_STEP:4.0f}:{nodes[k]:+5.2f}" for k in range(NODE_N)))

    # hold-out across stimulation blocks (LED only; needs >=2 NIR conditions)
    nir = [c for c in np.unique(cond) if "NIR" in c]
    if len(nir) >= 2:
        print("\nhold-out (LED): fit on one NIR block, test on the other")
        for train, test in ((nir[0], nir[1]), (nir[1], nir[0])):
            mtr = (cond == train) & ok & ~heater; mte = (cond == test) & ok & ~heater
            nodes, rate = fit(dev[mtr], slope[mtr], gap_obs[mtr])
            rms, mx, emin, _ = stats(sur[mte] - predict(dev[mte], slope[mte], nodes, rate))
            print(f"  fit {train:10s} -> test {test:10s}: RMS {rms:.2f} C, worst {mx:.1f} C, most under-estimated {emin:+.1f} C")

    # safety: how far can the true surface exceed the estimate?
    led = out["LED"]
    print(f"\nsafety margin: LED worst under-estimate {led['emin']:+.1f} C -> with --margin {args.margin} the true surface")
    print(f"  at the moment the estimate reaches the cutoff is bounded to <= cutoff + {max(0.0, -led['emin'] - args.margin):.1f} C")
    if -led["emin"] > args.margin:
        print(f"  !! margin {args.margin} C is SMALLER than the worst under-estimate; consider --margin {(-led['emin']):.1f}")

    model_id = args.model_id or dt.date.today().strftime("%Y%m%d") + "-" + "+".join(
        os.path.basename(p).split("__")[0].replace("aligned_tpbm_temperature_", "")[:12] for p in args.csvs)

    def arr(v):
        return ", ".join(f"{x:.3f}f" for x in v)

    hdr = f"""// GENERATED by analysis/thermal/fit_surface_model.py -- do not edit by hand.
// Re-run the fit and regenerate whenever the DS18B20, LED array or heater is
// remounted: this table describes the geometry it was measured on.
//
// model id : {model_id}
// sources  : {", ".join(os.path.basename(p) for p in args.csvs)}
// LED      : n={led['n']}, RMS {led['rms']:.2f} C, worst {led['max']:.1f} C, residual {led['emin']:+.1f}..{led['emax']:+.1f} C
// HEATER   : n={out['HEATER']['n']}, RMS {out['HEATER']['rms']:.2f} C, worst {out['HEATER']['max']:.1f} C
//
// surface = device + gap[device] + rate * (device - device_{SLOPE_WINDOW_S}s_ago) / {SLOPE_WINDOW_S}
#ifndef SURFACE_MODEL_H
#define SURFACE_MODEL_H

#define SURF_MODEL_ID      "{model_id}"
#define SURF_SLOPE_WINDOW_S {SLOPE_WINDOW_S}
#define SURF_NODE_T0       {NODE_T0:.1f}f
#define SURF_NODE_STEP     {NODE_STEP:.1f}f
#define SURF_NODE_N        {NODE_N}

// gap (surface minus device, C) at zero slope, at device temperatures
// {NODE_T0:.0f}, {NODE_T0 + NODE_STEP:.0f}, ... {NODE_T0 + NODE_STEP * (NODE_N - 1):.0f} C; flat beyond the ends.
const float SURF_GAP_LED[SURF_NODE_N]    = {{{arr(led['nodes'])}}};
const float SURF_RATE_LED                = {led['rate']:.2f}f;   // C per (C/s) of device slope
const float SURF_GAP_HEATER[SURF_NODE_N] = {{{arr(out['HEATER']['nodes'])}}};
const float SURF_RATE_HEATER             = {out['HEATER']['rate']:.2f}f;

#endif
"""
    with open(args.out, "w") as f:
        f.write(hdr)
    print(f"\nwrote {args.out}  (model id {model_id})")


if __name__ == "__main__":
    main()
