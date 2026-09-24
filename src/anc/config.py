"""Single source of truth for signal and model parameters.

Every value here is mirrored by the embedded implementation, so changing
anything means regenerating the C-side constants too. Keep it boring.
"""
from dataclasses import dataclass, field


# --- Audio ---------------------------------------------------------------
# 16 kHz: standard for defence voice comms, matches common embedded codecs
# (WM8960, SGTL5000), and is the rate wideband PESQ expects.
SAMPLE_RATE = 16_000

# --- Framing -------------------------------------------------------------
# 25 ms window / 10 ms hop is the usual speech-analysis choice: long enough to
# resolve an 85 Hz male F0, short enough to track a gunshot onset.
WIN_LENGTH = 400          # 25 ms
HOP_LENGTH = 160          # 10 ms
N_FFT = 512               # next power of two above WIN_LENGTH

# --- Mel filterbank ------------------------------------------------------
# 40 bands keeps the filterbank matrix small enough to hold in MCU flash.
N_MELS = 40
FMIN = 20.0
FMAX = SAMPLE_RATE / 2

# --- Classifier input ----------------------------------------------------
# 25 frames = 265 ms of context. Long enough to tell a steady engine from a
# revving one; short enough that the decision is still current.
CONTEXT_FRAMES = 25

# How often the classifier actually runs. It is NOT in the audio path -- see
# README "Why the classifier is not in the audio path". The ANC filter runs
# per-sample; the classifier only retunes its parameters a few times a second.
CLASSIFY_PERIOD_MS = 250

# --- Labels --------------------------------------------------------------
# Noise types are MULTI-LABEL, not mutually exclusive: a revving engine over a
# steady generator is both stationary and non-stationary, and that is exactly
# the "mixed" case the problem statement asks for. Modelling it as a softmax
# would force an arbitrary winner and mistune the ANC.
NOISE_CLASSES = ("stationary", "non_stationary", "impulsive")
N_NOISE_CLASSES = len(NOISE_CLASSES)

# Speech presence is a SEPARATE binary head. It is not a fourth noise class:
# speech co-occurs with every noise type, and preserving it is the objective.
SPEECH_CLASS = "speech"


@dataclass(frozen=True)
class FeatureConfig:
    sample_rate: int = SAMPLE_RATE
    win_length: int = WIN_LENGTH
    hop_length: int = HOP_LENGTH
    n_fft: int = N_FFT
    n_mels: int = N_MELS
    fmin: float = FMIN
    fmax: float = FMAX
    context_frames: int = CONTEXT_FRAMES

    @property
    def context_samples(self) -> int:
        """Samples needed to produce exactly `context_frames` frames."""
        return (self.context_frames - 1) * self.hop_length + self.win_length

    @property
    def context_ms(self) -> float:
        return 1000.0 * self.context_samples / self.sample_rate


DEFAULT_FEATURES = FeatureConfig()
