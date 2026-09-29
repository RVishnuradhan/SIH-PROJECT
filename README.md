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

All numbers below use **synthetic** speech and noise. They show which design
choices matter; real performance has to be measured on real recordings.

#### Closed loop: trained classifier driving the canceller

`tools/eval_loop.py`: the model runs every 50 ms on the last 265 ms of both
mics, and its speech decisions drive the canceller (freeze, 150 ms rollback,
divergence guard). 30 fresh scenes (5 noise types x 6) that nothing was tuned
on; speech in phrases with pauses; input SNR 0 dB.

| Detector | Mean output SNR | Worst scene |
|---|---|---|
| None (always adapting) | 2.1 dB | 0.5 dB |
| Classifier, primary mic only | 9.4 dB | -1.1 dB |
| **Classifier, both mics** | **11.8 dB** | **0.8 dB** |
| Perfect speech detector | 15.5 dB | 2.6 dB |

- The two-mic classifier gets about **75% of the perfect detector's gain**.
- It flags speech a median **37 ms** after a phrase starts (90th percentile
  99 ms), inside the 150 ms rollback window. One mic: 65 ms / 133 ms.
- Both mics beat one mic on every output (validation AUC, speech 0.977 vs
  0.962), because speech is much louder at the mouth mic than at the reference.

#### Design decisions these experiments produced

| Decision | Evidence |
|---|---|
| **Freeze adaptation while the soldier speaks** | Always adapting: 2.1 dB. A perfect speech detector: 15.5 dB. Adapting on the voice makes the filter chase it. |
| **Roll back 150 ms on speech onset** | A real detector is late; without rollback the adaptation done in that gap stays in the frozen filter. Realistic detector: 9.4 dB without rollback, 13.9 dB with. |
| **Classify every 50 ms** | Every 250 ms lost ~4 dB; every 10 ms gained ~1 dB for 5x the compute. |
| **Divergence guard at 6 dB** | Without it, one missed phrase plus changing wind made the output 13 dB *worse* than the input. With it, no scene gets worse than the input, and the mean rises. A 1 dB threshold tripped on harmless speech leakage. |
| **Noise type reported, not used for steering** | Tuning the step size per noise type gained only 0-2 dB; freezing during impulses made results worse (10.3 -> 8.6 dB). Mic clipping on loud bangs is not modelled yet. |

### Results on the real hardware (ESP32-S3 + 2x INMP441, indoors)

Recorded with `tools/record.py --cleaned` in a room with a ceiling fan, and
with an engine sound played from a phone 1 m away; voice 2-3 cm from mic 1.
"Voice vs noise gain" is how much louder the voice is relative to the noise
after processing than before.

| Processing | Fan | Phone engine sound |
|---|---|---|
| Two-mic NLMS canceller (firmware 0.2) | +3.4 dB | +0.4 dB |
| **Spectral suppressor (second stage)**, offline on the same recordings | **+8.0 dB** | **+7.0 dB** |

What the hardware taught us:

- **Mic placement decides everything for the two-mic canceller.** With the
  mics 3 cm apart, mic 2 heard the voice almost as loudly as mic 1 and the
  canceller removed voice along with noise. At 14 cm (helmet geometry: boom
  mic at the mouth, reference on the shell) the voice is ~13 dB louder at mic 1
  and is preserved.
- **Indoors, the noise at the two mics is only partly alike** (measured
  coherence 0.74). An always-adapting filter removed ~8 dB of noise-only
  engine sound, but a filter frozen during speech only ~2.5 dB, and adapting
  during speech removes the voice. So the two-mic canceller alone cannot help
  much in a reverberant room; it is expected to do better outdoors, where the
  noise reaches both mics more directly.
- **A single-channel spectral suppressor** (learns the noise spectrum in
  speech pauses, turns those frequencies down, floor -15 dB) does not need
  the mics to agree, and gave +7 to +8 dB on the real recordings with the
  voice level unchanged (within 0.6 dB). In listening tests the difference
  was hard to hear, because it only acts on noise it has learned in pauses.

### Neural noise suppressor (firmware 0.3)

