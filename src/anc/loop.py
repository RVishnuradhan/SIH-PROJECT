"""Closed-loop evaluation: a speech detector driving the canceller, run the
way the device runs it.

Every CLASSIFY_PERIOD_MS the detector sees the most recent CONTEXT window of
both mics and makes a speech / no-speech decision. The canceller processes
10 ms blocks and picks up the latest decision at each block boundary, with
weight rollback on speech onset (anc.nlms.GatedCanceller).

The score that matters is the canceller's output SNR, not the detector's AUC:
a detector can look accurate on paper and still be late at every phrase onset.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
import torch

from . import synth
from .acoustics import make_scene
from .config import DEFAULT_FEATURES as CFG, BLOCK_MS, GUARD_DB, ROLLBACK_MS, SAMPLE_RATE
from .dataset import IDX, WINDOW_STEP_FRAMES, features_for, window_span, window_starts
from .metrics import snr_db
from .nlms import GatedCanceller, NlmsParams

BLOCK = BLOCK_MS * SAMPLE_RATE // 1000


@dataclass
class LoopScene:
    primary: np.ndarray
    reference: np.ndarray
    speech_at_primary: np.ndarray
    active: np.ndarray          # phrase-level truth
    first_word: int             # sample index scoring starts at


def phrased_scene(seed: int, noise_fn: Callable, seconds: float = 10.0, snr_db_: float = 0.0,
                  level_db: float = -30.0) -> LoopScene:
    """Noise first (the filter gets to converge), then phrases with pauses."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SAMPLE_RATE)
    speech = np.zeros(n, np.float32)
    active = np.zeros(n, bool)
    t = first = int(1.5 * SAMPLE_RATE)
    while t < n:
        L = min(int(rng.uniform(1.0, 2.0) * SAMPLE_RATE), n - t)
        speech[t:t + L] = synth.speech_like(L, rng)
        active[t:t + L] = True
        t += L + int(rng.uniform(0.5, 1.0) * SAMPLE_RATE)
    sc = make_scene(speech, noise_fn(n, rng), rng, snr_db=snr_db_, speech_leak_db=-20.0, incoherent_db=-25.0)
    g = 10 ** (level_db / 20) / (np.sqrt(np.mean(sc.primary.astype(np.float64) ** 2)) + 1e-12)
    return LoopScene(np.clip(sc.primary * g, -1, 1), np.clip(sc.reference * g, -1, 1),
                     sc.speech_at_primary * g, active, first)


def model_decisions(model: torch.nn.Module, sc: LoopScene, threshold: float = 0.5
                    ) -> list[tuple[int, bool]]:
    """(sample at which the decision becomes available, speech?) every 50 ms."""
    feats = features_for(sc.primary, sc.reference)[: model.mics].astype(np.float32)
    starts = window_starts(feats.shape[1])
    x = np.stack([feats[:, s:s + CFG.context_frames] for s in starts])
    with torch.no_grad():
        p = torch.sigmoid(model(torch.from_numpy(x))).numpy()[:, IDX["speech"]]
    return [(window_span(int(s))[1], bool(pi > threshold)) for s, pi in zip(starts, p)]


def oracle_decisions(sc: LoopScene) -> list[tuple[int, bool]]:
    """Perfect phrase-level truth, available immediately every block."""
    return [(k, bool(sc.active[k:k + BLOCK].any())) for k in range(0, len(sc.active), BLOCK)]


def run(sc: LoopScene, decisions: list[tuple[int, bool]] | None,
        params: NlmsParams | None = None, rollback_ms: int = ROLLBACK_MS,
        guard_db: float | None = GUARD_DB) -> np.ndarray:
    """Canceller output. decisions=None means always adapting (no detector)."""
    p = params or NlmsParams()
    g = GatedCanceller(p, block=BLOCK, rollback_blocks=max(1, rollback_ms // BLOCK_MS),
                       guard_db=guard_db)
    out, di = [], 0
    n = len(sc.primary) // BLOCK * BLOCK
    for k in range(0, n, BLOCK):
        if decisions is not None:
            latest = None
            while di < len(decisions) and decisions[di][0] <= k:
                latest = decisions[di][1]
                di += 1
            if latest is not None:
                g.set_speech(latest)
        out.append(g.process_block(sc.primary[k:k + BLOCK], sc.reference[k:k + BLOCK]))
    return np.concatenate(out)


def score(sc: LoopScene, out: np.ndarray, delay: int = NlmsParams().delay) -> float:
    seg = slice(sc.first_word, len(out))
    return snr_db(sc.speech_at_primary[seg], out[seg], delay=delay)


def onset_lags_ms(sc: LoopScene, decisions: list[tuple[int, bool]]) -> list[float]:
    """For each phrase, how long after it started the detector first said speech."""
    onsets = np.flatnonzero(np.diff(sc.active.astype(np.int8)) == 1) + 1
    times = np.array([t for t, _ in decisions])
    flags = np.array([f for _, f in decisions])
    lags = []
    for o in onsets:
        hit = np.flatnonzero((times >= o) & flags)
        if len(hit):
            lags.append(1000.0 * (times[hit[0]] - o) / SAMPLE_RATE)
    return lags
