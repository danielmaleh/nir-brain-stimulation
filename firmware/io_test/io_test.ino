/**
 * @file io_test.ino
 * @brief Standalone Hardware I/O Diagnostic Test Suite for tPBM Device.
 *
 * This diagnostic sketch lets you test each hardware output individually over USB
 * serial to verify electrical connections: the TB6612 channels, status LEDs, and
 * the DS18B20 temperature sensor. This build has no physical buttons.
 *
 * Serial Command Protocol (115200 Baud):
 * - 'a' / 'A' : Toggle NIR channel  (TB6612 PWMA, Pin 9)
 * - 'b' / 'B' : Toggle Heater channel (TB6612 PWMB, Pin 10)
 * - 'y' / 'Y' : Toggle TB6612 STBY enable (Pin 12) - only if TB_STBY_CONTROL=1
 * - 'c' / 'C' : Toggle/Cycle Status LEDs (Pins 6, 7, 8, 13)
 * - 't' / 'T' : Scan 1-Wire Bus & Query DS18B20 Temp Sensor (Pin 2)
 * - 's' / 'S' : Toggle Continuous Streaming Mode (streams temperature at 10Hz)
 * - 'h' / '?' : Print Diagnostic Help Menu
 */

#include <OneWire.h>
#include <DallasTemperature.h>
#include "pins.h" // symlink -> ../main/pins.h (single source of truth; Arduino builds cannot reach outside the sketch folder)

// --- Global Variables ---
bool streamModeActive = false;
unsigned long lastStreamTime = 0;
const unsigned long STREAM_INTERVAL_MS = 100; // Stream at 10Hz

// Output states
bool nirLedState = false;
bool heaterState = false;
bool stbyState = true; // TB6612 enabled by default when Arduino-controlled
int activeLedIndex = -1; // -1: off, 0: heating, 1: 10hz, 2: 40hz, 3: error

// Temp Sensor
OneWire oneWire(PIN_TEMP_SENSOR);
DallasTemperature sensors(&oneWire);
DeviceAddress tempDeviceAddress;
bool sensorDetected = false;

// Function Declarations
void printHelpMenu();
void toggleNirLed();
void toggleHeater();
void toggleStandby();
void cycleStatusLeds();
void readTemperatureSensor(bool verbose = true);
void runStream();

