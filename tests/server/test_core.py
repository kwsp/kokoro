import io
import struct
import sys
import wave
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest
from pydantic import ValidationError

from kokoro_server import engine
from kokoro_server.audio import to_pcm, to_wav
from kokoro_server.schemas import SpeechRequest


def request(**overrides):
    return SpeechRequest(
        **{"model": "kokoro", "input": "Hello.", "voice": "af_heart", **overrides}
    )


def test_request_defaults_and_preserves_input():
    value = request(input="  Hello!\nNext paragraph.  ")
    assert value.input == "  Hello!\nNext paragraph.  "
    assert value.response_format == "wav"
    assert value.speed == 1.0
    assert value.stream_format == "audio"


@pytest.mark.parametrize(
    "overrides",
    [
        {"model": "tts-1"},
        {"input": ""},
        {"input": " \n\t"},
        {"input": "a" * 4097},
        {"input": 123},
        {"voice": "../af_heart"},
        {"voice": "jf_alpha"},
        {"voice": "af_heart.pt"},
        {"response_format": "mp3"},
        {"stream_format": "sse"},
        {"speed": 0.49},
        {"speed": 2.01},
        {"speed": float("nan")},
        {"speed": float("inf")},
        {"speed": True},
        {"speed": "1.0"},
        {"instructions": "whisper"},
        {"stream": True},
    ],
)
def test_invalid_request(overrides):
    with pytest.raises(ValidationError):
        request(**overrides)


@pytest.mark.parametrize("field", ["model", "input", "voice"])
def test_required_fields(field):
    data = {"model": "kokoro", "input": "Hello", "voice": "af_heart"}
    del data[field]
    with pytest.raises(ValidationError):
        SpeechRequest(**data)


def test_valid_boundaries():
    assert request(input="a" * 4096, speed=0.5).speed == 0.5
    assert request(speed=2, voice="bf_emma", response_format="pcm").speed == 2.0


def test_pcm_clipping_endianness_and_tensor_conversion():
    audio = np.array([-2, -1, -0.5, 0, 0.5, 1, 2], dtype=np.float32)
    expected = struct.pack("<7h", -32767, -32767, -16383, 0, 16383, 32767, 32767)
    assert to_pcm(audio) == expected
    tensor = Mock()
    tensor.detach.return_value.cpu.return_value.numpy.return_value = audio
    assert to_pcm(tensor) == expected
    assert to_pcm(np.array([], dtype=np.float32)) == b""


@pytest.mark.parametrize(
    "audio",
    [
        np.zeros((2, 2)),
        np.array([float("nan")]),
        np.array([float("inf")]),
        np.array(["hello"]),
        np.array([1j]),
        np.array(1.0),
    ],
)
def test_invalid_audio(audio):
    with pytest.raises(ValueError):
        to_pcm(audio)


def test_wav_metadata_and_content():
    pcm = struct.pack("<3h", -7, 0, 7)
    wav = to_wav(pcm)
    with wave.open(io.BytesIO(wav), "rb") as reader:
        assert (
            reader.getframerate(),
            reader.getnchannels(),
            reader.getsampwidth(),
        ) == (24000, 1, 2)
        assert reader.getnframes() == 3
        assert reader.readframes(3) == pcm
    with pytest.raises(ValueError):
        to_wav(b"x")


@pytest.fixture
def fake_assets(tmp_path, monkeypatch):
    (tmp_path / "voices").mkdir()
    for filename in [
        "config.json",
        "kokoro-v1_0.pth",
        "voices/af_heart.pt",
        "voices/bf_emma.pt",
        "voices/jf_alpha.pt",
    ]:
        (tmp_path / filename).touch()
    monkeypatch.setattr(engine, "cached_snapshot", lambda: tmp_path)
    monkeypatch.setattr(engine, "check_language_resources", Mock())
    model = Mock()
    model.to.return_value = model
    model.eval.return_value = model
    model_type = Mock(return_value=model)
    pipelines = []

    def pipeline_factory(**kwargs):
        pipeline = Mock(return_value=iter([]))
        pipeline.kwargs = kwargs
        pipeline.side_effect = lambda *args, **kw: iter(
            [
                SimpleNamespace(audio=None),
                SimpleNamespace(audio=np.array([0.5, -0.5])),
            ]
        )
        pipelines.append(pipeline)
        return pipeline

    monkeypatch.setitem(
        sys.modules,
        "kokoro",
        SimpleNamespace(KModel=model_type, KPipeline=pipeline_factory),
    )
    tensor = object()
    load = Mock(return_value=tensor)
    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(
            load=load,
            backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
        ),
    )
    return SimpleNamespace(
        path=tmp_path,
        model=model,
        model_type=model_type,
        pipelines=pipelines,
        load=load,
        tensor=tensor,
    )


