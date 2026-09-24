import numpy as np

from anc import synth
from anc.acoustics import make_scene
from anc.config import SAMPLE_RATE
from anc.metrics import noise_reduction_db, si_sdr_db, snr_db
from anc.nlms import NlmsCanceller, NlmsParams


def test_learns_a_known_acoustic_path():
    # Primary = reference through a known FIR. A working NLMS must end up with
    # w equal to that FIR (shifted by the primary delay) and cancel almost fully.
    rng = np.random.default_rng(0)
    ref = rng.standard_normal(SAMPLE_RATE).astype(np.float32)
    h = np.zeros(20)
    h[[3, 7, 12]] = [0.9, -0.4, 0.2]
    pri = np.convolve(ref, h)[: len(ref)]
    p = NlmsParams(taps=64, mu=0.5, delay=8)
    anc = NlmsCanceller(p)
    e = anc.process(pri, ref)
    tail = e[-4000:]
    assert 10 * np.log10(np.mean(pri[-4000:] ** 2) / np.mean(tail ** 2)) > 40
    # d[n] = pri[n - 8] = sum_j h[j] ref[n - 8 - j], so the filter must learn
    # w[8 + j] == h[j]: the known path, shifted by the primary delay.
    assert np.allclose(anc.w[8:8 + len(h)], h, atol=0.02)


def test_frozen_filter_does_not_change():
    rng = np.random.default_rng(1)
    x = rng.standard_normal(2000)
    anc = NlmsCanceller(NlmsParams(taps=32))
    anc.process(x, x)
    w = anc.w.copy()
    anc.process(rng.standard_normal(2000), x, adapt=False)
    assert np.array_equal(anc.w, w)


def _talking(clean):
    from scipy.ndimage import uniform_filter1d
    env = np.sqrt(np.maximum(uniform_filter1d(clean.astype(float) ** 2, 320), 0))
    return env > 0.1 * env.max()


def test_speech_gated_canceller_cleans_engine_noise():
    rng = np.random.default_rng(2)
    n = 3 * SAMPLE_RATE
    sc = make_scene(synth.speech_like(n, rng), synth.engine_hum(n, rng), rng,
                    snr_db=0.0, speech_leak_db=-20.0)
    p = NlmsParams(mu=0.1)
    mu = np.where(_talking(sc.speech_at_primary), 0.0, p.mu)
    out = NlmsCanceller(p).process(sc.primary, sc.reference, mu=mu)
    half = n // 2  # score after convergence
    before = snr_db(sc.speech_at_primary[half:], sc.primary[half:])
    after = snr_db(sc.speech_at_primary[half:], out[half:], delay=p.delay)
    assert after - before > 10, (before, after)


def test_adapting_during_speech_is_worse_than_freezing():
    # The finding behind the speech-presence head: a fast filter that keeps
    # adapting while the soldier talks chases the voice and loses most of its
    # benefit. Guard it so a future change cannot silently undo the policy.
    rng = np.random.default_rng(5)
    n = 3 * SAMPLE_RATE
    sc = make_scene(synth.speech_like(n, rng), synth.vehicle_passby(n, rng), rng,
                    snr_db=0.0, speech_leak_db=-20.0)
    p = NlmsParams(mu=0.1)
    half = n // 2
    always = NlmsCanceller(p).process(sc.primary, sc.reference)
    gated = NlmsCanceller(p).process(sc.primary, sc.reference,
                                     mu=np.where(_talking(sc.speech_at_primary), 0.0, p.mu))
    s_always = snr_db(sc.speech_at_primary[half:], always[half:], delay=p.delay)
    s_gated = snr_db(sc.speech_at_primary[half:], gated[half:], delay=p.delay)
    assert s_gated > s_always + 5, (s_always, s_gated)


def test_metric_sanity():
    rng = np.random.default_rng(3)
    s = rng.standard_normal(1000)
    assert snr_db(s, s) > 100
    assert abs(snr_db(s, s + s) - 0.0) < 1e-6                 # error == signal
    assert si_sdr_db(s, 0.1 * s) > 100                        # gain alone is not penalised
    assert abs(noise_reduction_db(s, 0.1 * s) - 20.0) < 1e-6


def test_rollback_restores_weights_from_before_speech_onset():
    from anc.nlms import GatedCanceller
    rng = np.random.default_rng(6)
    g = GatedCanceller(NlmsParams(taps=16), block=160, rollback_blocks=3)
    x = rng.standard_normal(160 * 10)
    for k in range(5):
        g.process_block(x[k * 160:(k + 1) * 160], x[k * 160:(k + 1) * 160])
    snapshot_3_ago = g._snaps[-3].copy()
    g.set_speech(True)
    assert np.array_equal(g.nlms.w, snapshot_3_ago) and g.rollbacks == 1
    frozen = g.nlms.w.copy()
    g.process_block(rng.standard_normal(160), rng.standard_normal(160))
    assert np.array_equal(g.nlms.w, frozen)          # no adaptation during speech
    g.set_speech(True)
    assert g.rollbacks == 1                          # only on the onset, not every decision


def test_rollback_recovers_from_late_speech_detection():
    # A detector that notices speech 60 ms late, decided every 50 ms: rollback
    # must beat the same detector without it.
    from anc.nlms import GatedCanceller
    rng = np.random.default_rng(7)
    n, B = 8 * SAMPLE_RATE, 160
    speech = np.zeros(n, np.float32)
    t = int(1.5 * SAMPLE_RATE)
    while t < n:
        L = min(int(rng.uniform(1.0, 2.0) * SAMPLE_RATE), n - t)
        speech[t:t + L] = synth.speech_like(L, rng)
        t += L + int(rng.uniform(0.5, 1.0) * SAMPLE_RATE)
    sc = make_scene(speech, synth.vehicle_passby(n, rng), rng, snr_db=0.0, speech_leak_db=-20.0)
    active = np.abs(speech) > 0
    late = np.concatenate([np.zeros(960, bool), active[:-960]])     # 60 ms late

    def run(rollback):
        g = GatedCanceller(NlmsParams(), block=B, rollback_blocks=15 if rollback else 10 ** 9)
        out = []
        for k in range(0, n, B):
            if k % 800 == 0 and k > 0:                               # decisions every 50 ms,
                g.set_speech(bool(late[max(0, k - 4240):k].mean() > 0.2))  # past 265 ms only
            out.append(g.process_block(sc.primary[k:k + B], sc.reference[k:k + B]))
        return np.concatenate(out)

    seg = slice(int(1.5 * SAMPLE_RATE), None)
    without = snr_db(sc.speech_at_primary[seg], run(False)[seg], delay=16)
    with_rb = snr_db(sc.speech_at_primary[seg], run(True)[seg], delay=16)
    assert with_rb > without + 1.0, (without, with_rb)
