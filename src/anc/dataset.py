"""Training windows: two-mic log-mel features plus four labels per window.

Every window is 265 ms (CONTEXT_FRAMES frames) of BOTH mics. Two mics, not
one, because the level difference between them is a strong speech cue: the
soldier's voice is much louder at the mouth mic than at the outward-facing
reference, while environmental noise is roughly equal at both.

Labels, in this order (see LABELS):
    stationary, non_stationary, impulsive   -- which noise types are audible
    speech                                  -- is the soldier talking right now

A label can be NaN, meaning "genuinely ambiguous, do not train on it" --
for example a window that contains only the fading tail of a blast. Training
masks those out instead of guessing.

Two sources produce windows in the same format:
    synthetic_clip()          -- generated scenes with exact sample-level truth
    recording_windows()       -- your recordings from tools/record.py, labelled
                                 from their .json sidecar
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from . import synth
from .acoustics import make_scene
from .config import (CLASSIFY_PERIOD_MS, DEFAULT_FEATURES as CFG, NOISE_CLASSES,
                     SAMPLE_RATE, SPEECH_CLASS)
from .features import log_mel, mel_filterbank

LABELS = NOISE_CLASSES + (SPEECH_CLASS,)
N_LABELS = len(LABELS)
IDX = {name: i for i, name in enumerate(LABELS)}

WINDOW_STEP_FRAMES = CLASSIFY_PERIOD_MS * SAMPLE_RATE // 1000 // CFG.hop_length   # 5

# Speech label looks only at the most recent part of the window, so the model
# learns to flag speech as soon as it starts -- the faster it reacts, the less
# the canceller has to roll back.
SPEECH_RECENT_MS = 80
# A blast counts for windows it starts in, and for 50 ms after; windows that
# only hold the reverberant tail beyond that are ambiguous and masked.
IMPULSE_HOLD_MS = 50
IMPULSE_TAIL_MS = 250
# A noise type is labelled present if it is within 10 dB of the loudest noise
# in the window, absent if more than 20 dB below, ambiguous in between.
AUDIBLE_DB, INAUDIBLE_DB = -10.0, -20.0

_FB = mel_filterbank(CFG)


@dataclass
class ClipWindows:
    features: np.ndarray   # (2, n_frames, n_mels) float16: primary, reference log-mel
    starts: np.ndarray     # (n_windows,) first frame of each window
    labels: np.ndarray     # (n_windows, N_LABELS) float32, NaN = masked


def window_starts(n_frames: int) -> np.ndarray:
    last = n_frames - CFG.context_frames
    return np.arange(0, last + 1, WINDOW_STEP_FRAMES) if last >= 0 else np.zeros(0, np.int64)


def window_span(start_frame: int) -> tuple[int, int]:
    a = start_frame * CFG.hop_length
    return a, a + CFG.context_samples


def features_for(primary: np.ndarray, reference: np.ndarray) -> np.ndarray:
    return np.stack([log_mel(primary, CFG, _FB), log_mel(reference, CFG, _FB)]).astype(np.float16)


# --- Synthetic scenes ----------------------------------------------------

POOLS = {
    "stationary": (synth.engine_hum, synth.machinery_hum),
    "non_stationary": (synth.engine_rev, synth.vehicle_passby, synth.wind_gust),
}


def phrased_speech(n: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Speech in phrases with pauses, plus the phrase-level activity mask."""
    s = np.zeros(n, np.float32)
    active = np.zeros(n, bool)
    t = int(rng.uniform(0.0, 1.0) * SAMPLE_RATE)
    while t < n:
        L = min(int(rng.uniform(0.6, 1.5) * SAMPLE_RATE), n - t)
        if L < 800:
            break
        s[t:t + L] = synth.speech_like(L, rng)
        active[t:t + L] = True
        t += L + int(rng.uniform(0.3, 0.8) * SAMPLE_RATE)
    return s, active


