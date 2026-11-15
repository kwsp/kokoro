import builtins
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from kokoro_server import engine


@pytest.mark.parametrize(
    "system,machine,available,requested,expected",
    [
        ("Darwin", "arm64", True, "auto", "mps"),
        ("Darwin", "arm64", False, "auto", "cpu"),
        ("Darwin", "x86_64", True, "auto", "cpu"),
        ("Linux", "aarch64", True, "auto", "cpu"),
        ("Windows", "AMD64", False, "auto", "cpu"),
        ("Darwin", "arm64", True, "cpu", "cpu"),
        ("Darwin", "arm64", True, "mps", "mps"),
    ],
)
def test_device_selection_and_fallback_before_torch_import(
    monkeypatch, system, machine, available, requested, expected
):
    monkeypatch.setattr(engine.platform, "system", lambda: system)
    monkeypatch.setattr(engine.platform, "machine", lambda: machine)
    monkeypatch.setenv("PYTORCH_ENABLE_MPS_FALLBACK", "0")
    probe = Mock(return_value=available)
    torch = SimpleNamespace(
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=probe))
    )
    real_import = builtins.__import__

    def import_module(name, *args, **kwargs):
        if name == "torch":
            assert engine.os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] == "1"
            return torch
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", import_module)
    assert engine.select_device(requested) == expected
    if requested == "cpu" or (
        requested == "auto" and (system, machine) != ("Darwin", "arm64")
    ):
        probe.assert_not_called()
        assert engine.os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] == "0"
    else:
        probe.assert_called_once()


def test_explicit_unavailable_mps_has_actionable_error(monkeypatch):
    monkeypatch.setenv("PYTORCH_ENABLE_MPS_FALLBACK", "0")
    torch = SimpleNamespace(
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False))
    )
    monkeypatch.setitem(sys.modules, "torch", torch)
    with pytest.raises(engine.EngineSetupError, match="--device cpu"):
        engine.select_device("mps")
