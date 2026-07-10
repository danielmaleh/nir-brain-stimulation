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
// TOPOLOGY: logic-level N-channel MOSFET low-side switch per channel. The load's
// + goes straight to its supply +, the load's − goes to the MOSFET output (drain),
// the MOSFET GND (source) ties to the common ground, and the Arduino pin drives the
// gate (SIG). NIR runs at 24 V; the heater on its own (confirm-rated) rail.
const CONNECTIONS = [
  // --- 1. Power & ground (multimeter, everything POWERED OFF) ---
  {
    id: 'gnd-arduino', net: 'gnd-arduino', group: '1 · Power & ground — power OFF, continuity mode',
    label: 'Arduino GND → common ground bus', pins: 'GND → bus',
    how: 'Continuity between an Arduino <code>GND</code> pin and the common ground rail. Everything below must share this one node — it is the #1 wiring mistake to skip a ground.'
  },
  {
    id: 'gnd-24v', net: 'gnd-24v', group: '1 · Power & ground — power OFF, continuity mode',
    label: '24 V supply (−) → common ground', pins: '24V− → bus',
    how: 'Continuity from the 24 V adapter\'s <code>−</code> lead to the common ground. Without it the NIR MOSFET has no return path and the strip never switches.'
  },
  {
    id: 'gnd-12v', net: 'gnd-12v', group: '1 · Power & ground — power OFF, continuity mode',
    label: '12 V supply (−) → common ground', pins: '12V− → bus',
    how: 'Continuity from the heater supply\'s <code>−</code> lead to the common ground. Both supplies and the Arduino share one ground.'
  },
  {
    id: 'gnd-nir-mos', net: 'gnd-nir-mos', group: '1 · Power & ground — power OFF, continuity mode',
    label: 'NIR MOSFET GND → common ground', pins: 'GND → bus',
    how: 'Continuity from the NIR MOSFET module\'s <code>GND</code> (source) terminal to the common ground.'
  },
  {
    id: 'gnd-htr-mos', net: 'gnd-htr-mos', group: '1 · Power & ground — power OFF, continuity mode',
    label: 'Heater MOSFET GND → common ground', pins: 'GND → bus',
    how: 'Continuity from the heater MOSFET module\'s <code>GND</code> (source) terminal to the common ground.'
  },
  {
    id: 'nir-pos', net: 'nir-pos', group: '1 · Power & ground — power OFF, continuity mode',
    label: '24 V (+) → NIR strip (+)', pins: '24V+ → strip+',
    how: 'Continuity from the 24 V adapter\'s <code>+</code> to the strip\'s <code>+</code> pad. Feed ONE end of the segment; leave the far-end pads open. Confirm NO continuity between 24V + and −.'
  },
  {
    id: 'nir-neg', net: 'nir-neg', group: '1 · Power & ground — power OFF, continuity mode',
    label: 'NIR strip (−) → NIR MOSFET output', pins: 'strip− → OUT',
    how: 'Continuity from the strip\'s <code>−</code> pad to the NIR MOSFET\'s output/drain terminal. LEDs are polarized — if + and − are swapped the strip never lights.'
  },
  {
    id: 'htr-pos', net: 'htr-pos', group: '1 · Power & ground — power OFF, continuity mode',
    label: 'Heater supply (+) → heater, end 1', pins: 'V+ → heater',
    how: 'Continuity from the heater supply\'s <code>+</code> to one heater lead. <strong>Confirm the heater\'s rated voltage first</strong> — a 12 V heater on 24 V burns 4× the power (over-temp/burn risk).'
  },
  {
    id: 'htr-neg', net: 'htr-neg', group: '1 · Power & ground — power OFF, continuity mode',
    label: 'Heater, end 2 → heater MOSFET output', pins: 'heater → OUT',
    how: 'Continuity from the other heater lead to the heater MOSFET\'s output/drain. Across the two heater leads you should also read the element\'s resistance (a few Ω to tens of Ω, not 0 and not ∞).'
  },

  // --- 2. Control signals ---
  {
    id: 'nir-sig', net: 'nir-sig', group: '2 · Control signals — power OFF, continuity mode',
    label: 'Arduino D9 → NIR MOSFET SIG (gate)', pins: 'D9 → SIG',
    how: 'Continuity from Arduino <code>D9</code> to the NIR MOSFET\'s signal/gate input. D9 is deliberate: it is a Timer1 pin, giving jitter-free 10/40 Hz pulses. A logic-level module has the gate resistor + pulldown built in.'
  },
  {
    id: 'htr-sig', net: 'htr-sig', group: '2 · Control signals — power OFF, continuity mode',
    label: 'Arduino D10 → heater MOSFET SIG (gate)', pins: 'D10 → SIG',
    how: 'Continuity from Arduino <code>D10</code> to the heater MOSFET\'s signal/gate input.'
  },

  // --- 3. Temperature sensor ---
  {
    id: 'ds-vcc', net: 'ds-vcc', group: '3 · DS18B20 temperature sensor — power OFF',
    label: 'DS18B20 VCC (red) → 5V', pins: 'VCC → 5V',
    how: 'Continuity from the sensor\'s red lead to Arduino <code>5V</code>.'
  },
  {
    id: 'ds-gnd', net: 'ds-gnd', group: '3 · DS18B20 temperature sensor — power OFF',
    label: 'DS18B20 GND (black) → common ground', pins: 'GND → bus',
    how: 'Continuity from the sensor\'s black lead to the common ground.'
  },
  {
    id: 'ds-data', net: 'ds-data', group: '3 · DS18B20 temperature sensor — power OFF',
    label: 'DS18B20 DATA → Arduino D2', pins: 'DATA → D2',
    how: 'Continuity from the sensor\'s data lead (yellow/blue) to Arduino <code>D2</code>.'
  },
  {
    id: 'ds-pullup', net: 'ds-pullup', group: '3 · DS18B20 temperature sensor — power OFF',
    label: '4.7 kΩ pull-up between DATA and 5V', pins: 'D2 ─4.7k─ 5V',
    how: 'Resistance mode between <code>D2</code> and <code>5V</code>: expect ≈ 4.7 kΩ. Missing pull-up = sensor reads −127 °C / <code>NOT DETECTED</code>, and main firmware latches a safety trip at boot. <strong>This is currently the failing check — io_test reports the sensor NOT DETECTED.</strong>'
  },

  // --- 4. Indicator LEDs ---
  {
    id: 'led-heating', net: 'led-heating', group: '4 · Indicator LEDs — power OFF',
    label: 'Heating mode LED chain (D6)', pins: 'D6 → 220Ω → LED → GND',
    how: 'Check the chain order: <code>D6</code> → 220 Ω resistor → LED anode (long leg) → cathode → common ground. Diode-test mode across the LED should light it faintly one way only.'
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
    id: 'chk-24v', net: 'nir-pos', group: '5 · First power-on — multimeter, voltage mode',
    label: '24 V rail present at NIR strip (+)', pins: '≈ 24 V',
    how: 'USB connected and both adapters plugged in. Measure the strip <code>+</code> to common ground: expect ≈ 24 V. Nothing should get warm; if anything does, power off immediately.'
  },
  {
    id: 'chk-12v', net: 'htr-pos', group: '5 · First power-on — multimeter, voltage mode',
    label: 'Heater rail present at heater (+)', pins: '≈ 12 V',
    how: 'Measure the heater supply <code>+</code> to common ground: expect the heater\'s rated voltage (≈ 12 V). Confirm it matches the heater element before running current through it.'
  },
  {
    id: 'chk-5v', net: 'ds-vcc', group: '5 · First power-on — multimeter, voltage mode',
    label: '5 V logic rail present', pins: '≈ 5 V',
    how: 'Measure Arduino <code>5V</code> (or DS18B20 VCC) to common ground: expect 4.75–5.25 V. This powers the Arduino and sensor; the MOSFET modules are switched by the gate signal, not this rail.'
  },

  // --- 6. Functional checks with io_test ---
  {
    id: 'fn-temp', net: 'ds-data', group: '6 · Functional — flash firmware/io_test, open io_test.html',
    label: 'T — sensor reports sane temperature', pins: "cmd 'T'",
    how: 'Send <code>T</code>. Expect a believable room/skin temperature (18–35 °C). <code>ERROR_NO_SENSOR</code> means the DS18B20 wiring or the 4.7 kΩ pull-up (group 3) is wrong.'
  },
  {
    id: 'fn-nir', net: 'nir-neg', group: '6 · Functional — flash firmware/io_test, open io_test.html',
    label: 'A — NIR strip switches on/off', pins: "cmd 'A'",
    how: 'Send <code>A</code> to toggle the NIR channel (D9 drives the MOSFET gate). 850 nm is nearly invisible — <strong>view the strip through your phone camera</strong>, where it appears bright purple-white. At 24 V it now runs at full rated brightness. Toggle off again.'
  },
  {
    id: 'fn-heater', net: 'htr-neg', group: '6 · Functional — flash firmware/io_test, open io_test.html',
    label: 'B — heater warms up', pins: "cmd 'B'",
    how: 'Send <code>B</code> (D10 drives the heater MOSFET); within ~10 s the heater should feel warm (hover a finger nearby, don\'t press on it). Send <code>B</code> again to switch it off — never leave it running unattended.'
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