def synthetic_clip(seed: int, seconds: float = 3.0, p_speech: float = 0.6) -> ClipWindows:
    rng = np.random.default_rng(seed)
    n = int(seconds * SAMPLE_RATE)

    tracks: dict[str, np.ndarray] = {}
    onsets = np.zeros(0, np.int64)
    for kind, p in (("stationary", 0.55), ("non_stationary", 0.55), ("impulsive", 0.35)):
        if rng.random() >= p:
            continue
        if kind == "impulsive":
            x, onsets = synth.impulse_burst_events(n, rng)
        else:
            pool = POOLS[kind]
            x = pool[int(rng.integers(len(pool)))](n, rng)
        tracks[kind] = x * 10 ** (rng.uniform(-10, 0) / 20)

    noise = sum(tracks.values()) if tracks else 1e-3 * rng.standard_normal(n).astype(np.float32)
    if rng.random() < p_speech:
        speech, active = phrased_speech(n, rng)
    else:
        speech, active = np.zeros(n, np.float32), np.zeros(n, bool)

    sc = make_scene(speech, noise.astype(np.float32), rng,
                    snr_db=rng.uniform(-5, 15),
                    speech_leak_db=rng.uniform(-30, -8),
                    incoherent_db=rng.uniform(-30, -10))

    # Absolute level: speech at arm's length is ~-45 dBFS on an INMP441, a
    # nearby engine or blast far louder. Clip at full scale like the real mic.
    level_db = rng.uniform(-50, -15)
    g = 10 ** (level_db / 20) / (np.sqrt(np.mean(sc.primary.astype(np.float64) ** 2)) + 1e-12)
    primary = np.clip(sc.primary * g, -1, 1).astype(np.float32)
    reference = np.clip(sc.reference * g, -1, 1).astype(np.float32)

    feats = features_for(primary, reference)
    starts = window_starts(feats.shape[1])
    labels = np.zeros((len(starts), N_LABELS), np.float32)

    recent = SPEECH_RECENT_MS * SAMPLE_RATE // 1000
    hold = IMPULSE_HOLD_MS * SAMPLE_RATE // 1000
    tail = IMPULSE_TAIL_MS * SAMPLE_RATE // 1000
    for w, sf_ in enumerate(starts):
        a, b = window_span(int(sf_))
        # Speech: phrase activity in the most recent 80 ms.
        frac = active[b - recent:b].mean()
        labels[w, IDX["speech"]] = 1.0 if frac >= 0.5 else (0.0 if frac == 0 else np.nan)
        # Impulsive: an onset inside the window or just before it.
        if len(onsets) and "impulsive" in tracks:
            if np.any((onsets >= a - hold) & (onsets < b)):
                labels[w, IDX["impulsive"]] = 1.0
            elif np.any((onsets >= a - tail) & (onsets < a - hold)):
                labels[w, IDX["impulsive"]] = np.nan
        # Continuous noise types: audible relative to the loudest noise here.
        energies = {k: float(np.mean(v[a:b].astype(np.float64) ** 2)) for k, v in tracks.items()}
        loudest = max(energies.values()) if energies else 0.0
        for kind in ("stationary", "non_stationary"):
            if kind not in energies or loudest <= 0:
                continue
            rel = 10 * np.log10(energies[kind] / loudest + 1e-20)
            labels[w, IDX[kind]] = 1.0 if rel >= AUDIBLE_DB else (0.0 if rel < INAUDIBLE_DB else np.nan)
    return ClipWindows(feats, starts, labels)


# --- Real recordings -----------------------------------------------------

def recording_windows(wav: Path) -> ClipWindows:
    """Windows from a tools/record.py recording, labelled from its .json.

    Recordings only have file-level labels ("somewhere in this file there is
    hammering"), so windows get the file's labels, with one correction: for
    intermittent labels (impulsive, speech), windows much quieter than the
    file's typical level are probably gaps between hits or words and are
    masked rather than labelled positive. Everything the file does not list
    is labelled absent.
    """
    meta = json.loads(Path(wav).with_suffix(".json").read_text())
    file_labels = meta["labels"]
    file_labels = [file_labels] if isinstance(file_labels, str) else list(file_labels)
    audio, fs = sf.read(wav, dtype="float32", always_2d=True)
    if fs != SAMPLE_RATE or audio.shape[1] != 2:
        raise ValueError(f"{wav}: expected 2-channel {SAMPLE_RATE} Hz, got {audio.shape[1]} ch {fs} Hz")

    feats = features_for(audio[:, 0], audio[:, 1])
    starts = window_starts(feats.shape[1])
    labels = np.zeros((len(starts), N_LABELS), np.float32)
    energy = np.array([np.mean(audio[window_span(int(s))[0]:window_span(int(s))[1], 0] ** 2)
                       for s in starts]) + 1e-20
    quiet = 10 * np.log10(energy) < 10 * np.log10(np.median(energy)) - 6
    for name in file_labels:
        if name == "silence":
            continue
        labels[:, IDX[name]] = 1.0
        if name in ("impulsive", "speech"):
            labels[quiet, IDX[name]] = np.nan
    return ClipWindows(feats, starts, labels)


# --- Packing -------------------------------------------------------------

def pack(clips: list[ClipWindows]) -> dict[str, np.ndarray]:
    """Concatenate clips into flat arrays for saving with np.savez."""
    offsets = np.cumsum([0] + [c.features.shape[1] for c in clips])
    return {
        "features": np.concatenate([c.features for c in clips], axis=1),
        "window_frame": np.concatenate([c.starts + off for c, off in zip(clips, offsets[:-1])]),
        "window_clip": np.concatenate([np.full(len(c.starts), i) for i, c in enumerate(clips)]),
        "labels": np.concatenate([c.labels for c in clips]),
    }