A small recurrent network (Dense 64 -> GRU 96 -> GRU 96 -> 24 band gains,
106k weights, same idea as RNNoise) that turns down every frequency band
where it hears noise rather than voice, 125 times a second. It needs no
speech detector and no second mic. It was trained once, on a laptop, on
~2 h of mixtures of DNS Challenge speech and noise, synthetic battlefield
sounds and the team's own recorded engine noise (`tools/build_denoise_set.py`,
`tools/train_denoiser.py`). The board runs it in C with int8 weights
(`firmware/anc_unit/components/anc_denoise`, 134 KB of internal RAM, 14 ms
added latency) after the two-mic canceller. No network is involved.

Held-out mixtures (speakers and noises never seen in training;
`tools/eval_denoiser.py`). The old method was given the true talking/pause
labels, which the AI is not:

| Input SNR | Noise removed in pauses, AI / old | Voice quality (SNR after), AI / old |
|---|---|---|
| -5 dB | **15.9** / 9.0 dB | **11.2** / 9.7 dB |
| 0 dB | **14.4** / 10.6 dB | **14.2** / 9.0 dB |
| 5 dB | **13.3** / 11.0 dB | **18.4** / 11.2 dB |
| 10 dB | **13.1** / 10.1 dB | **20.9** / 14.5 dB |

The team's recordings from the board (mic 1, high-passed at 60 Hz):

| Recording | Noise removed in pauses, AI / old | Voice level change, AI |
|---|---|---|
| Phone engine sound, voice close | **12.8** / 7.1 dB | -0.8 dB |
| Fan, voice close | **12.5** / 6.0 dB | -2.1 dB |
| Fan, voice farther | 12.3 / 12.7 dB | -1.8 dB |
| Fan, mics 3 cm apart | **25.8** / 15.0 dB | -2.8 dB |

One finding from the board: its mics pick up breath puffs and DC drift below
20 Hz, up to 26 dB stronger than in the training speech, and the network
took that for noise. The suppressor now high-passes its input at 60 Hz, like
the training data.

### Two-mic AI and level rule (firmware 0.4)

A recording with the engine sound next to mic 2 and the voice at mic 1
showed why the two-mic canceller gains little indoors: the engine at the two
mics was barely alike (coherence 0.1-0.45), which caps any linear canceller
at about 3 dB. Loudness still differs, though: the voice is loud at mic 1
and faint at mic 2. Two things now use that:

- **Two-mic network**: the same network, fed the band energies of both mics
  (trained on simulated two-mic rooms, `build_denoise_set.py --mics 2`).
- **Level rule** after it: per frequency, turn down whatever part of
  mic 2's level relative to mic 1 is more than the voice's own. How much voice
  reaches mic 2 is learned while the network is sure someone is talking, so
  it adapts to where the mics sit.

Known clean voice mixed into the real engine noise recorded by the board
(voice reaching mic 2 13 dB down, voice as loud as the noise):

| | Noise removed while talking | in pauses | Voice quality |
|---|---|---|---|
| One-mic AI | 7.7 dB | 13.8 dB | 11.7 dB |
| One-mic AI + fixed level rule (preferred by ear) | 14.2 dB | 22.1 dB | 8.5 dB |
| **Two-mic AI + learned level rule (firmware 0.4)** | 12.2 dB | 19.1 dB | 10.5 dB |

On the board itself (firmware 0.4.2, recording made with `record.py
--cleaned`, gunfire video played next to mic 2, lab fan running): the AI
runs on core 0 in up to 10.3 ms per 10 ms block with no missed blocks, and
core 1 needs 1-2 ms. Between words the noise dropped from about -33 dBFS to
-50 to -80 dBFS; while talking the level changed by under 2 dB. Total delay
from mic to output is 35 ms.

The limit: mic 2 must hear the voice clearly less than mic 1 (in a helmet,
boom mic at the mouth and mic 2 on the shell). With the voice about equally
loud at both, any two-mic method turns some of it down.

### Project targets: SNR, STOI, PESQ and delay

