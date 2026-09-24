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

## v0 bring-up checklist

Firmware v0 has no noise cancellation. It exists to prove the wiring and to
start collecting training data.

1. **Flash, then check the log on the UART port.** You should see
   `ANC unit firmware 0.1.0` and no errors.
2. **Check mic levels.** Connect the native USB port and run:
   ```
   python tools/record.py levels --port <native USB port>
   ```
   - Both levels should be somewhere around −60 to −40 dBFS in a quiet room.
   - Talk into **mic 1**: `primary` should jump by 20 dB or more.
   - Talk into **mic 2**: `reference` should jump.
   - **−200** on a channel means all-zero data. Check SD / BCLK / WS wiring.
   - **Both mics move together** when you talk into one: both L/R pins are
     strapped the same way. Mic 1 L/R → GND, mic 2 L/R → 3V3.
3. **Listen through the speaker.** Put the speaker **at least 1 m** from the
   mics, pointing away, volume low. Press the button:
   `mute → primary → reference → mute`. Each press should switch mic.
   If it howls, the speaker is too close. Press again to mute.
4. **Record.** See "Collecting training data" below.

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
