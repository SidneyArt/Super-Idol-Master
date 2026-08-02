from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from PIL import Image, ImageDraw

from repair_tpose_image import repair_tpose_image


class TposeImageRepairTests(unittest.TestCase):
    def test_light_neutral_background_is_deterministically_whitened(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "cream.png"
            image = Image.new("RGB", (256, 256), (248, 242, 226))
            ImageDraw.Draw(image).rectangle((92, 38, 164, 224), fill=(80, 60, 45))
            image.save(source)

            result = repair_tpose_image(
                source,
                {
                    "backgroundPassed": False,
                    "borderMeanRgb": [248, 242, 226],
                    "foregroundBounds": [92, 38, 164, 224],
                    "fullBody": True,
                    "keypointsWithinCanvas": True,
                    "armHorizontalError": 0.03,
                    "rightElbowAngle": 176,
                    "leftElbowAngle": 177,
                    "shoulderTilt": 0.02,
                },
                Path(directory) / "output",
            )

            self.assertTrue(result["applied"])
            self.assertEqual(result["strategy"], "deterministic_background")
            self.assertIn("background_matting", result["actions"])
            with Image.open(result["outputPath"]) as repaired:
                self.assertEqual(repaired.getpixel((10, 10)), (255, 255, 255))
                self.assertEqual(repaired.getpixel((128, 128)), (80, 60, 45))

    def test_small_complete_character_is_deterministically_reframed(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "small.png"
            image = Image.new("RGB", (300, 300), (255, 255, 255))
            ImageDraw.Draw(image).rectangle((125, 100, 175, 205), fill=(30, 40, 50))
            image.save(source)

            result = repair_tpose_image(
                source,
                {
                    "backgroundPassed": True,
                    "foregroundBounds": [125, 100, 175, 205],
                    "fullBody": False,
                    "keypointsWithinCanvas": True,
                    "bodyCoverage": 0.35,
                    "armHorizontalError": 0.03,
                    "rightElbowAngle": 176,
                    "leftElbowAngle": 177,
                    "shoulderTilt": 0.02,
                },
                Path(directory) / "output",
            )

            self.assertTrue(result["applied"])
            self.assertEqual(result["strategy"], "deterministic_framing")
            self.assertIn("reframe", result["actions"])
            with Image.open(result["outputPath"]) as repaired:
                foreground = repaired.convert("RGB").getbbox()
                dark_rows = [
                    y
                    for y in range(repaired.height)
                    if any(min(repaired.getpixel((x, y))) < 100 for x in range(repaired.width))
                ]
                self.assertIsNotNone(foreground)
                self.assertGreater(max(dark_rows) - min(dark_rows), 180)

    def test_small_straight_arm_slope_is_deterministically_rotated(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "sloped-arms.png"
            image = Image.new("RGB", (256, 256), (255, 255, 255))
            draw = ImageDraw.Draw(image)
            draw.rectangle((106, 90, 150, 220), fill=(80, 60, 45))
            draw.line(((105, 120), (65, 132), (25, 144)), fill=(30, 30, 30), width=12)
            draw.line(((151, 120), (191, 132), (231, 144)), fill=(30, 30, 30), width=12)
            image.save(source)

            result = repair_tpose_image(
                source,
                {
                    "backgroundPassed": True,
                    "fullBody": True,
                    "keypointsWithinCanvas": True,
                    "armHorizontalError": 0.27,
                    "rightElbowAngle": 178,
                    "leftElbowAngle": 178,
                    "shoulderTilt": 0.0,
                    "poseKeypoints": {
                        "rightShoulder": [105, 120, 0.99],
                        "rightElbow": [65, 132, 0.99],
                        "rightWrist": [25, 144, 0.99],
                        "leftShoulder": [151, 120, 0.99],
                        "leftElbow": [191, 132, 0.99],
                        "leftWrist": [231, 144, 0.99],
                    },
                },
                Path(directory) / "output",
            )

            self.assertTrue(result["applied"])
            self.assertEqual(result["strategy"], "deterministic_pose")
            self.assertIn("straighten_arms", result["actions"])
            with Image.open(result["outputPath"]) as repaired:
                self.assertLess(min(repaired.getpixel((x, 120))[0] for x in range(25, 232)), 100)
                self.assertGreater(repaired.getpixel((25, 144))[0], 240)

    def test_severe_or_bent_arm_failure_routes_to_image_edit_model(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "bent.png"
            Image.new("RGB", (256, 256), (255, 255, 255)).save(source)

            result = repair_tpose_image(
                source,
                {
                    "backgroundPassed": True,
                    "fullBody": True,
                    "armHorizontalError": 0.48,
                    "rightElbowAngle": 132,
                    "leftElbowAngle": 176,
                    "shoulderTilt": 0.02,
                },
                Path(directory) / "output",
            )

            self.assertFalse(result["applied"])
            self.assertEqual(result["strategy"], "image_edit_model")
            self.assertIsNone(result["outputPath"])


if __name__ == "__main__":
    unittest.main()
