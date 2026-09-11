# Graph Report - .  (2026-07-30)

## Corpus Check
- Corpus is ~32,472 words - fits in a single context window. You may not need a graph.

## Summary
- 395 nodes · 627 edges · 21 communities (20 shown, 1 thin omitted)
- Extraction: 90% EXTRACTED · 9% INFERRED · 1% AMBIGUOUS · INFERRED: 59 edges (avg confidence: 0.79)
- Token cost: 152,382 input · 32,653 output

## Community Hubs (Navigation)
- Reaction-Time Task App
- Hardware Dashboard UI
- Browser Control Panels
- I/O Diagnostics Page
- Thermal Calibration Script
- Web Serial Device Link
- LSL Marker Bridge Service
- Wiring Check Schematic
- Reaction-Time Task Protocol
- Firmware Control & Safety
- Bring-Up & Setup Workflow
- EEG Marker Infrastructure
- Marker Codebook & Data Pipeline
- Driver Wiring & Pinout
- Browser Marker Client
- Experimental Conditions & Blinding
- tPBM Light Dose & Literature
- Software Availability

## God Nodes (most connected - your core abstractions)
1. `logToConsole()` - 17 edges
2. `resumeAfterThermal()` - 12 edges
3. `logEvent()` - 11 edges
4. `sendMarker()` - 10 edges
5. `handleKeyPress()` - 10 edges
6. `startRtPhase()` - 10 edges
7. `triggerStimulus()` - 10 edges
8. `endRun()` - 10 edges
9. `handleTelemetryEvent()` - 10 edges
10. `logToConsole()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `Bridge-Before-Recording Startup Order` --semantically_similar_to--> `Bring-up & Validation Order`  [INFERRED] [semantically similar]
  lsl_bridge/README.md → hardware/wiring_guide.md
- `Interactive Wiring Verification Schematic (wiring_check.html/js)` --semantically_similar_to--> `localStorage Trial Log Persistence + CSV Export`  [INFERRED] [semantically similar]
  docs/superpowers/specs/2026-07-02-wiring-check-schematic-design.md → CLAUDE.md
- `Auditory Reaction-Time Task (Methods)` --semantically_similar_to--> `600 Hz Sine Tone Stimulus Protocol`  [INFERRED] [semantically similar]
  docs/methods_software.md → CLAUDE.md
- `Auditory Reaction-Time Task (Methods)` --semantically_similar_to--> `Response Window / NO_RESPONSE Omission`  [INFERRED] [semantically similar]
  docs/methods_software.md → CLAUDE.md
- `COM Port Exclusivity / serial_lock.js Coordination` --semantically_similar_to--> `Single-Holder Serial Port Contention Troubleshooting`  [INFERRED] [semantically similar]
  SETUP.md → docs/testing_and_validation.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Web Serial single-port ownership across the three operator pages (serial_lock.js)** — app_index_nir_device_link, app_arduino_serial_connection_panel, app_io_test_io_diagnostics_page, app_index_experiment_task_page, app_arduino_hardware_dashboard_page [INFERRED 0.85]
- **Thermal safety chain: DS18B20 sensing to PID heater regulation to 40 °C latch to operator alert** — app_io_test_onewire_sensor_diagnostics, app_arduino_temperature_gauge, app_arduino_heater_pid_control, app_arduino_safety_latch_monitor, app_index_nir_stop_alert [INFERRED 0.85]
- **High-precision reaction-time measurement protocol (capture-phase input, synthesised tone, jittered scheduling, persisted log)** — app_skills_frontend_design_skill_timing_precision, app_skills_frontend_design_skill_audio_stimulus, app_skills_frontend_design_skill_trial_protocol_logic, app_skills_skill_creator_skill_input_capture_standard, app_skills_skill_creator_skill_event_struct, app_index_experiment_task_page [INFERRED 0.85]
- **Browser-to-EEG Marker Pipeline** — claude_experiment_ui_application, docs_lsl_eeg_marker_integration_marker_bridge, docs_lsl_eeg_marker_integration_lsl, docs_lsl_eeg_marker_integration_nic2, docs_lsl_eeg_marker_integration_marker_vocabulary, docs_lsl_eeg_marker_integration_analysis_pipeline [EXTRACTED 1.00]
- **40 °C Thermal Safety Chain (requirement, firmware, test, marker)** — claude_safety_requirements, docs_methods_software_latching_safety_cutoff, docs_testing_and_validation_safety_test, docs_lsl_eeg_marker_integration_thermal_pause_resume, docs_methods_software_thermal_matching_pid [INFERRED 0.85]
- **Reaction-Time Trial Timing Model** — claude_timer_jitter, claude_response_window_omission, claude_anticipation_reset, claude_high_rate_keypress_capture, docs_methods_software_audible_onset_rt [EXTRACTED 1.00]
- **NIR-Matched Heating-Control Pipeline** — calibration_calibrate_thermal, calibration_readme_plateau_temperature, calibration_readme_thermal_profile_json, calibration_readme_h_setpoint_command, app_index [EXTRACTED 1.00]
- **Browser-to-EEG Marker Path** — app_index, app_arduino, lsl_bridge_readme_websocket_relay, lsl_bridge_lsl_bridge, lsl_bridge_readme_tpbm_markers_outlet, lsl_bridge_readme_nic2_integration [EXTRACTED 1.00]
- **Pre-Session Hardware Validation Sequence** — hardware_wiring_guide_io_test, hardware_wiring_guide_safety_test, hardware_wiring_guide_main_controller, hardware_wiring_guide_bringup_order, app_arduino [EXTRACTED 1.00]

## Communities (21 total, 1 thin omitted)

### Community 0 - "Reaction-Time Task App"
Cohesion: 0.06
Nodes (75): abortTrial(), audioTimeToPerf(), clearAllHistory(), completeSession(), condCode(), currentSessionData, currentTempC(), currentTrialData (+67 more)

### Community 1 - "Hardware Dashboard UI"
Cohesion: 0.06
Nodes (58): applyFilterToElement(), applyLogFilters(), arduinoConditionVal, arduinoStateVal, blockHeater, blockPulse, btnClearConsole, btnConnect (+50 more)

### Community 2 - "Browser Control Panels"
Cohesion: 0.07
Nodes (39): Device Action Commands (M cycle, G start, X abort, R reset latch, S simulate over-temp), Hardware Dashboard Page (arduino.html), Closed-Loop PID Heater Control (NIR-matched target 37.5 °C), Mode LED Blinding Constraint (mode LEDs off during active stimulation), Safety Latch & State Monitoring (40.0 °C cutoff), Web Serial Connection Panel (115200 bps), Serial Data Feed Console with Telemetry/Controls Filters, DS18B20 Contact Temperature Gauge & 60 s Sparkline (+31 more)

### Community 3 - "I/O Diagnostics Page"
Cohesion: 0.08
Nodes (36): btnClearConsole, btnConnect, btnDisconnect, btnQueryHelp, btnReadTemp, btnSendManualCmd, btnTestCycleLeds, btnToggleHeater (+28 more)

### Community 4 - "Thermal Calibration Script"
Cohesion: 0.10
Nodes (29): cool_until_stable(), drain_and_watch(), find_port(), main(), parse_mode(), parse_temp(), plateau_of(), Cycle the firmware mode until MODE_SELECT reports target_idx (device must be… (+21 more)

### Community 5 - "Web Serial Device Link"
Cohesion: 0.17
Nodes (19): connect(), disconnect(), emitStatus(), hardCleanup(), loadThermalProfile(), marker(), onUnexpectedDrop(), openPort() (+11 more)

### Community 6 - "LSL Marker Bridge Service"
Cohesion: 0.10
Nodes (21): APP/index.html Behavioural Task Page, Calibrate Once, Not Per Participant, Heating-Control Condition, Thermal Calibration (Heating-Control Matching), pyserial >= 3.5 (calibration dependency), docs/lsl_eeg_marker_integration.md, encode_marker(), handle_client() (+13 more)

### Community 7 - "Wiring Check Schematic"
Cohesion: 0.18
Nodes (15): checklistEl, confirmed, CONNECTIONS, detailEl, netElements(), progDone, progFill, progTotal (+7 more)

### Community 8 - "Reaction-Time Task Protocol"
Cohesion: 0.27
Nodes (11): Anticipation Reset / False Alarm, Experiment UI Application (APP/), High-Rate Keypress Capture (performance.now, capture phase), Response Window / NO_RESPONSE Omission, 600 Hz Sine Tone Stimulus Protocol, Timer Jitter (5 s + 0-2 s random ISI), Wrist EMG Run (silent condition), 17-Minute Session Structure (10-min EMG + 7-min RT phase) (+3 more)

### Community 9 - "Firmware Control & Safety"
Cohesion: 0.20
Nodes (11): El Khoury et al. (2019) — 810 nm pulsed tPBM, pins.h Pin-Assignment Convention, Non-Negotiable Safety Requirements, Latching 40 °C Safety Cut-Off with DS18B20 Polling, Three-Component Control System Overview, Timer1 CTC Pulse Generation (10.00/40.00 Hz, prescaler 64), Web Serial Task-Stimulation Co-Registration, main Sketch — Experiment Controller (+3 more)

### Community 10 - "Bring-Up & Setup Workflow"
Cohesion: 0.24
Nodes (11): Three-Group Bring-Up Order (continuity, voltage, functional), Connection Array Data Model ({id, from, to, group, instructions, svgNetId}), Passive (No Web Serial) Design Decision, Schematic Content (Uno, TB6612FNG, DS18B20, LED strip, heater, indicators), Interactive Wiring Verification Schematic (wiring_check.html/js), io_test Sketch — Wiring Verification, Single-Holder Serial Port Contention Troubleshooting, TB6612 STBY Tied to 5V (always-enabled) (+3 more)

### Community 11 - "EEG Marker Infrastructure"
Cohesion: 0.22
Nodes (10): Browsers Cannot Speak LSL Natively, Enobio 32 EEG/EMG Amplifier, Lab Streaming Layer (LSL), Local WebSocket-to-LSL Marker Bridge (tPBM-Markers outlet), NIC2 (Neuroelectrics Instrument Controller v2), Shared Clock Requirement for Markers, LabRecorder XDF Fallback, Bridge Dependency Install (pylsl + websockets, bundled liblsl.dll) (+2 more)

### Community 12 - "Marker Codebook & Data Pipeline"
Cohesion: 0.22
Nodes (9): localStorage Trial Log Persistence + CSV Export, Offline Analysis Pipeline (MNE / pyxdf epoching by code), Marker Vocabulary and Numeric Codebook (SIMPLE_CODES/COND_CODES), NIC2 Numeric-Only Marker Constraint, Thermal Shutdown Pause/Resume Markers (40/41), Timing Accuracy Budget (~1 ms LSL, ~1-3 ms bridge), Data Acquisition and Storage (Methods), Event Synchronisation with EEG Recording (Methods) (+1 more)

### Community 13 - "Driver Wiring & Pinout"
Cohesion: 0.25
Nodes (9): firmware/main/pins.h, Channel A — NIR LED Strip (PWMA / Pin 9), Channel B — Heater Ring/Wire (PWMB / Pin 10), Mandatory Common Ground, 1.2 A Continuous / 3.2 A Peak Channel Current Limit, Arduino Quick-Reference Pinout Map, TB6612 STBY Enable Strategy (5V strap vs Pin 12 control), TB6612FNG Dual Driver (+1 more)

### Community 14 - "Browser Marker Client"
Cohesion: 0.43
Nodes (4): log(), open(), scheduleRetry(), send()

### Community 16 - "Experimental Conditions & Blinding"
Cohesion: 0.47
Nodes (6): 10 Hz NIR Condition, 40 Hz NIR Condition, Blinding Design (NIR invisibility), Heating Control Condition, Vlahinic et al. (2020) — 850 nm 10 Hz tPBM EEG study, Delta-Matched Heating Control via PID (rise above own baseline)

### Community 17 - "tPBM Light Dose & Literature"
Cohesion: 0.67
Nodes (3): Light Dose Specification (850 nm, 1.25 J/cm2, 50% duty), Salehpour et al. (2018) — LED-based brain PBM review, Transcranial Photobiomodulation (tPBM)

## Ambiguous Edges - Review These
- `Session Protocol Summary (17 min = 10 EMG + 7 reaction-time, 5 s + [0,2 s] jitter, SPACE key)` → `Trial Protocol Logic (40 s trial, 5 s + jitter, false-alarm timer reset)`  [AMBIGUOUS]
  APP/SKILLS/frontend-design/SKILL.md · relation: conceptually_related_to
- `TB6612 Driver Output Panel (PWMA NIR, PWMB heater, STBY enable)` → `Low-Side Logic-Level MOSFET Switch Topology (24 V NIR rail, separate 12 V heater rail)`  [AMBIGUOUS]
  APP/wiring_check.html · relation: conceptually_related_to
- `Experiment UI Application (APP/)` → `17-Minute Session Structure (10-min EMG + 7-min RT phase)`  [AMBIGUOUS]
  docs/lsl_eeg_marker_integration.md · relation: conceptually_related_to
- `17-Minute Session Structure (10-min EMG + 7-min RT phase)` → `Session Structure and Per-Participant Randomisation`  [AMBIGUOUS]
  docs/lsl_eeg_marker_integration.md · relation: semantically_similar_to

## Knowledge Gaps
- **116 isolated node(s):** `sessionConditions`, `currentSessionData`, `currentTrialData`, `reactionTimes`, `elParticipantId` (+111 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Session Protocol Summary (17 min = 10 EMG + 7 reaction-time, 5 s + [0,2 s] jitter, SPACE key)` and `Trial Protocol Logic (40 s trial, 5 s + jitter, false-alarm timer reset)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `TB6612 Driver Output Panel (PWMA NIR, PWMB heater, STBY enable)` and `Low-Side Logic-Level MOSFET Switch Topology (24 V NIR rail, separate 12 V heater rail)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Experiment UI Application (APP/)` and `17-Minute Session Structure (10-min EMG + 7-min RT phase)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `17-Minute Session Structure (10-min EMG + 7-min RT phase)` and `Session Structure and Per-Participant Randomisation`?**
  _Edge tagged AMBIGUOUS (relation: semantically_similar_to) - confidence is low._
- **Why does `Bring-up & Validation Order` connect `Thermal Calibration Script` to `Hardware Dashboard UI`, `LSL Marker Bridge Service`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `Localhost WebSocket Relay (ws://127.0.0.1:3535)` connect `LSL Marker Bridge Service` to `Hardware Dashboard UI`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `resumeAfterThermal()` (e.g. with `endRun()` and `startRtPhase()`) actually correct?**
  _`resumeAfterThermal()` has 2 INFERRED edges - model-reasoned connections that need verification._