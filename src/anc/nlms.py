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
        # Exact recompute once per call (per block), then O(1) running updates.
        # The C port does the same, which stops float32 drift on the device.
        self._x_energy = float(x @ x)

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
    """NLMS canceller driven by a speech detector, with rollback and a divergence guard.

    This is the control logic the firmware runs around the filter:

    - While no speech is detected, adapt with step size `mu`.
    - While speech is detected, freeze: adapting on the talker's voice makes
      the filter chase it and lose the noise solution.
    - The moment speech is first detected, roll the weights back to a snapshot
      from `rollback_blocks` ago. A real detector notices speech tens of ms
      late, and the adaptation done in that window would otherwise stay baked
      into the frozen filter for the whole phrase.
    - Divergence guard: a canceller must never make its output louder than
      its input. If a block's output energy exceeds the (delayed) primary's by
      more than `guard_db`, that block is output unprocessed (bypass), and the
      filter restarts from the last known-good weights and keeps adapting. If
      it trips again on the very next block, the known-good weights are wrong
      for the current noise too, so the filter restarts from zero.

      (A first version froze the known-good weights instead of bypassing.
      When those weights were wrong for new noise, the guard kept restoring
      them and locked the canceller in a bad state: mean SNR fell from 11.2
      to 2.7 dB. Bypass-and-readapt cannot lock up.)

    Known-good weights are the ones in use at the end of a no-speech block
    where the filter removed at least `good_db` of noise.
    """

    def __init__(self, params: NlmsParams | None = None, block: int = 160,
                 rollback_blocks: int = 15, guard_db: float | None = 6.0,
                 good_db: float = 3.0) -> None:
        self.nlms = NlmsCanceller(params)
        self.block = block
        self.rollback_blocks = rollback_blocks
        self.guard_db = guard_db
        self.good_db = good_db
        self._snaps: list[np.ndarray] = []
        self._good_w = self.nlms.w.copy()
        self._speech = False
        self.rollbacks = 0
        self.guard_trips = 0
        self._tripped_last = False

    def set_speech(self, speech: bool) -> None:
        """Apply a detector decision. Takes effect from the next block."""
        if speech and not self._speech and len(self._snaps) >= self.rollback_blocks:
            self.nlms.w[:] = self._snaps[-self.rollback_blocks]
            self.rollbacks += 1
        self._speech = speech

    def _state(self) -> tuple:
        n = self.nlms
        return n.w.copy(), n._x.copy(), n._d.copy(), n._x_energy

    def _restore(self, st: tuple) -> None:
        n = self.nlms
        n.w[:], n._x[:], n._d[:], n._x_energy = st[0], st[1], st[2], st[3]

    def process_block(self, primary: np.ndarray, reference: np.ndarray) -> np.ndarray:
        if len(primary) != self.block:
            raise ValueError(f"expected blocks of {self.block} samples, got {len(primary)}")
        before = self._state()
        mu = 0.0 if self._speech else self.nlms.p.mu
        out = self.nlms.process(primary, reference, mu=mu)

        # The delayed primary for this block is what the output should never exceed.
        d = np.concatenate([before[2][::-1][1:], np.asarray(primary, np.float64)])[:self.block]
        e_in = float(np.dot(d, d)) + 1e-20
        e_out = float(np.dot(out.astype(np.float64), out.astype(np.float64)))
        ratio_db = 10 * np.log10(e_out / e_in + 1e-20)

        if self.guard_db is not None and ratio_db > self.guard_db:
            self.guard_trips += 1
            out = d.astype(np.float32)                      # bypass this block
            if self._tripped_last:
                self._good_w[:] = 0.0                       # good weights are stale too
            self.nlms.w[:] = self._good_w                   # restart, keep adapting
            self._tripped_last = True
        else:
            self._tripped_last = False
            if not self._speech and ratio_db < -self.good_db:
                self._good_w = self.nlms.w.copy()

        self._snaps.append(self.nlms.w.copy())
        if len(self._snaps) > self.rollback_blocks:
            self._snaps.pop(0)
        return out
