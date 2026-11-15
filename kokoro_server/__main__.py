"""Command-line entry point for the local speech server."""

import argparse
import os


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Serve cached Kokoro speech on localhost"
    )
    parser.add_argument(
        "--host", choices=("127.0.0.1", "localhost"), default="127.0.0.1"
    )
    parser.add_argument("--port", type=int, default=8880)
    parser.add_argument("--device", choices=("cpu",), default="cpu")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    api_key = os.environ.get("KOKORO_API_KEY", "")
    if not api_key.strip():
        parser.error(
            "Set KOKORO_API_KEY to a local shared token before starting the server"
        )

    import uvicorn

    from .app import create_app

    app = create_app(api_key)
    uvicorn.run(app, host=args.host, port=args.port, workers=1, reload=False)


if __name__ == "__main__":
    main()
