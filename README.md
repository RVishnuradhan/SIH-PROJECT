# Hertz Hunters: AI-steered noise cancellation for defence voice links

SIH 2026 · Problem Statement 26052 · Hardware category

A soldier speaks in a noisy environment (engines, vehicles, wind, gunfire).
The unit removes the noise **before transmitting**, so HQ hears only the
soldier's voice.

## How it works

```
Mic 1 PRIMARY   (near mouth)   -> speech + noise  -+
                                                   +-> NLMS canceller -> clean speech -> link / speaker
Mic 2 REFERENCE (facing away)  -> noise only      -+        ^
                                                            | tunes step size, filter length,
                         noise classifier (4x per second) --+ freezes adaptation on impulses
```

- **Two-mic NLMS adaptive noise canceller** (Widrow-style). Mic 2 hears the
  noise and the filter learns how that noise reaches Mic 1, then subtracts it.
- **Classifier** decides what kind of noise is present and retunes the canceller:

| Classifier says | Canceller does |
|---|---|
| Stationary (steady engine, fan) | small step size, long filter |
| Non-stationary (revving, pass-by, wind) | larger step size, track changes |
| Impulsive (gunfire, blasts) | freeze adaptation, protect the filter |
| Speech present | never adapt on the soldier's own voice |

Noise types are **multi-label**: "mixed" noise means several are on at once.
Speech is a separate output, because speech occurs alongside every noise type.

### Why the classifier is not in the audio path

The canceller runs on every sample. The classifier looks at 265 ms of audio and
runs 4 times a second. Noise *type* changes over seconds, so the classifier
only needs to retune the filter, not process audio. If the classifier is slow
or wrong, the canceller keeps running on its last settings. The audio never
drops out.

## Hardware

| Part | Choice |
|---|---|
| MCU | ESP32-S3-WROOM-1 **N16R8** (16 MB flash, 8 MB octal PSRAM) |
| Mics | 2x INMP441 on one I2S bus, primary = L, reference = R (sample-locked) |
| Output | MAX98357A I2S amp + speaker (demo stand-in for the HQ receiver) |
| Display | SSD1306 128x64 OLED + dashboard on the board's own WiFi hotspot |
| Power | USB power bank |

### Pinout

| Part | Signal | GPIO |
|---|---|---|
| INMP441 x2 | SCK / BCLK | 4 |
| | WS / LRCLK | 5 |
| | SD | 6 |
| Mic 1 primary | L/R -> GND | (left) |
| Mic 2 reference | L/R -> 3V3 | (right) |
| MAX98357A | BCLK | 15 |
| | LRC | 16 |
| | DIN | 17 |
| | SD (mute) | 18 |
| SSD1306 | SDA | 8 |
| | SCL | 9 |
| Button | raw / cleaned toggle | 10 (to GND) |

Do not use GPIO 33-37 (octal PSRAM), 19/20 (native USB), 0/3/45/46 (strapping)
or 43/44 (console UART).

Power the INMP441s from 3.3 V and the MAX98357A from 5 V. The MAX98357A output
is bridge-tied: connect a speaker, **never headphones**.

## Repository layout

```
src/anc/         Python: features, synthetic noise, dataset, model, training
tests/           pytest suite
firmware/        ESP-IDF projects for the ESP32-S3
tools/           host-side scripts (recording, playback)
```

## Development

```bash
pip install -r requirements.txt
python -m pytest -q
```

## About the training data

Real defence noise recordings are not public, so the dataset combines:

- **real recordings through the INMP441s**: impulsive sounds (hammering, door
  slams, crackers), team voices, room tone;
- **synthetic noise** from `anc.synth` (engines, machinery, vehicles, wind),
  **played through a speaker and re-recorded with the INMP441s**.

Re-recording matters. If only one class came through the real mic, the model
could learn "sounds like the INMP441" instead of "sounds impulsive". It would
look accurate in testing and then fail on the device.

Accuracy measured on purely synthetic data is a pipeline check, not a result.
