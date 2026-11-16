"""Command-line entry point for the local speech server."""

import argparse
import os
from functools import partial


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Serve cached Kokoro speech on localhost or a trusted LAN"
    )
    parser.add_argument(
        "--host", choices=("127.0.0.1", "localhost", "0.0.0.0"), default="127.0.0.1"
    )
    parser.add_argument(
        "--allowed-host",
        help="server address clients use; required with --host 0.0.0.0",
    )
    parser.add_argument("--port", type=int, default=8880)
    parser.add_argument(
        "--device",
        choices=("auto", "cpu", "mps"),
        default="auto",
        help="auto prefers Apple Silicon MPS when available, otherwise CPU",
    )
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    if args.host == "0.0.0.0" and not args.allowed_host:
        parser.error("--allowed-host is required with --host 0.0.0.0")
    if args.allowed_host and (
        not args.allowed_host.strip()
        or any(character in args.allowed_host for character in "/:@*? #")
    ):
        parser.error("--allowed-host must be a hostname or IP address without a port")
    api_key = os.environ.get("KOKORO_API_KEY", "")
    if not api_key.strip():
        parser.error("Set KOKORO_API_KEY to a shared token before starting the server")

    import uvicorn

    from .app import create_app
    from .engine import KokoroEngine

    allowed_hosts = ("127.0.0.1", "localhost", "[::1]")
    if args.allowed_host:
        allowed_hosts += (args.allowed_host,)
    app = create_app(
        api_key,
        engine_factory=partial(KokoroEngine, device=args.device),
        allowed_hosts=allowed_hosts,
    )
    uvicorn.run(app, host=args.host, port=args.port, workers=1, reload=False)


if __name__ == "__main__":
    main()
