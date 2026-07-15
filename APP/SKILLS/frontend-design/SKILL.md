---
name: frontend-design
description: Guidelines and specifications for the NIR Brain Stimulation Experiment UI.
---

# Experiment UI Frontend Design & Precision Guidelines

This document details the guidelines and implementations for the reaction-time task web app (`APP/`).

## 1. Timing Precision
* **Event Capture**: Use `window.addEventListener('keydown', handler, { capture: true, passive: false })` to intercept keyboard events at the earliest phase.
* **Timestamping**: Utilize `performance.now()` instead of `Date.now()`. `performance.now()` returns a high-resolution timestamp in milliseconds (with microsecond precision), which is unaffected by system clock adjustments.
* **Input Debouncing**: Filter out key-down repeat events by checking `event.repeat`. Ensure that only the initial press registers.
* **Action Prevention**: Always invoke `event.preventDefault()` for the Space key to stop the browser from scrolling down.

## 2. Audio Stimulus (Web Audio API)
* To avoid the performance overhead and caching latency of loading external audio files, generate tones programmatically.
* **Envelope Shaping**: Implement a smooth attack and decay envelope to prevent audible clicks/pops:
  * **Oscillator**: Sine wave at 600 Hz (pleasant, clear pitch).
  * **Attack**: Ramp up from 0 to target volume in 10 ms (0.01s).
  * **Decay/Release**: Ramp down to 0 in 150 ms (0.15s).
  * **AudioContext**: Instantiated on the first user interaction to comply with browser autoplay policies.

## 3. Trial Protocol Logic
* **Duration**: Exactly 40 seconds per trial.
* **Interval**: The stimulus plays 5 seconds + a random offset [0.0, 1.0] seconds after the last press.
* **Premature Press (False Alarm)**: If the participant presses the Space bar *before* the sound plays:
  * Record the event as a false alarm.
  * Reset the timer to delay the sound for another 5s + random [0.0, 1.0]s from this new press. This prevents rhythmic anticipation.

## 4. UI/UX Aesthetics
* **Theme**: Modern dark mode with high contrast. Use a palette of dark charcoal, slate, and vibrant highlights (e.g., violet or teal).
* **Blinding Support**: Display a plain, distraction-free calibration screen for the participant (as their eyes are closed).
* **Researcher Dashboard**: Include real-time status indicators, trial countdown, participant metadata entry, and a live reaction-time plot.
* **Data Management**: Persist trial results in `localStorage` to guard against accidental page reloads. Provide CSV download functionality.
