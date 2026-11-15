"""Audio encodings shared by the engine and HTTP layer."""

import io
import wave

import numpy as np

SAMPLE_RATE = 24_000
CHANNELS = 1
SAMPLE_WIDTH = 2


def to_pcm(audio) -> bytes:
    """Encode a mono NumPy array or CPU/GPU tensor as signed little-endian PCM."""
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu().numpy()
    samples = np.asarray(audio)
    if samples.ndim != 1:
        raise ValueError("audio must be a one-dimensional mono array")
    if not np.issubdtype(samples.dtype, np.number) or np.iscomplexobj(samples):
        raise ValueError("audio samples must be real numbers")
    if not np.isfinite(samples).all():
        raise ValueError("audio samples must be finite")
    return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()


def to_wav(pcm: bytes) -> bytes:
    """Wrap complete PCM data in a WAV file with correct length headers."""
    if len(pcm) % SAMPLE_WIDTH:
        raise ValueError("PCM data must contain complete 16-bit samples")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(CHANNELS)
        output.setsampwidth(SAMPLE_WIDTH)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm)
    return buffer.getvalue()
