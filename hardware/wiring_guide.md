# Wiring and Hardware Connection Guide

This guide details the physical connection map for the **NIR Brain Stimulation (tPBM) Device**. It is based on the hardware pinouts defined in `firmware/main/pins.h` and the **TB6612FNG** dual driver used to switch the NIR LED strip and heater.

---

## 1. Quick Reference Pinout Table

| Arduino Pin | Connects To | I/O Type | Details |
| :--- | :--- | :--- | :--- |
| **GND** | Common Ground | Power | Tie Arduino GND, TB6612 GND, and 12V supply **(-)** together |
| **5V** | Logic power | Power | DS18B20 VCC + TB6612 **VCC** + AIN1/BIN1 straps |
| **Pin 2** | Temp Sensor (DS18B20) | Digital I/O | 1-Wire data. Needs a 4.7kΩ pull-up to 5V |
| **Pin 6** | Heating Mode LED | Digital Output | Via 220Ω resistor to LED anode |
| **Pin 7** | 10 Hz Mode LED | Digital Output | Via 220Ω resistor to LED anode |
| **Pin 8** | 40 Hz Mode LED | Digital Output | Via 220Ω resistor to LED anode |
| **Pin 9** | TB6612 **PWMA** | Digital Output | NIR channel on/off + pulse (Timer1-driven) |
| **Pin 10** | TB6612 **PWMB** | Digital Output | Heater channel on/off |
| **Pin 13** | Error Status LED | Digital Output | Via 220Ω resistor (or the on-board L LED) |

> The NIR strip is **channel A** (AO1/AO2), the heater is **channel B** (BO1/BO2).
> **No physical buttons** — the device is controlled entirely over USB (see §3).
> **TB6612 STBY** is tied to **5V** (always enabled), so no Arduino pin is used for it by default.

---

## 2. Component Detailed Wiring

### A. Temperature Sensor (DS18B20)
The DS18B20 uses a 1-Wire serial bus and requires a **4.7 kΩ pull-up resistor**.
*   **Sensor VCC (Red)** → Arduino **5V**
*   **Sensor GND (Black)** → Arduino **GND**
*   **Sensor DATA (Yellow/Blue)** → Arduino **Pin 2**
*   **Pull-up (4.7 kΩ)**: between **DATA (Pin 2)** and **5V**.
    *   *Without it the sensor reads as disconnected (`-127 °C`), and the firmware will latch a safety trip at startup.*

### B. TB6612FNG Dual Driver (NIR LED Strip + Heater)

The TB6612FNG switches the 12V loads from the 5V Arduino logic. Each channel has two direction inputs (`xIN1`/`xIN2`) and a PWM input. Because the LED strip and heater are **unidirectional** loads, we lock each channel "forward" by strapping `IN1` HIGH and `IN2` LOW, then use the **PWM pin as the on/off (and pulse) control**.

#### Power and enable
| TB6612 Pin | Connect To | Notes |
| :--- | :--- | :--- |
| **VM** | 12V supply **(+)** | Motor/load supply. 12V is within range (abs max ~15V) |
| **VCC** | Arduino **5V** | Logic supply |
| **GND** | Common ground | Arduino GND **and** 12V supply (-) |
| **STBY** | **5V** | Ties the driver permanently enabled (default). See note below |

> [!IMPORTANT]
> **Common ground is mandatory.** The 12V supply **(-)**, the TB6612 **GND**, and an Arduino **GND** pin must all be connected together, or the logic inputs have no reference and the channels will not switch.

> [!NOTE]
> **STBY (driver enable).** The TB6612 needs STBY HIGH or its outputs stay off. The simple default is to tie **STBY → 5V** (always enabled) — nothing for the firmware to manage. *Optional:* if you instead route **STBY → Pin 12** and set `TB_STBY_CONTROL 1` in `pins.h`, the firmware holds it HIGH and drops it LOW on a temperature trip for a redundant hardware kill. Pick **one** of these, never both.

#### Channel A — NIR LED Strip
*   **PWMA** → Arduino **Pin 9**
*   **AIN1** → **5V** (strap HIGH)
*   **AIN2** → **GND** (strap LOW)
*   **AO1** → NIR LED strip **(+)**
*   **AO2** → NIR LED strip **(-)**

#### Channel B — Heater Ring/Wire
*   **PWMB** → Arduino **Pin 10**
*   **BIN1** → **5V** (strap HIGH)
*   **BIN2** → **GND** (strap LOW)
*   **BO1** → Heater wire, one end
*   **BO2** → Heater wire, other end

> [!WARNING]
> **Current limit.** The TB6612FNG handles ~**1.2 A continuous / 3.2 A peak per channel**. A 95W/5m IR strip draws ~8 A if fully lit, so only a **short segment** (the ~4 cm² illumination patch) may be connected — confirm its draw stays under 1.2 A during calibration. The same limit applies to the heater element. For higher current, drive a logic-level MOSFET from the TB6612 output or switch to a dedicated high-current MOSFET module.

---

### C. Indicator Status LEDs
Use a **220Ω–330Ω** current-limiting resistor in series with each LED anode.
*   **Heating LED**: Pin 6 → 220Ω → LED anode → cathode → **GND**
*   **10 Hz LED**: Pin 7 → 220Ω → LED anode → cathode → **GND**
*   **40 Hz LED**: Pin 8 → 220Ω → LED anode → cathode → **GND**
*   **Error LED**: Pin 13 → 220Ω → LED anode → cathode → **GND** *(or use the built-in L LED on Pin 13).*

---

## 3. Bring-up & Validation Order

Flash and run each sketch in order before any participant session:

1. **`firmware/io_test/`** — verify wiring pin-by-pin over serial (115200 baud):
   * `A` / `B` — confirm the NIR strip and heater switch on/off (STBY is tied to 5V, so they're always enabled).
   * `T` — confirm the DS18B20 reports a sane temperature.
   * `C` — confirm all four indicator LEDs light.
2. **`firmware/safety_test/`** — confirm the 40 °C cutoff:
   * `H`/`L` toggle heater/LED, `S` simulates a 41.5 °C spike → all outputs must cut off (latched). `R` resets only when the real temperature is back under 40 °C.
3. **`firmware/main/`** — full experiment controller. Watch that pulse logs show a steady `PULSE,1`/`PULSE,0` cadence with no `PULSE_DROPPED` lines, and that `10 Hz`/`40 Hz` conditions measure correctly on a scope or photodiode.

Control is entirely over USB: the `APP/arduino.html` Web Serial dashboard (or the Arduino IDE Serial Monitor) sends the start/stop/mode commands — there are no physical buttons.

The `APP/arduino.html` Web Serial dashboard can be used in place of the serial monitor for steps 2–3 to visualize temperature, pulses, and safety state.
