# ANC unit firmware (ESP-IDF v5.5)

Target: ESP32-S3-WROOM-1 **N16R8**. Wiring: see the pinout in the top-level README.

## Build and flash

Install ESP-IDF **v5.5.x** (the VS Code "ESP-IDF" extension is the easiest way
on Windows), then from this folder:

```bash
idf.py set-target esp32s3      # first time only
idf.py build
idf.py -p COM5 flash           # use your port: COMx on Windows, /dev/ttyACM0 on Linux
```

The DevKitC-1 has **two USB-C ports**:

| Port | Carries |
|---|---|
| **USB** (native) | recording protocol, used by `tools/record.py` |
| **UART** | log messages (`idf.py -p <port> monitor`) |

Flashing works through either one. Logs are kept off the native port on
purpose, so a log line can never corrupt the binary audio stream.

## Updating to a new firmware version

```bash
git pull
idf.py set-target esp32s3      # regenerates sdkconfig; needed when sdkconfig.defaults changed
idf.py build
idf.py -p <UART port> flash monitor
```

The monitor should print `ANC unit firmware 0.6.5`, a `canceller:` line and
a `denoiser:` line.

## Bring-up checklist (firmware 0.6)

The board runs the two-mic noise canceller and then the neural noise
suppressor (the AI), both on the chip itself: no internet is used. The board's own WiFi hotspot
only serves the phone dashboard; the audio never goes over it.
Speech for the canceller is still detected with a simple rule: "the mouth
mic is louder than the outward mic".

1. **Flash, then check the log on the UART port.** You should see
   `ANC unit firmware 0.6.5`, a `canceller:` line and a `denoiser:` line
   saying `internal RAM`, with no errors.
2. **Check mic levels.** Connect the native USB port and run:
   ```
   python tools/record.py levels --port <native USB port>
   ```
   - Both levels should be somewhere around -60 to -40 dBFS in a quiet room.
   - Talk into **mic 1**: `primary` should jump by 20 dB or more.
   - Talk into **mic 2**: `reference` should jump.
   - **-200** on a channel means all-zero data. Check SD / BCLK / WS wiring.
   - **Both mics move together** when you talk into one: both L/R pins are
     strapped the same way. Mic 1 L/R -> GND, mic 2 L/R -> 3V3.
3. **Listen through the speaker.** Put the speaker **at least 1 m** from the
   mics, pointing away, volume low. Press the **BOOT** button to step through:

   | Press | Speaker plays |
   |---|---|
   | (start) | nothing |
   | 1 | **raw**: mic 1 as it hears it |
   | 2 | **ai**: mic 1 after the canceller and the AI (what HQ would hear) |
   | 3 | **two-mic**: mic 1 after the canceller only |
   | 4 | **reference**: mic 2 (wiring check) |
   | 5 | **tone**: test notes, no mic (speaker check) |
   | 6 | nothing again |

   If it howls, the speaker is too close. Press until it is quiet.
   The volume is automatic (firmware 0.6.2): quiet sound is boosted up to
   +18 dB, loud sound (a voice right at mic 1, gunfire) is turned down so it
   never clips. Up to 0.6.1 a fixed +18 dB clipped 5-19% of the samples in
   the team's recordings, and the speaker sounded blurred.
4. **Before/after recording.** Play noise near the unit (fan, music, a
   video of engine noise) and talk into mic 1:
   ```
   python tools/record.py record --port <native USB port> --cleaned --seconds 30
   ```
   The WAV has the raw mic on the left and the final output (canceller +
   AI) on the right, 15 ms later (`cleaned_delay_samples` in the JSON).
   Listen to both sides and send the file for analysis.

`record.py levels` also shows what the canceller is doing: `speech=1` while
it thinks someone is talking, `ratio_db` (how much louder mic 1 is than
mic 2), `rollbacks`, `guard_trips`, and `proc_us_max`, the worst time the
canceller and the AI together took for a 10 ms block (it must stay well
under 10 000 us). `ai_gain` is how far the AI is turning the sound down
(1 = not at all); the info line also has `ai_us_max`, the AI's share of
the time.

## OLED screen (firmware 0.5)

