---
name: skill-creator
description: Framework for extending and adding new cognitive tasks and timing scripts.
---

# Cognitive Task Extension & Modification Framework

This directory is a framework for extending the experimental app with new cognitive tests or calibration routines.

## 1. Creating a New Cognitive Test
To add a new experiment task (e.g., visual reaction-time, n-back):
1. **Define the Event Struct**: Establish the data schema to log. At minimum, each logged event must capture:
   - `trialIndex` (Integer)
   - `timestamp` (Float from `performance.now()`)
   - `eventType` (String: e.g., 'STIMULUS', 'RESPONSE', 'PREMATURE_ABORT')
   - `latency` (Float or Null)
2. **Implement Trigger Hooks**: Use programmatically generated stimuli (via Web Audio API or SVG rendering) to ensure microsecond-level scheduling accuracy.
3. **Register the Task**: Add the task selector to the researcher dashboard and bind its event listeners.

## 2. Standardizing High-Precision Input Capture
All user interface code must capture inputs using:
```javascript
// High-precision non-blocking event listener
window.addEventListener('keydown', (e) => {
  const pressTime = performance.now();
  if (e.key === ' ' && !e.repeat) {
    e.preventDefault();
    handleResponse(pressTime);
  }
}, { capture: true, passive: false });
```

## 3. Storage and Backup
Always mirror the trial log in `localStorage` in real-time under a key containing the participant ID and timestamp (e.g., `nir-pbm-P05-1719246100`):
```javascript
localStorage.setItem(currentTrialKey, JSON.stringify(currentTrialData));
```
This ensures complete scientific trace logs are recoverable in the event of browser crashes or power interruptions.
