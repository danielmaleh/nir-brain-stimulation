/**
 * @file wiring_check.js
 * @brief Interactive wiring verification checklist for the tPBM device schematic.
 *
 * Every entry maps to a net in wiring_check.html's SVG (via data-net). Clicking a
 * wire or a checklist row shows verification instructions; "Confirm" marks it green.
 * State persists in localStorage. Pin map source of truth: firmware/main/pins.h.
 */

const STORAGE_KEY = 'tpbm-wiring-check-v1';

// group: heading shown in the checklist, in bring-up order.
// net: data-net id in the SVG to highlight (several checks can share one net).
const CONNECTIONS = [
  // --- 1. Power & ground (multimeter, everything POWERED OFF) ---
  {
    id: 'gnd-common', net: 'gnd-common', group: '1 · Power & ground — power OFF, continuity mode',
    label: 'Common ground: Arduino ↔ TB6612', pins: 'GND ↔ GND',
    how: 'Continuity between an Arduino <code>GND</code> header pin and TB6612 <code>GND</code>. Expect a beep (&lt;1 Ω). Without this common reference the driver never switches.'
  },
  {
    id: 'gnd-psu', net: 'gnd-psu', group: '1 · Power & ground — power OFF, continuity mode',
    label: '12 V supply (−) joins common ground', pins: 'PSU− ↔ GND',
    how: 'Continuity between the 12 V adapter\'s <code>−</code> lead and Arduino <code>GND</code>. This is the #1 wiring mistake: all three grounds (Arduino, TB6612, PSU−) must be one node.'
  },
  {
    id: 'vm-12v', net: 'vm-12v', group: '1 · Power & ground — power OFF, continuity mode',
    label: '12 V supply (+) → TB6612 VM', pins: 'PSU+ → VM',
    how: 'Continuity from the adapter\'s <code>+</code> lead to TB6612 <code>VM</code>. Also verify there is NO continuity between PSU + and −, and none from VM to 5 V.'
  },
  {
    id: 'vcc-5v', net: 'vcc-5v', group: '1 · Power & ground — power OFF, continuity mode',
    label: 'Arduino 5V → TB6612 VCC (logic)', pins: '5V → VCC',
    how: 'Continuity from Arduino <code>5V</code> pin to TB6612 <code>VCC</code>. This powers the driver\'s logic side only — the loads run from VM.'
  },
  {
    id: 'stby-5v', net: 'stby-5v', group: '1 · Power & ground — power OFF, continuity mode',
    label: 'TB6612 STBY strapped to 5V', pins: 'STBY → 5V',
    how: 'Continuity from <code>STBY</code> to 5 V. If STBY floats or is low, both channels stay dead no matter what the Arduino does. (Only if you chose the optional variant: STBY goes to D12 instead, and <code>TB_STBY_CONTROL</code> must be 1 in pins.h — never both.)'
  },

  // --- 2. Temperature sensor ---
  {
    id: 'ds-vcc', net: 'ds-vcc', group: '2 · DS18B20 temperature sensor — power OFF',
    label: 'DS18B20 VCC (red) → 5V', pins: 'VCC → 5V',
    how: 'Continuity from the sensor\'s red lead to Arduino <code>5V</code>.'
  },
  {
    id: 'ds-gnd', net: 'ds-gnd', group: '2 · DS18B20 temperature sensor — power OFF',
    label: 'DS18B20 GND (black) → GND', pins: 'GND → GND',
    how: 'Continuity from the sensor\'s black lead to Arduino <code>GND</code>.'
  },
  {
    id: 'ds-data', net: 'ds-data', group: '2 · DS18B20 temperature sensor — power OFF',
    label: 'DS18B20 DATA → Arduino D2', pins: 'DATA → D2',
    how: 'Continuity from the sensor\'s data lead (yellow/blue) to Arduino <code>D2</code>.'
  },
  {
    id: 'ds-pullup', net: 'ds-pullup', group: '2 · DS18B20 temperature sensor — power OFF',
    label: '4.7 kΩ pull-up between DATA and 5V', pins: 'D2 ─4.7k─ 5V',
    how: 'Resistance mode between <code>D2</code> and <code>5V</code>: expect ≈ 4.7 kΩ. Missing pull-up = sensor reads −127 °C / <code>NOT DETECTED</code>, and main firmware latches a safety trip at boot. <strong>This is currently the failing check — io_test reports the sensor NOT DETECTED.</strong>'
  },

  // --- 3. TB6612 straps & loads ---
  {
    id: 'ain1', net: 'ain1', group: '3 · TB6612 straps & loads — power OFF',
    label: 'AIN1 strapped HIGH (5V)', pins: 'AIN1 → 5V',
    how: 'Continuity from <code>AIN1</code> to 5 V. Locks channel A "forward" so PWMA alone gates the NIR strip.'
  },
  {
    id: 'ain2', net: 'ain2', group: '3 · TB6612 straps & loads — power OFF',
    label: 'AIN2 strapped LOW (GND)', pins: 'AIN2 → GND',
    how: 'Continuity from <code>AIN2</code> to ground. Make sure AIN1/AIN2 are not swapped — both HIGH or both LOW gives no output.'
  },
  {
    id: 'bin1', net: 'bin1', group: '3 · TB6612 straps & loads — power OFF',
    label: 'BIN1 strapped HIGH (5V)', pins: 'BIN1 → 5V',
    how: 'Continuity from <code>BIN1</code> to 5 V (heater channel forward).'
  },
  {
    id: 'bin2', net: 'bin2', group: '3 · TB6612 straps & loads — power OFF',
    label: 'BIN2 strapped LOW (GND)', pins: 'BIN2 → GND',
    how: 'Continuity from <code>BIN2</code> to ground.'
  },
  {
    id: 'pwma', net: 'pwma', group: '3 · TB6612 straps & loads — power OFF',
    label: 'Arduino D9 → PWMA (NIR gate)', pins: 'D9 → PWMA',
    how: 'Continuity from Arduino <code>D9</code> to <code>PWMA</code>. D9 is deliberate: it\'s a Timer1 pin, giving jitter-free 10/40 Hz pulses.'
  },
  {
    id: 'pwmb', net: 'pwmb', group: '3 · TB6612 straps & loads — power OFF',
    label: 'Arduino D10 → PWMB (heater gate)', pins: 'D10 → PWMB',
    how: 'Continuity from Arduino <code>D10</code> to <code>PWMB</code>.'
  },
  {
    id: 'ao1', net: 'ao1', group: '3 · TB6612 straps & loads — power OFF',
    label: 'AO1 → NIR strip (+)', pins: 'AO1 → NIR+',
    how: 'Continuity from <code>AO1</code> to the strip\'s + pad. Only a short segment (~4 cm² patch) may be connected — full 95 W strip would pull ~8 A and destroy the 1.2 A channel.'
  },
  {
    id: 'ao2', net: 'ao2', group: '3 · TB6612 straps & loads — power OFF',
    label: 'AO2 → NIR strip (−)', pins: 'AO2 → NIR−',
    how: 'Continuity from <code>AO2</code> to the strip\'s − pad. LEDs are polarized: if + and − are swapped the strip never lights.'
  },
  {
    id: 'bo1', net: 'bo1', group: '3 · TB6612 straps & loads — power OFF',
    label: 'BO1 → heater, end 1', pins: 'BO1 → heater',
    how: 'Continuity from <code>BO1</code> to one heater lead. Across BO1–BO2 you should also measure the heater\'s resistance (a few Ω to tens of Ω, not 0 and not ∞).'
  },
  {
    id: 'bo2', net: 'bo2', group: '3 · TB6612 straps & loads — power OFF',
    label: 'BO2 → heater, end 2', pins: 'BO2 → heater',
    how: 'Continuity from <code>BO2</code> to the other heater lead.'
  },

  // --- 4. Indicator LEDs ---
  {
    id: 'led-heating', net: 'led-heating', group: '4 · Indicator LEDs — power OFF',
    label: 'Heating mode LED chain (D6)', pins: 'D6 → 220Ω → LED → GND',
    how: 'Check the chain order: <code>D6</code> → 220 Ω resistor → LED anode (long leg) → cathode → GND. Diode-test mode across the LED should light it faintly one way only.'
  },
  {
    id: 'led-10hz', net: 'led-10hz', group: '4 · Indicator LEDs — power OFF',
    label: '10 Hz mode LED chain (D7)', pins: 'D7 → 220Ω → LED → GND',
    how: 'Same check as D6 chain, from <code>D7</code>.'
  },
  {
    id: 'led-40hz', net: 'led-40hz', group: '4 · Indicator LEDs — power OFF',
    label: '40 Hz mode LED chain (D8)', pins: 'D8 → 220Ω → LED → GND',
    how: 'Same check as D6 chain, from <code>D8</code>.'
  },
  {
    id: 'led-error', net: 'led-error', group: '4 · Indicator LEDs — power OFF',
    label: 'Error LED chain (D13)', pins: 'D13 → 220Ω → LED → GND',
    how: 'Same check, from <code>D13</code> — or skip the external LED and rely on the Uno\'s on-board L LED, which is already on D13.'
  },

  // --- 5. Power-on voltage checks ---
  {
    id: 'chk-5v', net: 'vcc-5v', group: '5 · First power-on — multimeter, voltage mode',
    label: '5 V rail present at TB6612 VCC', pins: 'VCC ≈ 5 V',
    how: 'USB connected, 12 V adapter plugged in. Measure <code>VCC</code> to GND: expect 4.75–5.25 V. Nothing should get warm; if anything does, power off immediately.'
  },
  {
    id: 'chk-12v', net: 'vm-12v', group: '5 · First power-on — multimeter, voltage mode',
    label: '12 V present at TB6612 VM', pins: 'VM ≈ 12 V',
    how: 'Measure <code>VM</code> to GND: expect ≈ 12 V (11.5–12.5 V). 12 V stays within the TB6612\'s ~15 V absolute max.'
  },

  // --- 6. Functional checks with io_test ---
  {
    id: 'fn-temp', net: 'ds-data', group: '6 · Functional — flash firmware/io_test, open io_test.html',
    label: 'T — sensor reports sane temperature', pins: "cmd 'T'",
    how: 'Send <code>T</code>. Expect a believable room/skin temperature (18–35 °C). <code>ERROR_NO_SENSOR</code> means the DS18B20 wiring or the 4.7 kΩ pull-up (group 2) is wrong.'
  },
  {
    id: 'fn-nir', net: 'ao1', group: '6 · Functional — flash firmware/io_test, open io_test.html',
    label: 'A — NIR strip switches on/off', pins: "cmd 'A'",
    how: 'Send <code>A</code> to toggle the NIR channel. 850 nm is nearly invisible to the eye — <strong>view the strip through your phone camera</strong>, where it appears bright purple-white. Toggle off again.'
  },
  {
    id: 'fn-heater', net: 'bo1', group: '6 · Functional — flash firmware/io_test, open io_test.html',
    label: 'B — heater warms up', pins: "cmd 'B'",
    how: 'Send <code>B</code>; within ~10 s the heater ring should feel warm (hover a finger nearby, don\'t press on it). Send <code>B</code> again to switch it off — never leave it running unattended.'
  },
  {
    id: 'fn-leds', net: 'led-heating', group: '6 · Functional — flash firmware/io_test, open io_test.html',
    label: 'C — all four status LEDs cycle', pins: "cmd 'C'",
    how: 'Send <code>C</code> repeatedly: heating (D6) → 10 Hz (D7) → 40 Hz (D8) → error (D13) light one at a time. A dead LED = reversed polarity or wrong resistor placement in that chain.'
  }
];

