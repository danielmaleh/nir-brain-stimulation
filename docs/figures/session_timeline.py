#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib>=3.8"]
# ///
"""Draw the session timeline from the constants in APP/app.js (no hand-typed numbers).

    uv run docs/figures/session_timeline.py      -> docs/figures/session_timeline.{png,svg}
"""
import re, pathlib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

root = pathlib.Path(__file__).resolve().parents[2]
src = (root / "APP/app.js").read_text()
def const(name):
    m = re.search(rf"^const {name} = ([^;]+);", src, re.M)
    return eval(m.group(1).split("//")[0]) / 1000.0   # ms -> s (expressions like 5 * 60 * 1000)
EMG, RT, COOL = const("EMG_PHASE_MS"), const("RT_PHASE_MS"), const("COOLING_BREAK_MS")
PRE, POST, SEG, CARD = const("PRE_GAP_MS"), const("POST_GAP_MS"), const("BLOCKED_SEG_MS"), const("CARD_REMOVE_MS")
PAUSE_DEFAULT = float(re.search(r'id="pause-duration"[^>]*value="(\d+)"', (root / "APP/index.html").read_text()).group(1))
POST = PAUSE_DEFAULT  # the off gap after each block: the config field default (index.html), one window, also separates blocks
segments = re.search(r"const BLOCKED_SEGMENTS = \[([^\]]+)\]", src).group(1)
segments = [s.strip().strip("'\"") for s in segments.split(",")]

C = {"blocked": "#8e8e8e", "card": "#f0b429", "pre": "#d9d9d9", "emg": "#4c78a8", "cool": "#b7d3ea",
     "rt": "#e45756", "post": "#f2b5b3", "rest": "#eeeeee", "on": "#2e7d32", "off": "#ffffff"}

def condition_blocks(t0):
    """(start, dur, kind, label, stim_on) for one condition starting at t0."""
    b = []; t = t0
    for kind, dur, label, on in [("emg", EMG/2, "EMG", True), ("cool", COOL, "cool", False), ("emg", EMG/2, "EMG", True),
                                 ("rt", RT/2, "RT", True), ("cool", COOL, "cool", False), ("rt", RT/2, "RT", True),
                                 ("post", POST, "off gap", False)]:
        b.append((t, dur, kind, label, on)); t += dur
    return b, t

# ---------------- whole session ----------------
blocks = []; t = 0.0
for s in segments:
    blocks.append((t, SEG, "blocked", s if s != "OFF" else "off", s != "OFF")); t += SEG
blocks.append((t, CARD, "card", "card", False)); t += CARD
blocks.append((t, PRE, "pre", "pre gap", False)); t += PRE
cond_starts = []
for i in range(3):
    cond_starts.append(t)
    cb, t = condition_blocks(t); blocks += cb
total = t

fig = plt.figure(figsize=(16, 9.2), dpi=150)
gs = fig.add_gridspec(3, 1, height_ratios=[1.0, 0.55, 1.6], hspace=0.7)

ax = fig.add_subplot(gs[0])
for (s, d, kind, label, on) in blocks:
    ax.barh(1, d/60, left=s/60, height=0.8, color=C[kind], edgecolor="white", linewidth=0.5)
    ax.barh(0, d/60, left=s/60, height=0.5, color=C["on"] if on else C["off"], edgecolor="#2e7d32", linewidth=0.6)
for i, cs in enumerate(cond_starts):
    ax.annotate(f"condition {i+1}\n(13.5 min)", xy=((cs + (EMG+RT+2*COOL+POST)/2)/60, 1.75), ha="center", va="bottom", fontsize=9)
ax.annotate("blocked-light\ncalibration\n(card on)", xy=((4*SEG/2)/60, 1.75), ha="center", va="bottom", fontsize=8)
ax.annotate(f"pre gap\n{PRE/60:.1f} min", xy=((4*SEG+CARD+PRE/2)/60, -0.55), ha="center", va="top", fontsize=8)
ax.set_yticks([0, 1]); ax.set_yticklabels(["light / heater", "phase"]); ax.set_ylim(-1.1, 2.9)
ax.set_xlim(0, total/60); ax.set_xlabel("minutes from Start")
ax.set_title(f"Whole session — {total/60:.1f} min at the default {POST/60:g}-min off gaps", loc="left", fontsize=11, fontweight="bold")
for sp in ("top", "right"): ax.spines[sp].set_visible(False)

# ---------------- blocked-light zoom ----------------
ax2 = fig.add_subplot(gs[1])
t = 0
for s in segments + ["card", "pre"]:
    d = SEG if s in segments else (CARD if s == "card" else PRE)
    on = s in segments and s != "OFF"
    ax2.barh(0, d, left=t, height=0.7, color=C["on"] if on else (C["card"] if s == "card" else C["off"]), edgecolor="#555", linewidth=0.6)
    ax2.text(t + d/2, 0, {"card": "remove\ncard", "pre": "pre gap (off)"}.get(s, s if s != "OFF" else "off"), ha="center", va="center", fontsize=8,
             color="white" if on else "black")
    t += d
