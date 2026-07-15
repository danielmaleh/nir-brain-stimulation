# Testing & Validation — Plain-Language Guide

This project has two kinds of software that work **together**:

1. **Arduino sketches** (`firmware/.../*.ino`) — the program that runs *on the Arduino board*.
2. **Web pages** (`APP/*.html` + `*.js`) — control panels that run *in your Chrome browser* and talk to the Arduino through the USB cable.

You always do two steps: **(a)** upload one `.ino` to the board, then **(b)** open the matching web page (or the Arduino Serial Monitor) to control it. The web pages use "Web Serial," which **only works in Chrome or Edge**, and only while the USB cable is plugged in.

> There are **no physical buttons** on this build, so the browser (or Serial Monitor) is how you start and stop everything.

---

## The three Arduino sketches, and what each is for

Think of it as three programs you flash onto the same board depending on what you're doing:

| Sketch | Question it answers | When you use it |
| :--- | :--- | :--- |
| `firmware/io_test/` | "Is every wire connected correctly?" | Right after wiring, before anything else |
| `firmware/safety_test/` | "Does the 40 °C shut-off actually work?" | Before ever putting the device on a person |
| `firmware/main/` | *(not a test)* the real experiment controller | During actual sessions |

You flash **one at a time**. Uploading a new sketch replaces the previous one.

---

## Step 1 — `io_test`: check your wiring

**Goal:** confirm each pin does what it should, one at a time, so you catch a swapped or loose wire early.

1. In the Arduino IDE: open `firmware/io_test/io_test.ino`, pick your board and port, click **Upload**.
2. Open `APP/io_test.html` in Chrome → click **Connect** → choose the Arduino's port.
3. Now click the buttons on the page (each sends a one-letter command to the board):
   - **Toggle NIR (A)** — should switch the NIR LED strip on/off.
   - **Toggle Heater (B)** — should switch the heater on/off.
   - **Cycle Status LEDs (C)** — walks through the indicator LEDs so you can see each lights up.
   - **Read Temp (T)** — should show a believable room/skin temperature. If it says `NO SENSOR` / `DISCONNECTED`, your DS18B20 wiring or its 4.7 kΩ pull-up resistor is wrong.

If every one of those behaves as expected, your wiring is good.

> The TB6612 driver's `STBY` (enable) pin is tied to 5V, so it's always on — there's nothing to toggle. If the NIR/heater channels don't switch at all, check that `STBY` really is connected to 5V and that you have a common ground. (Only if you chose the optional Arduino-controlled `STBY` does the **Toggle STBY (Y)** button do anything.)

---

## Step 2 — `safety_test`: prove the temperature cut-off works

**Goal:** make sure that if skin temperature ever reaches 40 °C, the device kills all power and *stays* off until you deliberately reset it. This is the go/no-go gate before any human use.

1. Upload `firmware/safety_test/safety_test.ino`.
2. Open the Arduino IDE **Serial Monitor** (set to 115200 baud) — this sketch doesn't have its own web page, and typing single letters is all you need.
3. Type these one-letter commands and watch the response:
   - `H` — toggle the heater, `L` — toggle the NIR LED (confirm they switch).
   - `S` — **simulate** a temperature spike to 41.5 °C. The correct result: everything shuts off instantly, the error LED lights, STBY drops, and the system **latches** (won't turn anything back on).
   - `R` — try to reset. It should only succeed if the *real* measured temperature is below 40 °C.

If the `S` test latches everything off, the safety system works.

---

## Step 3 — `main`: run the real thing

**Goal:** the actual experiment controller (10 Hz / 40 Hz NIR and the heating control condition).

1. Upload `firmware/main/main.ino`.
2. Open `APP/arduino.html` in Chrome → **Connect**.
3. Because there are no buttons, you drive it from the page:
   - **Cycle Mode** — pick Heating / 10 Hz / 40 Hz.
   - **Start** — begins the 1-minute stimulation, then a 3-minute rest.
   - **Stop** — aborts.
   - **Reset Safety** — clears a temperature trip (only if it's cooled down).
4. The page shows live temperature, a safety status box, and pulse activity. Watch that the pulse log ticks steadily and that no `PULSE_DROPPED` messages appear.

> `APP/index.html` (the reaction-time task) is a **separate** program for the participant's behavioral test. It does not talk to the Arduino — it runs on its own in the browser.

---

## If the web page won't connect

- Use **Chrome or Edge** (Web Serial isn't in Safari/Firefox).
- Only **one** program can hold the serial port at a time — close the Arduino IDE Serial Monitor before clicking Connect in the browser, and vice-versa.
- If Upload fails with "port busy," disconnect the web page first.
- Re-plugging the USB cable clears most stuck-port problems.
