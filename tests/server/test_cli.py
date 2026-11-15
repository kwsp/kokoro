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
    factory.assert_called_once_with("test-key")
    run.assert_called_once_with(
        app, host="127.0.0.1", port=8880, workers=1, reload=False
    )


def test_cli_requires_token(monkeypatch, capsys):
    monkeypatch.delenv("KOKORO_API_KEY", raising=False)
    with pytest.raises(SystemExit) as error:
        main([])
    assert error.value.code == 2
    assert "KOKORO_API_KEY" in capsys.readouterr().err


@pytest.mark.parametrize(
    "args",
    [["--port", "0"], ["--port", "65536"], ["--host", "0.0.0.0"], ["--device", "mps"]],
)
def test_invalid_cli_options(args, monkeypatch):
    monkeypatch.setenv("KOKORO_API_KEY", "key")
    with pytest.raises(SystemExit):
        main(args)