void setup() {
  // Initialize output pins
  pinMode(PIN_NIR_LED, OUTPUT);
  pinMode(PIN_HEATER, OUTPUT);
#if TB_STBY_CONTROL
  pinMode(PIN_TB_STBY, OUTPUT);
#endif
  pinMode(PIN_LED_HEATING, OUTPUT);
  pinMode(PIN_LED_10HZ, OUTPUT);
  pinMode(PIN_LED_40HZ, OUTPUT);
  pinMode(PIN_LED_ERROR, OUTPUT);

  // Default channels LOW (off). Enable the TB6612 only if we control STBY.
  digitalWrite(PIN_NIR_LED, LOW);
  digitalWrite(PIN_HEATER, LOW);
#if TB_STBY_CONTROL
  digitalWrite(PIN_TB_STBY, HIGH);
#endif
  digitalWrite(PIN_LED_HEATING, LOW);
  digitalWrite(PIN_LED_10HZ, LOW);
  digitalWrite(PIN_LED_40HZ, LOW);
  digitalWrite(PIN_LED_ERROR, LOW);

  // Initialize Serial
  Serial.begin(115200);
  while (!Serial) {
    ; // Wait for serial
  }

  Serial.println(F("\n=================================================="));
  Serial.println(F("       NIR tPBM Hardware I/O Diagnostic Test       "));
  Serial.println(F("=================================================="));

  // Pin assignments printout for developer reference
  Serial.print(F("[INFO] Temp Sensor Pin:   ")); Serial.println(PIN_TEMP_SENSOR);
  Serial.print(F("[INFO] NIR PWMA Pin:      ")); Serial.println(PIN_NIR_LED);
  Serial.print(F("[INFO] Heater PWMB Pin:   ")); Serial.println(PIN_HEATER);
#if TB_STBY_CONTROL
  Serial.print(F("[INFO] TB6612 STBY Pin:   ")); Serial.println(PIN_TB_STBY);
#else
  Serial.println(F("[INFO] TB6612 STBY:       tied to 5V (not Arduino-controlled)"));
#endif
  Serial.print(F("[INFO] Heating LED Pin:   ")); Serial.println(PIN_LED_HEATING);
  Serial.print(F("[INFO] 10Hz LED Pin:      ")); Serial.println(PIN_LED_10HZ);
  Serial.print(F("[INFO] 40Hz LED Pin:      ")); Serial.println(PIN_LED_40HZ);
  Serial.print(F("[INFO] Error LED Pin:     ")); Serial.println(PIN_LED_ERROR);
  Serial.println(F("--------------------------------------------------"));

  // Scan Temp Sensor
  sensors.begin();
  int deviceCount = sensors.getDeviceCount();
  if (deviceCount == 0) {
    Serial.println(F("[WARN] DS18B20 Temperature Sensor: NOT DETECTED on Pin 2"));
    sensorDetected = false;
  } else {
    if (sensors.getAddress(tempDeviceAddress, 0)) {
      sensors.setResolution(tempDeviceAddress, 10);
      sensors.setWaitForConversion(false);
      sensors.requestTemperatures();
      sensorDetected = true;
      Serial.print(F("[INFO] DS18B20 Temp Sensor: DETECTED. Address: "));
      for (uint8_t i = 0; i < 8; i++) {
        if (tempDeviceAddress[i] < 16) Serial.print("0");
        Serial.print(tempDeviceAddress[i], HEX);
      }
      Serial.println();
    } else {
      Serial.println(F("[WARN] DS18B20 Sensor found but failed to read address."));
      sensorDetected = false;
    }
  }

  printHelpMenu();
}

void loop() {
  // Handle incoming Serial commands
  if (Serial.available() > 0) {
    char cmd = Serial.read();
    if (cmd == '\r' || cmd == '\n') return; // Skip line breaks

    switch (cmd) {
      case 'a':
      case 'A':
        toggleNirLed();
        break;
      case 'b':
      case 'B':
        toggleHeater();
        break;
      case 'y':
      case 'Y':
        toggleStandby();
        break;
      case 'c':
      case 'C':
        cycleStatusLeds();
        break;
      case 't':
      case 'T':
        readTemperatureSensor(true);
        break;
      case 's':
      case 'S':
        streamModeActive = !streamModeActive;
        Serial.print(F("STREAM_MODE,"));
        Serial.println(streamModeActive ? 1 : 0);
        break;
      case 'h':
      case '?':
        printHelpMenu();
        break;
      default:
        Serial.print(F("[ERROR] Unknown Command: '"));
        Serial.print(cmd);
        Serial.println(F("'. Press 'h' for list."));
        break;
    }
  }

  // Handle periodic streaming if active
  if (streamModeActive) {
    unsigned long currentMillis = millis();
    if (currentMillis - lastStreamTime >= STREAM_INTERVAL_MS) {
      lastStreamTime = currentMillis;
      runStream();
    }
  }
}

void printHelpMenu() {
  Serial.println(F("\n--- DIAGNOSTIC MENU ---"));
  Serial.println(F(" [A] Toggle NIR channel (PWMA, Pin 9)"));
  Serial.println(F(" [B] Toggle Heater channel (PWMB, Pin 10)"));
  Serial.println(F(" [Y] Toggle TB6612 STBY enable (Pin 12)"));
  Serial.println(F(" [C] Cycle Status LEDs (6, 7, 8, 13)"));
  Serial.println(F(" [T] Query Temperature Sensor (Pin 2)"));
  Serial.println(F(" [S] Toggle Continuous Temp Streaming (10Hz)"));
  Serial.println(F(" [H/?] Print this Menu"));
  Serial.println(F("-----------------------"));
}

