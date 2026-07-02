#ifndef PINS_H
#define PINS_H

// ============================================================================
//  NIR tPBM Device - Central Pin Map (single source of truth)
//  safety_test/ and io_test/ include THIS file via a relative path so the pin
//  assignments can never diverge between sketches.
// ============================================================================

// Temperature Sensor (DS18B20)
// Uses 1-Wire protocol. Requires a 4.7k Ohm pull-up resistor between VCC and Data.
#define PIN_TEMP_SENSOR 2

// --- TB6612FNG dual driver control ------------------------------------------
// The NIR LED strip is driven by channel A, the heater ring by channel B.
// PWMA / PWMB are the on/off (and pulse) inputs and are toggled directly.
// AIN1 / BIN1 must be strapped HIGH (5V) and AIN2 / BIN2 strapped LOW (GND) so
// each channel runs "forward" whenever its PWM line is HIGH. See wiring_guide.md.
//
// D9 is intentionally the NIR pin: it is an Arduino Timer1 output pin, and the
// firmware uses a Timer1 compare interrupt to generate a jitter-free pulse train.
#define PIN_NIR_LED 9    // -> TB6612 PWMA  (NIR LED strip, pulsed at 10/40 Hz)
#define PIN_HEATER  10   // -> TB6612 PWMB  (heater ring, thermostat-controlled)

// TB6612 STBY (standby / enable). The chip needs STBY HIGH or its outputs stay
// off entirely. The SIMPLEST wiring -- and the default here -- is to tie STBY
// straight to 5V so the driver is always enabled; then there is no "driver
// enable" for the firmware to manage and TB_STBY_CONTROL stays 0.
//
// Set TB_STBY_CONTROL to 1 ONLY if you route STBY to PIN_TB_STBY instead. The
// firmware then holds it HIGH normally and drops it LOW on a safety trip -- a
// second, independent power-cut path. This is redundancy only: the 40 C cutoff
// already de-energises the loads by driving the PWM pins (D9/D10) LOW.
#define TB_STBY_CONTROL 0   // 0 = STBY tied to 5V (default); 1 = Arduino-controlled on PIN_TB_STBY
#define PIN_TB_STBY 12

// NOTE: This build has no physical buttons. The device is controlled entirely
// over USB serial (see main.ino command list). Pins D4/D5 are free.

// Status LEDs for mode indication (Blinding constraint: MUST be off during active stimulation!)
#define PIN_LED_HEATING 6
#define PIN_LED_10HZ 7
#define PIN_LED_40HZ 8
// System error indicator LED (lights up if temperature cutoff is triggered)
#define PIN_LED_ERROR 13

#endif // PINS_H
