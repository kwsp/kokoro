import numpy as np
import pytest
import torch

from kokoro.custom_stft import CustomSTFT
from kokoro.istftnet import TorchSTFT


@pytest.fixture
def sample_audio():
    # Generate a sample audio signal (sine wave)
    sample_rate = 16000
    duration = 1.0  # seconds
    t = torch.linspace(0, duration, int(sample_rate * duration))
    frequency = 440.0  # Hz
    signal = torch.sin(2 * np.pi * frequency * t)
    return signal.unsqueeze(0)  # Add batch dimension


def test_stft_reconstruction(sample_audio):
    # Initialize both STFT implementations
    custom_stft = CustomSTFT(filter_length=800, hop_length=200, win_length=800)
    torch_stft = TorchSTFT(filter_length=800, hop_length=200, win_length=800)

    # Process through both implementations
    custom_output = custom_stft(sample_audio)
    torch_output = torch_stft(sample_audio)

    # Compare outputs
    assert torch.allclose(custom_output, torch_output, rtol=1e-3, atol=1e-3)


def test_magnitude_phase_consistency(sample_audio):
    custom_stft = CustomSTFT(filter_length=800, hop_length=200, win_length=800)
    torch_stft = TorchSTFT(filter_length=800, hop_length=200, win_length=800)

    # Get magnitude and phase from both implementations
    custom_mag, _custom_phase = custom_stft.transform(sample_audio)
    torch_mag, _torch_phase = torch_stft.transform(sample_audio)

    # Compare magnitudes ignoring the boundary frames
    custom_mag_center = custom_mag[..., 2:-2]
    torch_mag_center = torch_mag[..., 2:-2]
    assert torch.allclose(custom_mag_center, torch_mag_center, rtol=1e-2, atol=1e-2)


def test_batch_processing():
    # Create a batch of signals
    batch_size = 4
    sample_rate = 16000
    duration = 0.1  # shorter duration for faster testing
    t = torch.linspace(0, duration, int(sample_rate * duration))
    frequency = 440.0
    signals = torch.sin(2 * np.pi * frequency * t).unsqueeze(0).repeat(batch_size, 1)

    custom_stft = CustomSTFT(filter_length=800, hop_length=200, win_length=800)

    # Process batch
    output = custom_stft(signals)

    # Check output shape
    assert output.shape[0] == batch_size
    assert len(output.shape) == 3  # (batch, 1, time)


def test_different_window_sizes():
    signal = torch.randn(1, 16000)  # 1 second of random noise

    # Test with different window sizes
    for filter_length in [512, 1024, 2048]:
        custom_stft = CustomSTFT(
            filter_length=filter_length,
            hop_length=filter_length // 4,
            win_length=filter_length,
        )

        # Forward and backward transform
        output = custom_stft(signal)

        # Check that output length is reasonable
        assert output.shape[-1] >= signal.shape[-1]


@pytest.mark.parametrize("filter_length", [127, 128, 512])
@pytest.mark.parametrize("signal_kind", ["dc", "nyquist", "random"])
def test_roundtrip_preserves_amplitude_and_partial_final_hop(
    filter_length, signal_kind
):
    length = 1003
    if signal_kind == "dc":
        signal = torch.full((1, length), 0.75)
    elif signal_kind == "nyquist":
        signal = (torch.arange(length) % 2 * 2 - 1).float().unsqueeze(0)
    else:
        signal = torch.randn(2, length, generator=torch.Generator().manual_seed(42))
    stft = CustomSTFT(
        filter_length=filter_length,
        hop_length=filter_length // 4,
        win_length=filter_length,
    )
    output = stft(signal)
    assert output.shape == (signal.shape[0], 1, length)
    torch.testing.assert_close(output[:, 0], signal, rtol=1e-4, atol=1e-5)


def test_shorter_window_matches_torch_transform_and_reconstructs():
    signal = torch.randn(1, 1003, generator=torch.Generator().manual_seed(42))
    stft = CustomSTFT(filter_length=128, hop_length=16, win_length=96)
    magnitude, phase = stft.transform(signal)
    expected = torch.stft(
        signal,
        n_fft=128,
        hop_length=16,
        win_length=96,
        window=torch.hann_window(96),
        pad_mode="replicate",
        return_complex=True,
    )
    torch.testing.assert_close(
        magnitude * torch.cos(phase), expected.real, atol=1e-5, rtol=1e-4
    )
    torch.testing.assert_close(
        magnitude * torch.sin(phase), expected.imag, atol=1e-5, rtol=1e-4
    )
    torch.testing.assert_close(
        stft.inverse(magnitude, phase, length=1003)[:, 0], signal, atol=1e-5, rtol=1e-4
    )


def test_inverse_without_length_keeps_default_center_crop():
    signal = torch.randn(1, 1003, generator=torch.Generator().manual_seed(42))
    stft = CustomSTFT(filter_length=128, hop_length=32, win_length=128)
    magnitude, phase = stft.transform(signal)
    output = stft.inverse(magnitude, phase)
    assert output.shape == (1, 1, 992)
    torch.testing.assert_close(output[:, 0], signal[:, :992], atol=1e-5, rtol=1e-4)
