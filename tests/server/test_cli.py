from unittest.mock import Mock

import pytest

from kokoro_server.__main__ import main


def test_cli_uses_token_and_single_loopback_worker(monkeypatch):
    monkeypatch.setenv("KOKORO_API_KEY", "test-key")
    app = object()
    factory = Mock(return_value=app)
    run = Mock()
    monkeypatch.setattr("kokoro_server.app.create_app", factory)
    monkeypatch.setattr("uvicorn.run", run)
    main([])
    factory.assert_called_once()
    assert factory.call_args.args == ("test-key",)
    assert factory.call_args.kwargs["engine_factory"].keywords == {"device": "auto"}
    assert factory.call_args.kwargs["allowed_hosts"] == (
        "127.0.0.1",
        "localhost",
        "[::1]",
    )
    run.assert_called_once_with(
        app, host="127.0.0.1", port=8880, workers=1, reload=False
    )


def test_cli_requires_token(monkeypatch, capsys):
    monkeypatch.delenv("KOKORO_API_KEY", raising=False)
    with pytest.raises(SystemExit) as error:
        main([])
    assert error.value.code == 2
    assert "KOKORO_API_KEY" in capsys.readouterr().err


def test_cli_allows_explicit_lan_host(monkeypatch):
    monkeypatch.setenv("KOKORO_API_KEY", "test-key")
    factory = Mock(return_value=object())
    run = Mock()
    monkeypatch.setattr("kokoro_server.app.create_app", factory)
    monkeypatch.setattr("uvicorn.run", run)
    main(["--host", "0.0.0.0", "--allowed-host", "192.168.1.42"])
    assert "192.168.1.42" in factory.call_args.kwargs["allowed_hosts"]
    assert run.call_args.kwargs["host"] == "0.0.0.0"


@pytest.mark.parametrize("device", ["cpu", "mps", "auto"])
def test_cli_passes_device_to_engine(monkeypatch, device):
    monkeypatch.setenv("KOKORO_API_KEY", "test-key")
    factory = Mock()
    model = Mock()
    monkeypatch.setattr("kokoro_server.app.create_app", factory)
    monkeypatch.setattr("kokoro_server.engine.KokoroEngine", model)
    monkeypatch.setattr("uvicorn.run", Mock())
    main(["--device", device])
    factory.call_args.kwargs["engine_factory"]()
    model.assert_called_once_with(device=device)


@pytest.mark.parametrize(
    "args",
    [
        ["--port", "0"],
        ["--port", "65536"],
        ["--host", "0.0.0.0"],
        ["--allowed-host", "example.com/path"],
        ["--device", "cuda"],
    ],
)
def test_invalid_cli_options(args, monkeypatch):
    monkeypatch.setenv("KOKORO_API_KEY", "key")
    with pytest.raises(SystemExit):
        main(args)
