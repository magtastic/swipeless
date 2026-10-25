# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow>=11,<13"]
# ///
"""Prepare an approved publish payload with a local photo; never sends a request."""

import argparse
import base64
import io
import json
import os
from pathlib import Path

from PIL import Image, ImageOps

MAX_IMAGE_BYTES = 1024 * 1024


def attach_photo(profile_path: Path, photo_path: Path, output_path: Path) -> None:
    if output_path.resolve() in (profile_path.resolve(), photo_path.resolve()):
        raise ValueError("Output must be a new file, separate from the profile and photo")
    profile = json.loads(profile_path.read_text())
    if not isinstance(profile, dict):
        raise ValueError("Profile JSON must be an object")

    with Image.open(photo_path) as source:
        source.seek(0)
        oriented = ImageOps.exif_transpose(source)
        oriented.thumbnail((1600, 1600))
        rgba = oriented.convert("RGBA")
        # A fresh image discards source metadata, including EXIF location and comments.
        clean = Image.new("RGB", rgba.size, "white")
        clean.paste(rgba, mask=rgba.getchannel("A"))
        while True:
            encoded = io.BytesIO()
            clean.save(encoded, format="JPEG", quality=85, optimize=True)
            data = encoded.getvalue()
            if len(data) <= MAX_IMAGE_BYTES:
                break
            clean = clean.resize((max(1, clean.width * 3 // 4), max(1, clean.height * 3 // 4)))

    profile["photoUrl"] = (
        "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")
    )
    # Exclusive creation avoids overwriting a draft or following an existing symlink.
    descriptor = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(profile, output, ensure_ascii=False)
    print("Prepared private photo payload. Nothing has been uploaded.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--photo", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    attach_photo(args.profile.expanduser(), args.photo.expanduser(), args.output.expanduser())


if __name__ == "__main__":
    main()
