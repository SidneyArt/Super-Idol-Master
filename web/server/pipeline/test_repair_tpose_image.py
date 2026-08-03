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

    def test_stale_background_failure_is_rechecked_without_whitening_white_fur(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "white-cow.png"
            image = Image.new("RGB", (256, 256), (255, 255, 255))
            draw = ImageDraw.Draw(image)
            draw.ellipse((70, 35, 186, 225), fill=(225, 223, 216))
            draw.ellipse((100, 70, 145, 130), fill=(25, 25, 25))
            draw.ellipse((70, 115, 82, 130), fill=(25, 25, 25))
            draw.ellipse((174, 115, 186, 130), fill=(25, 25, 25))
            draw.rectangle((82, 212, 95, 225), fill=(25, 25, 25))
            draw.rectangle((161, 212, 174, 225), fill=(25, 25, 25))
            image.save(source)

            result = repair_tpose_image(
                source,
                {
                    "personCount": 1,
                    "minConfidence": 0.9,
                    "backgroundPassed": False,
                    "borderMeanRgb": [255, 255, 255],
                    "bodyCoverage": 0.55,
                    "armHorizontalError": 0.1,
                    "rightElbowAngle": 176,
                    "leftElbowAngle": 176,
                    "shoulderTilt": 0.02,
                },
                Path(directory) / "output",
            )

            self.assertTrue(result["applied"])
            self.assertEqual(result["strategy"], "deterministic_recheck")
            self.assertEqual(result["actions"], ["qa_recheck"])
            with Image.open(result["outputPath"]) as repaired:
                self.assertEqual(repaired.getpixel((90, 128)), (225, 223, 216))

    def test_light_character_details_make_background_matting_fail_closed(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "white-character-on-cream.png"
            image = Image.new("RGB", (256, 256), (248, 242, 226))
            draw = ImageDraw.Draw(image)
            draw.rectangle((80, 35, 176, 225), fill=(225, 223, 216))
            draw.rectangle((110, 90, 145, 145), fill=(25, 25, 25))
            image.save(source)

            result = repair_tpose_image(
                source,
                {
                    "backgroundPassed": False,
                    "borderMeanRgb": [248, 242, 226],
                    "foregroundBounds": [80, 35, 176, 225],
                    "fullBody": True,
                    "keypointsWithinCanvas": True,
                    "armHorizontalError": 0.03,
                    "rightElbowAngle": 176,
                    "leftElbowAngle": 177,
                    "shoulderTilt": 0.02,
                },
                Path(directory) / "output",
            )

            self.assertFalse(result["applied"])
            self.assertEqual(result["strategy"], "image_edit_model")

    def test_light_character_details_make_reframing_fail_closed(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "small-white-character.png"
            image = Image.new("RGB", (256, 256), (255, 255, 255))
            draw = ImageDraw.Draw(image)
            draw.rectangle((90, 70, 166, 190), fill=(225, 223, 216))
            draw.rectangle((115, 100, 140, 145), fill=(25, 25, 25))
            image.save(source)

            result = repair_tpose_image(
                source,
                {
                    "backgroundPassed": True,
                    "foregroundBounds": [90, 70, 166, 190],
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

            self.assertFalse(result["applied"])
            self.assertEqual(result["strategy"], "image_edit_model")

    def test_light_arms_make_deterministic_pose_transform_fail_closed(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "white-arms.png"
            image = Image.new("RGB", (256, 256), (255, 255, 255))
            draw = ImageDraw.Draw(image)
            draw.line(((105, 120), (65, 132), (25, 144)), fill=(225, 223, 216), width=18)
            draw.line(((151, 120), (191, 132), (231, 144)), fill=(225, 223, 216), width=18)
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

            self.assertFalse(result["applied"])
            self.assertEqual(result["strategy"], "image_edit_model")


if __name__ == "__main__":
    unittest.main()
