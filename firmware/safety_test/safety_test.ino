/**
 * @file safety_test.ino
 * @brief Standalone safety and temperature cutoff test for the NIR tPBM Device.
 * 
 * This sketch verifies that the temperature sensor (DS18B20) reads accurately,
 * logs data correctly, and successfully cuts off power to the heating element
 * and NIR LEDs if the skin contact temperature exceeds the safety threshold of 40.0 °C.
 * 
 * Features:
 * - Real-time temperature monitoring using DallasTemperature library.
 * - Actuator control for both heater and NIR LED strip.
 * - High-frequency safety loop (200ms polling interval).
 * - Permanent latching safety shutdown when temperature exceeds 40.0 °C.
 * - Serial interface to toggle components and simulate over-temperature events.
 * 
 * Safety Limits:
 * - MAX_SAFE_TEMP: 40.0 °C (Non-negotiable cutoff).
 */

#include <OneWire.h>
#include <DallasTemperature.h>
#include "pins.h" // symlink -> ../main/pins.h (single source of truth; Arduino builds cannot reach outside the sketch folder)

// --- Constants & Thresholds ---
const float MAX_SAFE_TEMP = 40.0;     // Temperature cutoff threshold in Celsius
const unsigned long POLL_INTERVAL = 200; // Poll temperature every 200ms

// --- Globals ---
OneWire oneWire(PIN_TEMP_SENSOR);
DallasTemperature sensors(&oneWire);
DeviceAddress tempDeviceAddress;

float currentTemp = 0.0;
bool safetyTripped = false;
bool heaterState = false;
bool ledState = false;
unsigned long lastPollTime = 0;

// --- Function Declarations ---
void checkSafety();
void handleSerialCommands();
void updateActuators();
void printStatus();
void triggerSafetyShutdown(const char* reason);
void flashErrorLED();

void setup() {
  // Initialize pins
  pinMode(PIN_NIR_LED, OUTPUT);
  pinMode(PIN_HEATER, OUTPUT);
#if TB_STBY_CONTROL
  pinMode(PIN_TB_STBY, OUTPUT);
#endif
  pinMode(PIN_LED_HEATING, OUTPUT);
  pinMode(PIN_LED_10HZ, OUTPUT);
  pinMode(PIN_LED_40HZ, OUTPUT);
  pinMode(PIN_LED_ERROR, OUTPUT);

  // Ensure actuators are OFF initially. If we control STBY, enable the driver;
  // otherwise STBY is tied to 5V on the board and is always enabled.
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
    ; // Wait for serial port to connect (needed for Leonardo/Mega native USB)
  }

  Serial.println(F("=================================================="));
  Serial.println(F("NIR Brain Stimulation Project - Safety Test Sketch"));
  Serial.println(F("=================================================="));
  Serial.print(F("Initializing DS18B20 temperature sensor..."));

  sensors.begin();
  int deviceCount = sensors.getDeviceCount();
  Serial.print(deviceCount);
  Serial.println(F(" sensor(s) found on 1-wire bus."));

  if (deviceCount == 0) {
    Serial.println(F("ERROR: No temperature sensor detected!"));
    Serial.println(F("System locked. Check connections and 4.7k pull-up resistor."));
    triggerSafetyShutdown("No temperature sensor detected during initialization.");
  } else {
    if (!sensors.getAddress(tempDeviceAddress, 0)) {
      Serial.println(F("ERROR: Could not obtain sensor address."));
      triggerSafetyShutdown("Failed to get sensor address.");
    } else {
      // Set resolution to 10-bit (0.25 °C precision, ~187.5ms conversion time)
      // This is a good balance between speed and precision for a 200ms loop
      sensors.setResolution(tempDeviceAddress, 10);
      sensors.setWaitForConversion(false); // Enable non-blocking reading
      sensors.requestTemperatures();       // Request first reading
      Serial.println(F("Sensor initialized successfully."));
      Serial.println(F("Starting safety monitoring loop..."));
      Serial.println(F("--------------------------------------------------"));
      Serial.println(F("Serial commands:"));
      Serial.println(F("  'H' -> Toggle Heater ON/OFF"));
      Serial.println(F("  'L' -> Toggle NIR LED ON/OFF"));
      Serial.println(F("  'S' -> Simulate over-temperature event (41.5 C)"));
      Serial.println(F("  'R' -> Reset safety trip (only if temperature < 40 C)"));
      Serial.println(F("--------------------------------------------------"));
      Serial.println(F("TIMESTAMP_MS,TEMP_C,HEATER_ON,LED_ON,STATUS"));
    }
  }
}

void loop() {
  unsigned long currentTime = millis();

  // Read temperature periodically (non-blocking)
  if (currentTime - lastPollTime >= POLL_INTERVAL) {
    lastPollTime = currentTime;

    if (!safetyTripped) {
      // Read the conversion result from the previous request
      float newTemp = sensors.getTempC(tempDeviceAddress);
      
      // Request next conversion asynchronously
      sensors.requestTemperatures();

      if (newTemp == DEVICE_DISCONNECTED_C) {
        triggerSafetyShutdown("Sensor disconnected during operation.");
      } else {
        currentTemp = newTemp;
        checkSafety();
      }
    }
    
    printStatus();
  }

  // Handle command interface
  handleSerialCommands();

  // If safety is tripped, flash the error LED rapidly
  if (safetyTripped) {
    flashErrorLED();
  }
}

/**
 * @brief Checks if the current temperature exceeds safety limits.
 */
