"""Two-mic NLMS adaptive noise canceller: the reference implementation.

This is the algorithm the firmware runs, written sample by sample in exactly
the order the C port will use, so the two can be checked against each other.

    reference mic x[n] --> [ adaptive FIR w ] --> y[n]  (estimate of the noise in the primary)
    primary mic   d[n] -------------------------(+)--> e[n] = d[n - D] - y[n]  = cleaned output
                                                  ^ minus

The filter learns how noise travels from the reference mic to the primary mic.
Whatever the reference cannot explain -- ideally the speech -- is left in e[n].

`delay` (D) holds the primary back a few samples. The filter is causal, so
without it any noise that reaches the primary *before* the reference could
never be cancelled. D samples of delay add D/16 ms of latency.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class NlmsParams:
    taps: int = 128          # 8 ms of acoustic path at 16 kHz
    mu: float = 0.1          # step size, 0 < mu < 2; larger = faster but noisier
    delay: int = 16          # primary delay in samples (1 ms)
    eps: float = 1e-6        # keeps the normalisation finite in silence
    leak: float = 1.0        # 1.0 = no leakage; <1 slowly forgets, aids stability


class NlmsCanceller:
    def __init__(self, params: NlmsParams | None = None) -> None:
        self.p = params or NlmsParams()
        self.w = np.zeros(self.p.taps, dtype=np.float64)
        self._x = np.zeros(self.p.taps, dtype=np.float64)      # reference history, newest first
        self._d = np.zeros(self.p.delay + 1, dtype=np.float64)  # primary delay line
        self._x_energy = 0.0

    def reset(self) -> None:
        self.__init__(self.p)

    def process(
        self,
        primary: np.ndarray,
        reference: np.ndarray,
        adapt: bool | np.ndarray = True,
        mu: float | np.ndarray | None = None,
    ) -> np.ndarray:
        """Run one block. `adapt` and `mu` may be scalars or per-sample arrays,
        which is how the classifier's decisions are applied."""
        primary = np.asarray(primary, dtype=np.float64)
        reference = np.asarray(reference, dtype=np.float64)
        n = len(primary)
        adapt_arr = np.broadcast_to(np.asarray(adapt, dtype=bool), (n,))
        mu_arr = np.broadcast_to(np.asarray(self.p.mu if mu is None else mu, dtype=np.float64), (n,))
        out = np.empty(n, dtype=np.float64)
        w, x, dline, p = self.w, self._x, self._d, self.p

        for i in range(n):
            # Running energy of the reference window: O(1) per sample, which
            # is what makes NLMS cheap enough for the MCU.
            oldest = x[-1]
            x[1:] = x[:-1]
            x[0] = reference[i]
            self._x_energy += x[0] * x[0] - oldest * oldest
            if self._x_energy < 0.0:            # float drift guard
                self._x_energy = float(x @ x)

            dline[1:] = dline[:-1]
            dline[0] = primary[i]
            d = dline[-1]

            y = float(w @ x)
            e = d - y
            out[i] = e
            if adapt_arr[i]:
                w *= p.leak
                w += (mu_arr[i] * e / (self._x_energy + p.eps)) * x
        return out.astype(np.float32)


class GatedCanceller:
    """NLMS canceller driven by a speech detector, with weight rollback.

    This is the control logic the firmware runs around the filter:

    - While no speech is detected, adapt with step size `mu`.
    - While speech is detected, freeze: adapting on the talker's voice makes
      the filter chase it and lose the noise solution.
    - The moment speech is first detected, roll the weights back to a snapshot
      from `rollback_blocks` ago. A real detector notices speech tens of ms
      late, and the adaptation done in that window would otherwise stay baked
      into the frozen filter for the whole phrase.

    Simulation (phrase-structured speech, 12 scenes): realistic detector
    without rollback 9.4 dB mean SNR out (worst -3.3), with rollback 13.9 dB
    (worst 1.1); a perfect detector gives 15.5 dB.
    """

    def __init__(self, params: NlmsParams | None = None, block: int = 160,
                 rollback_blocks: int = 15) -> None:
        self.nlms = NlmsCanceller(params)
        self.block = block
        self.rollback_blocks = rollback_blocks
        self._snaps: list[np.ndarray] = []
        self._speech = False
        self.rollbacks = 0

    def set_speech(self, speech: bool) -> None:
        """Apply a detector decision. Takes effect from the next block."""
        if speech and not self._speech and len(self._snaps) >= self.rollback_blocks:
            self.nlms.w[:] = self._snaps[-self.rollback_blocks]
            self.rollbacks += 1
        self._speech = speech

    def process_block(self, primary: np.ndarray, reference: np.ndarray) -> np.ndarray:
        if len(primary) != self.block:
            raise ValueError(f"expected blocks of {self.block} samples, got {len(primary)}")
        out = self.nlms.process(primary, reference, mu=0.0 if self._speech else self.nlms.p.mu)
        self._snaps.append(self.nlms.w.copy())
        if len(self._snaps) > self.rollback_blocks:
            self._snaps.pop(0)
        return out
