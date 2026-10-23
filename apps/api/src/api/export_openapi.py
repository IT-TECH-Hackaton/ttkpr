"""python -m api.export_openapi <path> — writes the OpenAPI schema for packages/api-client."""

import json
import sys
from pathlib import Path

from api.main import app


def main() -> None:
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "openapi.json")
    target.write_text(
        json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"OpenAPI written: {target}")


if __name__ == "__main__":
    main()