void checkSafety() {
  if (currentTemp >= MAX_SAFE_TEMP) {
    char reasonBuf[64];
    snprintf(reasonBuf, sizeof(reasonBuf), "Temperature reached %s C, exceeding threshold of %s C", 
             String(currentTemp, 2).c_str(), String(MAX_SAFE_TEMP, 2).c_str());
    triggerSafetyShutdown(reasonBuf);
  }
}

/**
 * @brief Shuts down all outputs and locks the system in a safe state.
 */
void triggerSafetyShutdown(const char* reason) {
  safetyTripped = true;
  heaterState = false;
  ledState = false;

  // Force pin outputs LOW instantly. If we control STBY, also disable the driver
  // entirely (LOW) as an independent hardware kill.
  digitalWrite(PIN_HEATER, LOW);
  digitalWrite(PIN_NIR_LED, LOW);
#if TB_STBY_CONTROL
  digitalWrite(PIN_TB_STBY, LOW);
#endif
  digitalWrite(PIN_LED_HEATING, LOW);
  digitalWrite(PIN_LED_10HZ, LOW);
  digitalWrite(PIN_LED_40HZ, LOW);
  
  // Turn on Error LED
  digitalWrite(PIN_LED_ERROR, HIGH);

  Serial.println();
  Serial.println(F("CRITICAL SAFETY TRIP INTERRUPT!"));
  Serial.print(F("Reason: "));
  Serial.println(reason);
  Serial.println(F("All actuators disabled. System locked."));
  Serial.println();
}

/**
 * @brief Updates the physical pins based on target states, unless safety is tripped.
 */
void updateActuators() {
  if (safetyTripped) {
    digitalWrite(PIN_HEATER, LOW);
    digitalWrite(PIN_NIR_LED, LOW);
  } else {
    digitalWrite(PIN_HEATER, heaterState ? HIGH : LOW);
    digitalWrite(PIN_NIR_LED, ledState ? HIGH : LOW);
  }
}

/**
 * @brief Prints CSV format status line to Serial.
 */
void printStatus() {
  Serial.print(millis());
  Serial.print(F(","));
  
  if (safetyTripped) {
    Serial.print(currentTemp); // Might be simulated or last known
    Serial.print(F(",0,0,TRIPPED_LOCKED"));
  } else {
    Serial.print(currentTemp, 2);
    Serial.print(F(","));
    Serial.print(heaterState ? 1 : 0);
    Serial.print(F(","));
    Serial.print(ledState ? 1 : 0);
    Serial.print(F(",OK"));
  }
  Serial.println();
}

/**
 * @brief Process commands sent from the Serial Monitor.
 */
void handleSerialCommands() {
  if (Serial.available() > 0) {
    char cmd = Serial.read();
    
    // Ignore line endings
    if (cmd == '\r' || cmd == '\n') return;
    
    switch (cmd) {
      case 'H':
      case 'h':
        if (!safetyTripped) {
          heaterState = !heaterState;
          updateActuators();
          Serial.print(F("# Heater toggled to: "));
          Serial.println(heaterState ? F("ON") : F("OFF"));
        } else {
          Serial.println(F("# ERROR: Cannot toggle heater. Safety is tripped."));
        }
        break;
        
      case 'L':
      case 'l':
        if (!safetyTripped) {
          ledState = !ledState;
          updateActuators();
          Serial.print(F("# LED toggled to: "));
          Serial.println(ledState ? F("ON") : F("OFF"));
        } else {
          Serial.println(F("# ERROR: Cannot toggle LEDs. Safety is tripped."));
        }
        break;
        
      case 'S':
      case 's':
        if (!safetyTripped) {
          Serial.println(F("# Simulating high temperature spike (41.5 C)..."));
          currentTemp = 41.5;
          checkSafety();
        } else {
          Serial.println(F("# ERROR: Safety is already tripped."));
        }
        break;
        
      case 'R':
      case 'r':
        if (safetyTripped) {
          // Re-measure real temperature first
          sensors.requestTemperatures();
          delay(200); // Small blocking delay just for manual reset check
          float checkTemp = sensors.getTempC(tempDeviceAddress);
          
          if (checkTemp != DEVICE_DISCONNECTED_C && checkTemp < MAX_SAFE_TEMP) {
            safetyTripped = false;
            currentTemp = checkTemp;
#if TB_STBY_CONTROL
            digitalWrite(PIN_TB_STBY, HIGH); // re-enable the driver
#endif
            digitalWrite(PIN_LED_ERROR, LOW);
            Serial.println(F("# Safety reset successful. Re-entering normal monitoring mode."));
          } else {
            Serial.print(F("# ERROR: Cannot reset. Current temperature ("));
            Serial.print(checkTemp);
            Serial.print(F(" C) is still above safe limit ("));
            Serial.print(MAX_SAFE_TEMP);
            Serial.println(F(" C) or sensor is disconnected."));
          }
        } else {
          Serial.println(F("# System is already in normal state (not tripped)."));
        }
        break;
        
      default:
        Serial.print(F("# Unknown command: "));
        Serial.println(cmd);
        break;
    }
  }
}

/**
 * @brief Rapidly flashes the error LED to provide a visual warning.
 */
void flashErrorLED() {
  static unsigned long lastFlashTime = 0;
  static bool flashState = false;
  unsigned long now = millis();
  
  if (now - lastFlashTime >= 100) { // 10Hz flash
    lastFlashTime = now;
    flashState = !flashState;
    digitalWrite(PIN_LED_ERROR, flashState ? HIGH : LOW);
  }
}