ax2.set_xlim(0, t); ax2.set_yticks([]); ax2.set_xlabel("seconds from Start")
ax2.set_title("Start of session: blocked-light calibration (light physically covered) → card removal → pre gap", loc="left", fontsize=10, fontweight="bold")
for sp in ("top", "right", "left"): ax2.spines[sp].set_visible(False)

# ---------------- one condition zoom ----------------
ax3 = fig.add_subplot(gs[2])
cb, end = condition_blocks(0.0)
for (s, d, kind, label, on) in cb:
    ax3.barh(1, d/60, left=s/60, height=0.8, color=C[kind], edgecolor="white", linewidth=0.8)
    ax3.text((s + d/2)/60, 1, f"{label}\n{d/60:g} min", ha="center", va="center", fontsize=8.5, color="white" if kind in ("emg", "rt") else "black")
# light/heater track: merge contiguous ON blocks so the 5-min middle block is visible
on_runs = []; cur = None
for (s, d, kind, label, on) in cb:
    if on:
        if cur and abs(cur[0] + cur[1] - s) < 1e-6: cur = (cur[0], cur[1] + d)
        else:
            if cur: on_runs.append(cur)
            cur = (s, d)
    else:
        if cur: on_runs.append(cur); cur = None
if cur: on_runs.append(cur)
for (s, d) in on_runs:
    ax3.barh(0, d/60, left=s/60, height=0.55, color=C["on"], edgecolor="#1b5e20")
    ax3.text((s + d/2)/60, 0, f"ON {d/60:g} min", ha="center", va="center", fontsize=9, color="white", fontweight="bold")
for (s, d, kind, label, on) in cb:
    if not on: ax3.text((s + d/2)/60, 0, "OFF", ha="center", va="center", fontsize=8, color="#555")
# markers
marks = [(0, "SESSION_START 10/11/12\nEMG_START 20"), (EMG/2, "COOL_START 42"), (EMG/2+COOL, "COOL_END 43"),
         (EMG+COOL, "EMG_END 21\nRT_START 22"), (EMG+COOL+RT/2, "COOL_START 42"), (EMG+2*COOL+RT/2, "COOL_END 43"),
         (EMG+2*COOL+RT, "RT_END 23\nPOST_START 44\n→ ask sham question"), (end, "POST_END 45\nSESSION_END 15/16/17")]
for i, (tm, txt) in enumerate(marks):
    ax3.axvline(tm/60, ymin=0.08, ymax=0.78, color="#333", linewidth=0.7, linestyle=":")
    ax3.text(tm/60, 1.55 + 0.42*(i % 2), txt, ha="center", va="bottom", fontsize=7.2)
ax3.annotate("no break here:\nlight stays ON across\nthe EMG→RT boundary", xy=((EMG+COOL)/60, 0.28), xytext=((EMG+COOL)/60, -1.05),
             ha="center", fontsize=9, color="#b71c1c", arrowprops=dict(arrowstyle="->", color="#b71c1c"))
ax3.set_yticks([0, 1]); ax3.set_yticklabels(["light / heater", "phase"]); ax3.set_ylim(-1.5, 2.6)
ax3.set_xlim(0, end/60); ax3.set_xlabel("minutes from the condition's SESSION_START")
ax3.set_title(f"One condition — {end/60:g} min: light on {sum(d for _, d in on_runs)/60:g} min in blocks of " +
              " | ".join(f"{d/60:g}" for _, d in on_runs) + " min", loc="left", fontsize=11, fontweight="bold")
for sp in ("top", "right"): ax3.spines[sp].set_visible(False)

fig.legend(handles=[Patch(color=C["emg"], label="EMG phase (eyes closed, no task)"), Patch(color=C["rt"], label="reaction-time phase (tones + spacebar)"),
                    Patch(color=C["cool"], label="cooling break"), Patch(color=C["post"], label="off gap (ends the block, separates blocks)"),
                    Patch(color=C["blocked"], label="blocked-light calibration"), Patch(color=C["on"], label="light / heater ON")],
           loc="lower center", ncol=4, fontsize=8.5, frameon=False, bbox_to_anchor=(0.5, 0.0))
fig.suptitle("tPBM session timeline — drawn from APP/app.js constants (2026-10-26)", fontsize=13, fontweight="bold", y=0.995)
out = root / "docs/figures/session_timeline"
fig.savefig(f"{out}.png", bbox_inches="tight"); fig.savefig(f"{out}.svg", bbox_inches="tight")
print(f"total session {total/60:.1f} min; one condition {end/60:g} min; on-blocks {[d/60 for _, d in on_runs]} min")
