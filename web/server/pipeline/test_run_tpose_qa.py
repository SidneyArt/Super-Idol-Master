from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from PIL import Image

from run_tpose_qa import evaluate_background


class TposeBackgroundQaTests(unittest.TestCase):
    def test_pure_white_background_passes(self):
        with TemporaryDirectory() as directory:
            image_path = Path(directory) / "white.png"
            Image.new("RGB", (512, 512), (255, 255, 255)).save(image_path)

            result = evaluate_background(image_path)

            self.assertTrue(result["passed"])
            self.assertEqual(result["whiteBorderRatio"], 1.0)

    def test_gray_gradient_style_background_fails(self):
        with TemporaryDirectory() as directory:
            image_path = Path(directory) / "gray.png"
            image = Image.new("RGB", (512, 512))
            pixels = image.load()
            for y in range(image.height):
                shade = 235 - round(35 * y / image.height)
                for x in range(image.width):
                    pixels[x, y] = (shade, shade, min(255, shade + 5))
            image.save(image_path)

            result = evaluate_background(image_path)

            self.assertFalse(result["passed"])
            self.assertLess(result["whiteBorderRatio"], 0.96)


if __name__ == "__main__":
    unittest.main()