def test_engine_loads_once_and_reuses_pipelines_and_voices(fake_assets):
    value = engine.KokoroEngine()
    assert value.voices == {"af_heart": "a", "bf_emma": "b"}
    assert len(fake_assets.pipelines) == 2
    assert all(p.kwargs["model"] is fake_assets.model for p in fake_assets.pipelines)
    fake_assets.model_type.assert_called_once_with(
        repo_id=engine.REPO_ID,
        config=str(fake_assets.path / "config.json"),
        model=str(fake_assets.path / "kokoro-v1_0.pth"),
    )
    for _ in range(2):
        assert list(value.synthesize(request(speed=1.5))) == [
            to_pcm(np.array([0.5, -0.5]))
        ]
    fake_assets.load.assert_called_once_with(
        fake_assets.path / "voices/af_heart.pt", map_location="cpu", weights_only=True
    )
    fake_assets.pipelines[0].assert_called_with(
        "Hello.", voice=fake_assets.tensor, speed=1.5
    )
    list(value.synthesize(request(voice="bf_emma")))
    assert fake_assets.pipelines[1].call_count == 1
    assert fake_assets.load.call_count == 2
    value.warmup()


def test_engine_unknown_voice_never_loads_file(fake_assets):
    value = engine.KokoroEngine()
    with pytest.raises(engine.UnknownVoiceError):
        list(value.synthesize(request(voice="af_unknown")))
    fake_assets.load.assert_not_called()


@pytest.mark.parametrize("filename", ["config.json", "kokoro-v1_0.pth"])
def test_missing_weights_fail_before_loading(fake_assets, filename):
    (fake_assets.path / filename).unlink()
    with pytest.raises(engine.EngineSetupError, match="hf download"):
        engine.KokoroEngine()
    fake_assets.model_type.assert_not_called()


def test_no_english_voices(fake_assets):
    (fake_assets.path / "voices/af_heart.pt").unlink()
    (fake_assets.path / "voices/bf_emma.pt").unlink()
    with pytest.raises(engine.EngineSetupError, match="No cached English voices"):
        engine.KokoroEngine()


def test_unsupported_device():
    with pytest.raises(ValueError, match="auto, cpu, or mps"):
        engine.KokoroEngine(device="cuda")


def test_cache_lookup_is_offline(monkeypatch, tmp_path):
    download = Mock(return_value=str(tmp_path))
    monkeypatch.setattr("huggingface_hub.snapshot_download", download)
    assert engine.cached_snapshot() == tmp_path
    download.assert_called_once_with(engine.REPO_ID, local_files_only=True)


def test_missing_snapshot_help(monkeypatch):
    from huggingface_hub.errors import LocalEntryNotFoundError

    monkeypatch.setattr(
        "huggingface_hub.snapshot_download",
        Mock(side_effect=LocalEntryNotFoundError("missing")),
    )
    with pytest.raises(engine.EngineSetupError, match="hf download"):
        engine.cached_snapshot()


def test_missing_language_resource_does_not_download(monkeypatch):
    download = Mock()
    monkeypatch.setitem(
        sys.modules,
        "spacy",
        SimpleNamespace(
            util=SimpleNamespace(is_package=lambda name: False),
            cli=SimpleNamespace(download=download),
        ),
    )
    with pytest.raises(engine.EngineSetupError, match="spacy download"):
        engine.check_language_resources()
    download.assert_not_called()


def test_warmup_rejects_empty_audio(fake_assets):
    value = engine.KokoroEngine()
    fake_assets.pipelines[0].side_effect = lambda *args, **kwargs: iter([])
    with pytest.raises(engine.EngineSetupError, match="warm-up"):
        value.warmup()
