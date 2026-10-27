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
html = (root / "APP/index.html").read_text()


def const(name):
    m = re.search(rf"^const {name} = ([^;]+);", src, re.M)
    return eval(m.group(1).split("//")[0]) / 1000.0   # ms -> s (expressions like 5 * 60 * 1000)


EMG, RT, COOL = const("EMG_PHASE_MS"), const("RT_PHASE_MS"), const("COOLING_BREAK_MS")
PRE, SEG, CARD = const("PRE_GAP_MS"), const("BLOCKED_SEG_MS"), const("CARD_REMOVE_MS")
# the off gap after each block: the config field default (index.html); one window, also separates blocks
POST = float(re.search(r'id="pause-duration"[^>]*value="(\d+)"', html).group(1))
segments = [s.strip().strip("'\"") for s in re.search(r"const BLOCKED_SEGMENTS = \[([^\]]+)\]", src).group(1).split(",")]

C = {"blocked": "#8e8e8e", "card": "#f0b429", "pre": "#d9d9d9", "emg": "#4c78a8", "cool": "#b7d3ea",
     "rt": "#e45756", "post": "#f2b5b3", "on": "#2e7d32", "off": "#ffffff"}
mmss = lambda t: f"{int(t // 60):02d}:{int(t % 60):02d}"


def condition_blocks(t0):
    """(start, dur, kind, label, stim_on) for one condition starting at t0."""
    b, t = [], t0
    for kind, dur, label, on in [("emg", EMG / 2, "EMG", True), ("cool", COOL, "cool", False), ("emg", EMG / 2, "EMG", True),
                                 ("rt", RT / 2, "RT", True), ("cool", COOL, "cool", False), ("rt", RT / 2, "RT", True),
                                 ("post", POST, "off gap", False)]:
        b.append((t, dur, kind, label, on)); t += dur
    return b, t


# ---------------- whole session ----------------
blocks, t = [], 0.0
for s in segments:
    blocks.append((t, SEG, "blocked", s if s != "OFF" else "off", s != "OFF")); t += SEG
blocks.append((t, CARD, "card", "card", False)); t += CARD
blocks.append((t, PRE, "pre", "pre gap", False)); t += PRE
cond_starts = []
for i in range(3):
    cond_starts.append(t)
    cb, t = condition_blocks(t); blocks += cb
total = t
cond_len = EMG + RT + 2 * COOL + POST

fig = plt.figure(figsize=(16, 11), dpi=150)
gs = fig.add_gridspec(3, 1, height_ratios=[1.15, 0.55, 2.1], hspace=0.75, left=0.075, right=0.985, top=0.93, bottom=0.115)

# --- panel 1: whole session ---
ax = fig.add_subplot(gs[0])
for (s, d, kind, label, on) in blocks:
    ax.barh(1, d / 60, left=s / 60, height=0.8, color=C[kind], edgecolor="white", linewidth=0.5)
    ax.barh(0, d / 60, left=s / 60, height=0.5, color=C["on"] if on else C["off"], edgecolor="#2e7d32", linewidth=0.6)
for i, cs in enumerate(cond_starts):
    ax.text((cs + cond_len / 2) / 60, 1.62, f"condition {i + 1}  ·  {cond_len / 60:g} min  ·  {mmss(cs)} → {mmss(cs + cond_len)}",
            ha="center", va="bottom", fontsize=9)
t_cal = 4 * SEG + CARD + PRE
ax.annotate(f"calibration (card on), card removal, pre gap\n{mmss(0)} → {mmss(t_cal)}", xy=(t_cal / 2 / 60, 1.42),
            xytext=(t_cal / 2 / 60 + 1.2, 2.55), ha="left", va="center", fontsize=8.5,
            arrowprops=dict(arrowstyle="-", color="#777", linewidth=0.7))
ax.set_yticks([0, 1]); ax.set_yticklabels(["light / heater", "phase"]); ax.set_ylim(-0.6, 3.0)
ax.set_xlim(-0.2, total / 60 + 0.2); ax.set_xlabel("minutes from Start")
ax.set_title(f"Whole session — {total / 60:.1f} min ({mmss(total)}) at the default {POST / 60:g}-min off gaps; condition order is randomised per participant",
             loc="left", fontsize=11, fontweight="bold")
for sp in ("top", "right"): ax.spines[sp].set_visible(False)

# --- panel 2: start of session ---
ax2 = fig.add_subplot(gs[1])
t = 0
for s in segments + ["card", "pre"]:
    d = SEG if s in segments else (CARD if s == "card" else PRE)
    on = s in segments and s != "OFF"
    face = C["on"] if on else (C["card"] if s == "card" else C["off"])
    ax2.barh(0, d, left=t, height=0.7, color=face, edgecolor="#555", linewidth=0.6)
    txt = {"card": "remove\ncard", "pre": f"pre gap (light off), {PRE / 60:g} min"}.get(s, (s if s != "OFF" else "light off") + f"\n{SEG:g} s")
    ax2.text(t + d / 2, 0, txt, ha="center", va="center", fontsize=8, color="white" if on else "black")
    t += d
