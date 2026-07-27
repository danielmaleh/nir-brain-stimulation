/**
 * @file onewire_scan.ino
 * @brief Throwaway 1-Wire bus diagnostic for the DS18B20 on D2.
 *
 * Reports the presence pulse and enumerates any device ROMs, to tell apart:
 *   - presence=0, no devices  -> bus electrically dead (no pull-up / wrong pin /
 *     no power / data not connected)
 *   - a ROM with family 0x28 + CRC OK -> a healthy DS18B20 is present
 * Not part of the experiment firmware; reflash firmware/main afterwards.
 */
#include <OneWire.h>

OneWire ow(2); // DS18B20 data on D2, same as PIN_TEMP_SENSOR in the main firmware

void setup() {
  Serial.begin(115200);
  while (!Serial) { ; }
  Serial.println(F("=== 1-Wire bus scan on D2 (needs 4.7k data->VCC pull-up) ==="));
}

void loop() {
  uint8_t present = ow.reset(); // 1 if a device asserted the presence pulse
  Serial.print(F("presence pulse: "));
  Serial.println(present ? F("YES (a device pulled the line)") : F("NO (bus idle/dead)"));

  uint8_t addr[8];
  ow.reset_search();
  int found = 0;
  while (ow.search(addr)) {
    found++;
    Serial.print(F("  device ROM:"));
    for (uint8_t i = 0; i < 8; i++) {
      Serial.print(' ');
      if (addr[i] < 16) Serial.print('0');
      Serial.print(addr[i], HEX);
    }
    bool crcOk = (OneWire::crc8(addr, 7) == addr[7]);
    Serial.print(F("  CRC "));
    Serial.print(crcOk ? F("OK") : F("BAD"));
    Serial.print(F("  family 0x"));
    Serial.print(addr[0], HEX);
    Serial.println(addr[0] == 0x28 ? F(" (DS18B20)") : F(" (not a DS18B20)"));
  }
  if (found == 0) Serial.println(F("  search() found no devices"));
  Serial.println(F("---"));
  delay(1000);
}
