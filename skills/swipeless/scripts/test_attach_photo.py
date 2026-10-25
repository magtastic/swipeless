import base64
import io
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

from attach_photo import attach_photo, MAX_IMAGE_BYTES


class PhotoUploadTest(unittest.TestCase):
    def test_prepares_private_payload_without_changing_original(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = root / "profile.json"
            photo = root / "photo.png"
            output = root / "publish.json"
            original = {"brief": "Approved brief", "email": "example@example.com",
                        "firstName": "Test", "privateLayer": {"phone": "+3548221234"}}
            profile.write_text(json.dumps(original))
            source = Image.new("RGB", (2200, 1700), "blue")
            exif = Image.Exif()
            exif[270] = "Private image metadata"
            source.save(photo, exif=exif)
            original_bytes = photo.read_bytes()
            attach_photo(profile, photo, output)
            result = json.loads(output.read_text())
            data_uri = result.pop("photoUrl")
            self.assertEqual(result, original)
            self.assertEqual(photo.read_bytes(), original_bytes)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertTrue(data_uri.startswith("data:image/jpeg;base64,"))
            data = base64.b64decode(data_uri.split(",", 1)[1], validate=True)
            self.assertLessEqual(len(data), MAX_IMAGE_BYTES)
            with Image.open(io.BytesIO(data)) as encoded:
                self.assertLessEqual(max(encoded.size), 1600)
                self.assertFalse(encoded.getexif())
                encoded.verify()
            with self.assertRaises(FileExistsError):
                attach_photo(profile, photo, output)

    def test_rejects_non_images_without_creating_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = root / "profile.json"
            photo = root / "fake.jpg"
            output = root / "publish.json"
            profile.write_text('{"firstName": "Test"}')
            photo.write_text("not an image")
            with self.assertRaises(OSError):
                attach_photo(profile, photo, output)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
