import numpy as np

from anc.link import BLOCK_FRAMES, FrameParser, assemble, decode_s24, encode_block


def _block(seq, rng):
    return rng.integers(-(1 << 23), 1 << 23, size=(BLOCK_FRAMES, 2), dtype=np.int32)


def test_s24_round_trip_including_extremes():
    s = np.array([[0, -1], [(1 << 23) - 1, -(1 << 23)]] + [[0, 0]] * (BLOCK_FRAMES - 2), dtype=np.int32)
    frame = encode_block(0, 0, s)
    got = FrameParser().feed(frame)[0].samples
    assert np.array_equal(got, s)


def test_parses_across_arbitrary_chunk_boundaries():
    rng = np.random.default_rng(0)
    blocks = [_block(i, rng) for i in range(5)]
    stream = b"".join(encode_block(i, 0, b) for i, b in enumerate(blocks))
    p, out = FrameParser(), []
    for i in range(0, len(stream), 37):          # awkward chunk size on purpose
        out += p.feed(stream[i:i + 37])
    assert [b.seq for b in out] == list(range(5))
    assert all(np.array_equal(o.samples, b) for o, b in zip(out, blocks))


def test_resyncs_after_garbage_and_text():
    rng = np.random.default_rng(1)
    b = _block(0, rng)
    stream = b"garbage\nANC fw=0.1.0 lvl=-40\nANCF" + encode_block(3, 0, b)
    out = FrameParser().feed(stream)
    assert len(out) == 1 and out[0].seq == 3


def test_assemble_zero_fills_gaps_and_keeps_alignment():
    rng = np.random.default_rng(2)
    b0, b2 = _block(0, rng), _block(2, rng)
    p = FrameParser()
    blocks = p.feed(encode_block(10, 0, b0) + encode_block(12, 1, b2))
    samples, missing = assemble(blocks)
    assert missing == 1
    assert samples.shape == (3 * BLOCK_FRAMES, 2)
    assert np.array_equal(samples[:BLOCK_FRAMES], b0)
    assert not samples[BLOCK_FRAMES:2 * BLOCK_FRAMES].any()
    assert np.array_equal(samples[2 * BLOCK_FRAMES:], b2)


def test_decode_s24_sign():
    assert decode_s24(bytes([0xFF, 0xFF, 0xFF])).tolist() == [-1]
    assert decode_s24(bytes([0x00, 0x00, 0x80])).tolist() == [-(1 << 23)]
