# Wiring Verification Schematic — Design

**Date:** 2026-07-02
**Deliverable:** `APP/wiring_check.html` + `APP/wiring_check.js`

## Purpose

An interactive schematic for verifying every physical connection of the NIR tPBM device before bring-up. The researcher clicks each wire, follows its verification instructions (multimeter check or `io_test` command), and marks it confirmed. It replaces mentally cross-referencing `hardware/wiring_guide.md` against the bench.

## Decisions (user-approved)

- **Interactive checklist schematic**, not a static/printable diagram.
- **Passive** — no Web Serial. It references `io_test` commands; `APP/io_test.html` stays the live control panel. Avoids two pages competing for the one serial port.
- Lives in `APP/`, styled to match the existing dark-mode dashboards. No external libraries; must work offline from a local static server.

## Schematic content (source of truth: `firmware/main/pins.h` + `hardware/wiring_guide.md`)

Hand-authored inline SVG block schematic showing:

- **Arduino Uno** with pins 2, 5V, GND, 6, 7, 8, 9, 10, 13 broken out.
- **TB6612FNG** with VM, VCC, GND, STBY, PWMA/AIN1/AIN2/AO1/AO2, PWMB/BIN1/BIN2/BO1/BO2.
- **DS18B20** with the 4.7 kΩ pull-up drawn explicitly between DATA and 5V.
- **NIR LED strip segment** on channel A outputs; **heater ring** on channel B outputs.
- **Four indicator LEDs** (pins 6/7/8/13) each with a 220 Ω series resistor.
- **12 V supply**, with the common-ground junction drawn as one explicit node (Arduino GND + TB6612 GND + 12 V −).
- **STBY → 5V** as the default; the optional STBY → Pin 12 variant drawn dashed with a note referencing `TB_STBY_CONTROL` in `pins.h`.

## Interaction model

- ~24 connections, each a distinct clickable SVG net plus a matching row in a checklist panel beside the diagram. Wire and row are two views of the same item; selecting either highlights both.
- Selecting a connection shows: endpoints (e.g. "Arduino D9 → TB6612 PWMA"), verification instructions, and a **Confirm** toggle. Confirmed = green in diagram and list; unverified = gray.
- Verification instructions are one of:
  - **Power-off**: multimeter continuity/resistance check.
  - **Power-on**: expected voltage (5 V / 12 V rails).
  - **Functional**: the `io_test` serial command (`A`, `B`, `C`, `T`) and the expected observation. The NIR step notes that 850 nm is nearly invisible — view the strip through a phone camera.
- Checklist grouped in bring-up order: ① power-off continuity → ② power-on voltage → ③ functional `io_test` checks.
- Progress counter ("N / 24 confirmed") at top; state persisted in `localStorage`; Reset button clears all confirmations.

## Data model

A single JS array in `wiring_check.js`: `{ id, from, to, group, instructions, svgNetId }`. The SVG paths carry `data-net` ids; JS wires up click/hover/confirm state from the array. No build step.

## Testing

- Load on the local static server; click through wires; verify green state, progress counter, and persistence across reload; verify Reset.
- Line-by-line audit of the connection array against `pins.h` and `wiring_guide.md` — every documented connection present, no invented ones.

## Out of scope

- Web Serial / live hardware control (io_test.html's job).
- Print stylesheet (user chose interactive-only).
- Editing the wiring itself; this page documents and verifies the design as specified in the wiring guide.