Targets: output **SNR > 15 dB**, **STOI > 0.85**, **PESQ > 2.5**, at low delay
for real-time communication. STOI and PESQ compare the output with the original
clean voice, so they can only be measured on mixtures where that voice is known
(`tools/benchmark_targets.py`); the device cannot compute them live. The test
runs the firmware's own processing (int8 weights, two mics, level rule) on 40
scenes per noise level built from speakers and noises the network never saw:
DNS noise, synthetic engines, wind and gunfire-like impulses, and the team's
recorded engine noise. Voice at the mouth mic is -45 to -20 dBFS, as measured on
the board.

| Input SNR | Output SNR | STOI (in -> out) | PESQ (in -> out) | Scenes meeting SNR / STOI / PESQ |
|---|---|---|---|---|
| -5 dB | 11.6 dB | 0.67 -> 0.73 | 1.14 -> 1.29 | 28% / 22% / 2% |
| 0 dB | 13.6 dB | 0.74 -> 0.80 | 1.10 -> 1.37 | 50% / 28% / 0% |
| **5 dB** | **18.3 dB** | **0.84 -> 0.87** | 1.16 -> 1.69 | 78% / 72% / 8% |
| **10 dB** | **23.7 dB** | **0.92 -> 0.94** | 1.68 -> 2.33 | 95% / 92% / 22% |
| **15 dB** | **24.7 dB** | **0.93 -> 0.95** | 1.69 -> 2.46 | 100% / 98% / 40% |

- **SNR > 15 dB and STOI > 0.85 are met on average from an input SNR of 5 dB
  up.** In harder noise (0 dB and below) they are not.
- **PESQ > 2.5 is not met** at any noise level (best 2.46 at 15 dB input).
  PESQ is harsh on impulsive noise and on any change to the voice. It is
  limited by the network, not by the settings: raising the smallest gain from
  -30 dB to -10 dB only moved it from 2.27 to 2.21-2.38. A bigger network or
  more training is needed.
- Delay from mic to output: **35 ms**, measured on the board.

#### By noise type (deployed model, input SNR 10 dB, 15 scenes each)

| Noise | Output SNR | STOI | PESQ |
|---|---|---|---|
| Artillery | 33.5 dB | 0.98 | **3.16** |
| Siren | 25.0 dB | 0.94 | **2.52** |
| Wind | 24.2 dB | 0.95 | 2.47 |
| Drone propellers | 24.5 dB | 0.94 | 2.43 |
| General noise (DNS clips) | 26.8 dB | 0.93 | 2.40 |
| Armoured vehicle (tracked) | 22.7 dB | 0.95 | 2.34 |
| Engine (steady) | 23.4 dB | 0.95 | 2.31 |
| Engine (revving) | 24.2 dB | 0.94 | 2.27 |
| Gunfire-like impulses | 25.7 dB | 0.92 | 2.23 |
| Machinery / fan | 23.7 dB | 0.93 | 2.21 |
| Helicopter rotor | 23.1 dB | 0.93 | 2.08 |

At this noise level SNR and STOI are met for every type and PESQ is met for
artillery and sirens. Rhythmic, wide-band noise (helicopter, machinery,
gunfire) is hardest for PESQ. `tools/benchmark_targets.py --noise <type>`
reproduces one row.

A second model trained with sirens, helicopter rotor, drones, tracked vehicles
and artillery added to the training noise (30 epochs, 24,000 examples) scored
the same as this one on all of the above (within 0.05 PESQ) and on the old
noise mix, so the deployed model was kept. The five generators stay in
`anc.synth` and in the training mix (`SYNTH_NEW`).

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
| Display | 1.3" I2C OLED (SH1106, 4 pins) + phone dashboard on the board's own WiFi hotspot (firmware 0.6: join `HERTZ-HUNTERS-ANC`, open http://192.168.4.1) |
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
| OLED (SH1106) | SDA | 8 |
| | SCL | 9 |
| Button | speaker mode (mute / raw / cleaned / reference) | the DevKit's own **BOOT** button (GPIO 0), nothing to wire |

Do not use GPIO 33-37 (octal PSRAM), 19/20 (native USB), 3/45/46 (strapping)
or 43/44 (console UART). GPIO 0 is used only through the on-board BOOT button.

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