Wire the 4-pin I2C OLED: **VCC -> 3V3, GND -> GND, SDA -> GPIO 8, SCL -> GPIO 9**.
If the display is not on GPIO 8/9 the firmware searches every free pin pair
for it (a few seconds, in the background) and logs where it found it, e.g.
`display found with SDA on GPIO9 and SCL on GPIO14`. It shows what the speaker plays, the noisy input level, the cleaned output
level, how many dB are being removed, and whether the AI hears voice. The UART
log says `oled: display found at 0x3C` at start-up, or `no display ...` (the
firmware runs the same without one). A 0.96" SSD1306 module works too; set
`OLED_COLUMN_OFFSET` to 0 in `main/board.h` if the picture sits 2 pixels right.

## Phone dashboard (firmware 0.6)

The board opens its own WiFi hotspot; no router or internet is needed.

1. On the phone, join WiFi **HERTZ-HUNTERS-ANC**, password **hertz1234**.
   If the phone warns "no internet", choose to stay connected.
2. Open **http://192.168.4.1** in the browser.

The page updates 4 times a second and shows how many dB of noise are removed
between words, the noisy input and clean output levels, a 60-second chart,
and buttons for what the speaker plays (raw mic / AI clean / 2-mic only /
mute). The footer shows the firmware version, the delay and how many audio
blocks the AI dropped (should stay 0). Up to 4 phones can watch at once.
The UART log says `dashboard: WiFi "HERTZ-HUNTERS-ANC" ...` at start-up.

**Speaker check (firmware 0.6.3):** the **Test tone** button (also the last
BOOT-button step) plays clean notes straight to the amp, with no mic
involved. If the notes sound blurred or buzzy too, look at the amp, speaker,
wiring or 5 V supply, not the audio processing. The footer also counts
**speaker gaps** (the amp ran out of sound: clicks) and **mic gaps** (mic
sound lost); both should stay 0.

**Volume (firmware 0.6.5):** the − / + buttons set the speaker volume in
6 dB steps (1-5, starts at 2). On the team's board the test tone is clean
at 1 and 2 and blurred from 3 up: the small speaker rattles when driven
harder. A bigger speaker is needed for more volume. If the page says **Mics silent**, the
mics send exact zeros: a mic wire is loose or the mics have no power.
WiFi runs on core 1 next to the audio, never on core 0 with the AI (in 0.6.0
it did, and the AI dropped blocks). An `sdkconfig` made before 0.6.1 still
has the old setting and the build stops with a message: run
`idf.py set-target esp32s3`, then build again.

## Updating the AI

The AI's weights are `main/denoiser.bin`, made from a trained model by

```
python tools/export_denoiser.py runs/denoiser/denoiser.pt
```

then rebuild and flash as above. Training happens once, on a laptop
(`tools/train_denoiser.py`); the board only runs the result.

## Collecting training data

Everything goes into `data/raw/` as a 24-bit stereo WAV plus a `.json` file
with the labels. `data/` is git-ignored: share it through a drive link.

```bash
# Impulsive sounds: hammering, door slams, crackers. 2-3 minutes each.
python tools/record.py record --port <port> --label impulsive --notes "hammer on steel, 2 m"

# Team voices: each person reads anything aloud for 2-3 minutes.
python tools/record.py record --port <port> --label speech --notes "Vishnu, 20 cm from mic 1"

# Voice over noise: talk while someone hammers.
python tools/record.py record --port <port> --label impulsive speech

# Room tone: nobody talks, nothing running.
python tools/record.py record --port <port> --label silence --seconds 60
```

`--label` takes every label that is **audible** in the recording. Getting this
right matters more than recording lots of data.

The speaker is always switched off while recording, so it cannot leak into
the training data.

## Re-recording synthetic noise

Engines, vehicles and wind come from the synthetic generator, played through a
speaker and recorded by the unit so every class goes through the same mics.

```bash
python tools/make_playback_set.py          # 21 files, ~21 min, into data/playback/
# then, for each file:
python tools/record.py record --port <port> --play data/playback/engine_hum_00.wav
```

Labels come from each file's `.json`, so there is nothing to type.
`record.py --play` needs `pip install sounddevice`.

**Use the biggest speaker you can find:** a Bluetooth party speaker, or PC
speakers with a subwoofer. Laptop speakers (and the small MAX98357A speaker)
reproduce almost nothing below ~150-200 Hz, and that is where most engine
energy is. Re-recorded through a laptop, the engines lose their bass and
stop sounding like engines to the model.

Setup: speaker about 1-2 m from the unit, volume at a level that would
make you raise your voice to talk over it. Keep the same setup for all
files, and write it in `--notes` once.