// --- State ---
let confirmed = loadState();
let selectedId = null;

const svg = document.getElementById('schematic-svg');
const checklistEl = document.getElementById('checklist');
const detailEl = document.getElementById('detail-card');
const progDone = document.getElementById('prog-done');
const progTotal = document.getElementById('prog-total');
const progFill = document.getElementById('prog-fill');

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(confirmed));
}

// --- SVG interactivity setup ---
function setupSvg() {
  // Give every bare .net path with a data-net an invisible fat twin as a click target.
  svg.querySelectorAll('path.net[data-net]').forEach(p => {
    const hit = p.cloneNode(false);
    hit.setAttribute('class', 'net-hit');
    p.after(hit);
  });

  svg.addEventListener('click', (e) => {
    const netEl = e.target.closest('[data-net]');
    if (!netEl) return;
    const netId = netEl.dataset.net;
    // A net may back several checks; select the first unconfirmed one, else the first.
    const candidates = CONNECTIONS.filter(c => c.net === netId);
    if (candidates.length === 0) return;
    const target = candidates.find(c => !confirmed[c.id]) || candidates[0];
    select(target.id);
  });
}

function netElements(netId) {
  return svg.querySelectorAll(`[data-net="${netId}"]`);
}

// --- Rendering ---
function renderChecklist() {
  checklistEl.innerHTML = '';
  let currentGroup = null;
  for (const c of CONNECTIONS) {
    if (c.group !== currentGroup) {
      currentGroup = c.group;
      const h = document.createElement('div');
      h.className = 'check-group-title';
      h.textContent = c.group;
      checklistEl.appendChild(h);
    }
    const row = document.createElement('div');
    row.className = 'check-row';
    row.dataset.id = c.id;
    row.innerHTML = `<span class="check-dot"></span><span class="check-label">${c.label}</span><span class="check-pins">${c.pins}</span>`;
    row.addEventListener('click', () => select(c.id));
    checklistEl.appendChild(row);
  }
}