void toggleNirLed() {
  nirLedState = !nirLedState;
  digitalWrite(PIN_NIR_LED, nirLedState ? HIGH : LOW);
  Serial.print(F("NIR_LED,"));
  Serial.println(nirLedState ? 1 : 0);
}

void toggleHeater() {
  heaterState = !heaterState;
  digitalWrite(PIN_HEATER, heaterState ? HIGH : LOW);
  Serial.print(F("HEATER,"));
  Serial.println(heaterState ? 1 : 0);
}

void toggleStandby() {
#if TB_STBY_CONTROL
  stbyState = !stbyState;
  digitalWrite(PIN_TB_STBY, stbyState ? HIGH : LOW);
  Serial.print(F("TB6612_STBY,"));
  Serial.println(stbyState ? 1 : 0);
  if (!stbyState) {
    Serial.println(F("[NOTE] Driver disabled: NIR/Heater outputs are now OFF regardless of PWM."));
  }
#else
  Serial.println(F("TB6612_STBY,NA"));
  Serial.println(F("[NOTE] STBY is tied to 5V on this build (always enabled). Nothing to toggle."));
#endif
}

void cycleStatusLeds() {
  activeLedIndex++;
  if (activeLedIndex > 4) activeLedIndex = -1;

  // Turn all off first
  digitalWrite(PIN_LED_HEATING, LOW);
  digitalWrite(PIN_LED_10HZ, LOW);
  digitalWrite(PIN_LED_40HZ, LOW);
  digitalWrite(PIN_LED_ERROR, LOW);

  // Turn on selected
  switch (activeLedIndex) {
    case 0:
      digitalWrite(PIN_LED_HEATING, HIGH);
      Serial.println(F("STATUS_LEDS,HEATING_ON"));
      break;
    case 1:
      digitalWrite(PIN_LED_10HZ, HIGH);
      Serial.println(F("STATUS_LEDS,10HZ_ON"));
      break;
    case 2:
      digitalWrite(PIN_LED_40HZ, HIGH);
      Serial.println(F("STATUS_LEDS,40HZ_ON"));
      break;
    case 3:
      digitalWrite(PIN_LED_ERROR, HIGH);
      Serial.println(F("STATUS_LEDS,ERROR_ON"));
      break;
    case 4:
      // Turn on all of them
      digitalWrite(PIN_LED_HEATING, HIGH);
      digitalWrite(PIN_LED_10HZ, HIGH);
      digitalWrite(PIN_LED_40HZ, HIGH);
      digitalWrite(PIN_LED_ERROR, HIGH);
      Serial.println(F("STATUS_LEDS,ALL_ON"));
      break;
    default:
      Serial.println(F("STATUS_LEDS,ALL_OFF"));
      break;
  }
}

void readTemperatureSensor(bool verbose) {
  if (!sensorDetected) {
    if (verbose) Serial.println(F("TEMP_READ,ERROR_NO_SENSOR"));
    return;
  }

  float tempC = sensors.getTempC(tempDeviceAddress);
  sensors.requestTemperatures(); // Trigger next conversion

  if (tempC == DEVICE_DISCONNECTED_C) {
    if (verbose) Serial.println(F("TEMP_READ,DISCONNECTED"));
  } else {
    if (verbose) {
      Serial.print(F("TEMP_READ,"));
      Serial.println(tempC, 2);
    }
  }
}

// Continuous temperature streaming logic
void runStream() {
  float tempC = -127.0;
  if (sensorDetected) {
    tempC = sensors.getTempC(tempDeviceAddress);
    sensors.requestTemperatures();
  }

  // Format: STREAM_DATA,TEMP_C
  Serial.print(F("STREAM_DATA,"));
  if (tempC == DEVICE_DISCONNECTED_C || !sensorDetected) {
    Serial.println(F("NaN"));
  } else {
    Serial.println(tempC, 2);
  }
}
