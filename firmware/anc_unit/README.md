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

The monitor should print `ANC unit firmware 0.2.0` and a `canceller:` line.

## Bring-up checklist (firmware 0.2)

The board runs the two-mic noise canceller. Until the trained model is on
the device (firmware v2), speech is detected with a simple rule: "the mouth
mic is louder than the outward mic".

1. **Flash, then check the log on the UART port.** You should see
   `ANC unit firmware 0.2.0` and a `canceller:` line, with no errors.
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
   | 2 | **cleaned**: mic 1 after the canceller |
   | 3 | **reference**: mic 2 (wiring check) |
   | 4 | nothing again |

   If it howls, the speaker is too close. Press until it is quiet.
4. **Before/after recording.** Play noise near the unit (fan, music, a
   video of engine noise) and talk into mic 1:
   ```
   python tools/record.py record --port <native USB port> --cleaned --seconds 30
   ```
   The WAV has the raw mic on the left and the cleaned output on the right.
   Listen to both sides and send the file for analysis.

`record.py levels` also shows what the canceller is doing: `speech=1` while
it thinks someone is talking, `ratio_db` (how much louder mic 1 is than
mic 2), `rollbacks`, `guard_trips`, and `proc_us_max`, the worst time the
canceller took for a 10 ms block (it must stay well under 10 000 us).

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
