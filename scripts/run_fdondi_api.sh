#!/bin/sh
# Starts the leash (backend-fdondi) decision API pointed at the shared resource/data pack.
cd "$(dirname "$0")/../backend-fdondi" || exit 1
export LEASH_DATA="$(cd .. && pwd)/resource/data"
exec uv run leash api --host 127.0.0.1 --port 8003