function refresh() {
  // rows
  checklistEl.querySelectorAll('.check-row').forEach(row => {
    row.classList.toggle('ok', !!confirmed[row.dataset.id]);
    row.classList.toggle('sel', row.dataset.id === selectedId);
  });

  // SVG nets: green only when EVERY check backed by that net is confirmed
  const netIds = new Set(CONNECTIONS.map(c => c.net));
  for (const netId of netIds) {
    const allOk = CONNECTIONS.filter(c => c.net === netId).every(c => confirmed[c.id]);
    netElements(netId).forEach(el => {
      el.classList.toggle('ok', allOk);
      el.classList.remove('sel');
    });
  }
  if (selectedId) {
    const sel = CONNECTIONS.find(c => c.id === selectedId);
    if (sel) netElements(sel.net).forEach(el => el.classList.add('sel'));
  }

  // progress
  const done = CONNECTIONS.filter(c => confirmed[c.id]).length;
  progDone.textContent = done;
  progTotal.textContent = CONNECTIONS.length;
  progFill.style.width = `${(done / CONNECTIONS.length) * 100}%`;

  renderDetail();
}

function renderDetail() {
  const c = CONNECTIONS.find(x => x.id === selectedId);
  if (!c) {
    detailEl.innerHTML = '<div class="detail-placeholder">Select a wire on the schematic or a row below.</div>';
    return;
  }
  const isOk = !!confirmed[c.id];
  detailEl.innerHTML = `
    <h3>${c.label}</h3>
    <div class="detail-endpoints">${c.pins}</div>
    <div class="detail-instructions">${c.how}</div>
    <button class="btn-confirm ${isOk ? 'undo' : ''}" id="btn-confirm">
      ${isOk ? '↩︎ Un-confirm (re-test this connection)' : '✓ Confirm — tested and correct'}
    </button>
  `;
  document.getElementById('btn-confirm').addEventListener('click', () => {
    if (confirmed[c.id]) {
      delete confirmed[c.id];
    } else {
      confirmed[c.id] = true;
    }
    saveState();
    refresh();
  });
}

function select(id) {
  selectedId = (selectedId === id) ? null : id;
  refresh();
  const row = checklistEl.querySelector(`.check-row[data-id="${id}"]`);
  if (row && selectedId) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

document.getElementById('btn-reset').addEventListener('click', () => {
  if (!confirm('Clear all confirmed connections?')) return;
  confirmed = {};
  selectedId = null;
  saveState();
  refresh();
});

// --- Init ---
setupSvg();
renderChecklist();
refresh();
