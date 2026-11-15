"""Synchronous, reusable Kokoro adapter. Its caller owns thread serialization."""

import re
from collections.abc import Iterator
from pathlib import Path

from .audio import to_pcm
from .schemas import SpeechRequest

REPO_ID = "hexgrad/Kokoro-82M"
VOICE_NAME = re.compile(r"[ab][fm]_[a-z0-9_]+")


class EngineSetupError(RuntimeError):
    """Local model or language assets are unavailable."""


class UnknownVoiceError(ValueError):
    """The requested voice isn't in the engine's local voice registry."""


def cached_snapshot() -> Path:
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import LocalEntryNotFoundError

    try:
        return Path(snapshot_download(REPO_ID, local_files_only=True))
    except LocalEntryNotFoundError as exc:
        raise EngineSetupError(
            f"Model cache missing. Run `hf download {REPO_ID}` before starting the server."
        ) from exc


def check_language_resources() -> None:
    import spacy

    if not spacy.util.is_package("en_core_web_sm"):
        raise EngineSetupError(
            "English language resource missing. Run "
            "`python -m spacy download en_core_web_sm` before starting the server."
        )


class KokoroEngine:
    """Load once on the inference thread, then call synthesize serially.

    ``voices`` maps available voice IDs to language codes (``a`` or ``b``).
    ``synthesize`` yields completed model chunks as 24 kHz mono PCM bytes.
    All assets are local; no downloads are attempted by the engine.
    """

    def __init__(self, device: str = "cpu"):
        if device != "cpu":
            raise ValueError("Only the tested CPU device is supported")
        snapshot = cached_snapshot()
        config = snapshot / "config.json"
        weights = snapshot / "kokoro-v1_0.pth"
        for path in (config, weights):
            if not path.is_file():
                raise EngineSetupError(
                    f"Missing {path.name}. Run `hf download {REPO_ID}` to complete the cache."
                )
        self._voice_paths = {
            path.stem: path
            for path in sorted((snapshot / "voices").glob("*.pt"))
            if VOICE_NAME.fullmatch(path.stem) and path.is_file()
        }
        if not self._voice_paths:
            raise EngineSetupError(
                f"No cached English voices. Run `hf download {REPO_ID}`."
            )
        check_language_resources()
        # Delay heavy imports until startup. Explicit paths prevent KModel downloads.
        from kokoro import KModel, KPipeline

        self.voices = {name: name[0] for name in self._voice_paths}
        self.model = (
            KModel(repo_id=REPO_ID, config=str(config), model=str(weights))
            .to(device)
            .eval()
        )
        self._pipelines = {
            language: KPipeline(lang_code=language, repo_id=REPO_ID, model=self.model)
            for language in sorted(set(self.voices.values()))
        }
        self._voice_tensors = {}

    def synthesize(self, request: SpeechRequest) -> Iterator[bytes]:
        if request.voice not in self.voices:
            raise UnknownVoiceError(f"Unknown or uncached voice: {request.voice}")
        if request.voice not in self._voice_tensors:
            import torch

            self._voice_tensors[request.voice] = torch.load(
                self._voice_paths[request.voice], map_location="cpu", weights_only=True
            )
        pipeline = self._pipelines[self.voices[request.voice]]
        for result in pipeline(
            request.input, voice=self._voice_tensors[request.voice], speed=request.speed
        ):
            if result.audio is not None:
                pcm = to_pcm(result.audio)
                if pcm:
                    yield pcm

    def warmup(self) -> None:
        voice = "af_heart" if "af_heart" in self.voices else next(iter(self.voices))
        generated_audio = False
        for pcm in self.synthesize(
            SpeechRequest(model="kokoro", input="Hello.", voice=voice)
        ):
            generated_audio = generated_audio or bool(pcm)
        if not generated_audio:
            raise EngineSetupError("Kokoro produced no audio during warm-up")