ax2.set_xlim(0, t); ax2.set_yticks([]); ax2.set_xlabel("seconds from Start")
ax2.set_title("Start of session: blocked-light calibration (light physically covered by the card) → card removal → pre gap",
              loc="left", fontsize=10, fontweight="bold")
for sp in ("top", "right", "left"): ax2.spines[sp].set_visible(False)

# --- panel 3: one condition ---
ax3 = fig.add_subplot(gs[2])
cb, end = condition_blocks(0.0)
for (s, d, kind, label, on) in cb:
    ax3.barh(1, d / 60, left=s / 60, height=0.8, color=C[kind], edgecolor="white", linewidth=0.8)
    ax3.text((s + d / 2) / 60, 1, f"{label}\n{d / 60:g} min", ha="center", va="center", fontsize=8.5,
             color="white" if kind in ("emg", "rt") else "black")
on_runs, cur = [], None
for (s, d, kind, label, on) in cb:
    if on:
        cur = (cur[0], cur[1] + d) if cur and abs(cur[0] + cur[1] - s) < 1e-6 else (on_runs.append(cur) if cur else None) or (s, d)
    elif cur:
        on_runs.append(cur); cur = None
if cur: on_runs.append(cur)
for (s, d) in on_runs:
    ax3.barh(0, d / 60, left=s / 60, height=0.55, color=C["on"], edgecolor="#1b5e20")
    ax3.text((s + d / 2) / 60, 0, f"ON {d / 60:g} min", ha="center", va="center", fontsize=9, color="white", fontweight="bold")
for (s, d, kind, label, on) in cb:
    if not on:
        ax3.text((s + d / 2) / 60, 0, "OFF", ha="center", va="center", fontsize=8, color="#555")

# marker strip: short labels on three staggered rows, each with a leader line to the phase bar
marks = [(0, "10/11/12 SESSION_START\n20 EMG_START"), (EMG / 2, "42 COOL_START"), (EMG / 2 + COOL, "43 COOL_END"),
         (EMG + COOL, "21 EMG_END\n22 RT_START"), (EMG + COOL + RT / 2, "42 COOL_START"), (EMG + 2 * COOL + RT / 2, "43 COOL_END"),
         (EMG + 2 * COOL + RT, "23 RT_END\n44 POST_START\n(ask the sham question)"), (end, "45 POST_END\n15/16/17 SESSION_END")]
rows = [1.65, 2.25, 2.85]
for i, (tm, txt) in enumerate(marks):
    y = rows[i % 3]
    ha = "left" if i == 0 else ("right" if i == len(marks) - 1 else "center")
    ax3.plot([tm / 60, tm / 60], [1.42, y - 0.05], color="#555", linewidth=0.7)
    ax3.text(tm / 60, y, txt, ha=ha, va="bottom", fontsize=7.5, linespacing=1.15,
             bbox=dict(boxstyle="round,pad=0.2", facecolor="white", edgecolor="none", alpha=0.9))
# dotted phase boundaries only between the two bars, never through text
for (s, d, kind, label, on) in cb[1:]:
    ax3.plot([s / 60, s / 60], [0.3, 0.58], color="#333", linewidth=0.7, linestyle=":")
x_b = (EMG + COOL) / 60
ax3.annotate("no break at the EMG→RT boundary:\nthe light stays ON for 5 min across it", xy=(x_b, -0.3), xytext=(x_b, -1.05),
             ha="center", va="top", fontsize=9, color="#b71c1c",
             arrowprops=dict(arrowstyle="->", color="#b71c1c", shrinkA=0, shrinkB=2))
ax3.set_yticks([0, 1]); ax3.set_yticklabels(["light / heater", "phase"]); ax3.set_ylim(-1.75, 3.75)
ax3.set_xlim(-0.15, end / 60 + 0.15); ax3.set_xlabel("minutes from the condition's SESSION_START")
ax3.set_title(f"One condition — {end / 60:g} min: light/heater on {sum(d for _, d in on_runs) / 60:g} min in blocks of "
              + " | ".join(f"{d / 60:g}" for _, d in on_runs) + " min, then the off gap (also the gap to the next condition)",
              loc="left", fontsize=11, fontweight="bold")
for sp in ("top", "right"): ax3.spines[sp].set_visible(False)

fig.legend(handles=[Patch(color=C["emg"], label="EMG phase (eyes closed, no task)"), Patch(color=C["rt"], label="reaction-time phase (tones + spacebar)"),
                    Patch(color=C["cool"], label="cooling break (light off)"), Patch(color=C["post"], label="off gap (ends the block; also separates blocks)"),
                    Patch(color=C["blocked"], label="blocked-light calibration"), Patch(color=C["on"], label="light / heater ON")],
           loc="lower center", ncol=3, fontsize=8.5, frameon=False, bbox_to_anchor=(0.5, 0.012))
fig.suptitle("tPBM session timeline — drawn from APP/app.js constants", fontsize=13, fontweight="bold", y=0.985)
out = root / "docs/figures/session_timeline"
fig.savefig(f"{out}.png", bbox_inches="tight"); fig.savefig(f"{out}.svg", bbox_inches="tight")
print(f"total session {total / 60:.1f} min; one condition {end / 60:g} min; on-blocks {[d / 60 for _, d in on_runs]} min")
