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
                                                            | speech starts? -> roll back 150 ms, freeze
                          classifier (every 50 ms) ---------+
                                    |
                                    +-> noise type -> OLED + HQ dashboard ("IMPULSIVE / GUNFIRE")
```

- **Two-mic NLMS adaptive noise canceller** (Widrow-style). Mic 2 hears the
  noise and the filter learns how that noise reaches Mic 1, then subtracts it.
- **One small classifier, two outputs:**

| Output | Used for |
|---|---|
| **Speech present** | Steers the canceller: adapt quickly while nobody speaks, freeze while the soldier talks |
| **Noise type**: stationary / non-stationary / impulsive | Situational awareness, shown on the unit and to HQ. Also to be tested as clipping protection on real recordings |

Noise types are **multi-label**: "mixed" noise means several are on at once.

### Simulation results

From `anc.nlms` + `anc.acoustics`: synthetic speech in 1-2 s phrases with
0.5-1 s pauses, engine / revving / pass-by / wind noise, 12 scenes. Output
SNR in dB, input around 0.5 dB.

| Policy | Mean | Worst case |
|---|---|---|
| Always adapting, fast (mu 0.1) | 2.1 | 0.6 |
| Always adapting, slow (mu 0.003) | 7.6 | -0.9 |
| Perfect speech detector, freeze during speech | 15.5 | 6.5 |
| Realistic detector (~50 ms late), freeze | 9.4 | -3.3 |
| **Realistic detector + weight rollback** | **13.9** | **1.1** |
| Realistic detector updated every 50 ms + rollback (chosen) | 12.6 | 7.3 |

What this means for the design:

- **Adapting while the soldier talks makes the filter chase the voice.**
  Knowing when speech is present is worth ~10 dB. That is the classifier's main job.
- **A real detector is late**, and the adaptation done in that gap stays baked
  into the frozen filter. So the canceller keeps snapshots of its weights and,
  when speech starts, **rolls back 150 ms**. That recovers most of the gap to
  a perfect detector at no extra latency.
- **The detector runs every 50 ms** (20 times a second). Every 10 ms gained
  about 1 dB for 5x the compute; every 250 ms lost about 4 dB.
- **Tuning the step size per noise type gained only 0-2 dB**, and freezing
  during impulses made results worse (10.3 -> 8.6 dB). That is why noise type
  is used for reporting, not for steering. Mic clipping on very loud bangs is
  not modelled yet; real recordings decide that.
- All of this uses synthetic speech. The numbers show which design choices
  matter; real accuracy has to be measured on real recordings.

### Why the classifier is not in the audio path

The canceller runs on every sample. The classifier looks at 265 ms of audio and
runs every 50 ms. It never touches the audio itself; it only tells the
canceller whether to adapt. If the classifier is slow or wrong, the canceller
keeps running with its current filter. The audio never drops out.

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
