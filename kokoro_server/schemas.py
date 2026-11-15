"""The supported subset of OpenAI's speech request."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    model: Literal["kokoro"]
    input: str = Field(min_length=1, max_length=4096)
    voice: str = Field(pattern=r"^[ab][fm]_[a-z0-9_]+$")
    response_format: Literal["pcm", "wav"] = "wav"
    speed: float = Field(default=1.0, ge=0.5, le=2.0, allow_inf_nan=False)
    stream_format: Literal["audio"] = "audio"

    @field_validator("input")
    @classmethod
    def nonblank_input(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("input must contain non-whitespace text")
        return value
