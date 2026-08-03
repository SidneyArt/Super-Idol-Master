from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from PIL import Image, ImageDraw

from run_tpose_qa import evaluate_background, evaluate_pose


def pose_payload(*, wrist_drop=0):
    points = [
        (500, 100, 0.99), (500, 200, 0.99),
        (450, 220, 0.99), (320, 220, 0.99), (180, 220 + wrist_drop, 0.99),
        (550, 220, 0.99), (680, 220, 0.99), (820, 220 + wrist_drop, 0.99),
        (460, 500, 0.99), (460, 680, 0.99), (460, 850, 0.99),
        (540, 500, 0.99), (540, 680, 0.99), (540, 850, 0.99),
    ]
    return [{
        "canvas_width": 1000,
        "canvas_height": 1000,
        "people": [{"pose_keypoints_2d": [value for point in points for value in point]}],
    }]


def draw_white_cow(image):
    draw = ImageDraw.Draw(image)
    draw.rectangle((55, 190, 457, 235), fill=(235, 235, 230))
    draw.ellipse((145, 80, 367, 470), fill=(225, 223, 216))
    draw.ellipse((210, 115, 302, 220), fill=(70, 55, 48))
    draw.rectangle((55, 190, 105, 235), fill=(25, 25, 23))
    draw.rectangle((407, 190, 457, 235), fill=(25, 25, 23))
    draw.ellipse((170, 250, 230, 330), fill=(30, 30, 28))
    draw.ellipse((285, 335, 345, 420), fill=(35, 35, 32))
    draw.rectangle((175, 430, 225, 475), fill=(20, 20, 18))
    draw.rectangle((287, 430, 337, 475), fill=(20, 20, 18))


def tpose_keypoints_256():
    return {
        "nose": [128, 45, 0.99], "neck": [128, 75, 0.99],
        "rightShoulder": [105, 95, 0.99], "rightElbow": [65, 95, 0.99], "rightWrist": [25, 95, 0.99],
        "leftShoulder": [151, 95, 0.99], "leftElbow": [191, 95, 0.99], "leftWrist": [231, 95, 0.99],
        "rightHip": [115, 155, 0.99], "rightKnee": [115, 188, 0.99], "rightAnkle": [115, 220, 0.99],
        "leftHip": [141, 155, 0.99], "leftKnee": [141, 188, 0.99], "leftAnkle": [141, 220, 0.99],
    }


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

    def test_white_outer_border_does_not_hide_cream_inner_background(self):
        with TemporaryDirectory() as directory:
            image_path = Path(directory) / "cream-center.png"
            image = Image.new("RGB", (512, 512), (255, 255, 255))
            pixels = image.load()
            for y in range(48, 464):
                for x in range(48, 464):
                    pixels[x, y] = (248, 242, 226)
            image.save(image_path)

            result = evaluate_background(image_path)

            self.assertFalse(result["passed"])
            self.assertEqual(result["whiteBorderRatio"], 1.0)
            self.assertLess(result["connectedBackgroundWhiteRatio"], 0.94)

    def test_white_character_shading_is_not_counted_as_background(self):
        with TemporaryDirectory() as directory:
            image_path = Path(directory) / "white-cow.png"
            image = Image.new("RGB", (512, 512), (255, 255, 255))
            # The light arms visually meet the white background. Dark hands,
            # feet, face, and spots provide reliable foreground anchors.
            draw_white_cow(image)
            image.save(image_path)

            result = evaluate_background(image_path)

            self.assertTrue(result["passed"])
            self.assertTrue(result["foregroundMaskApplied"])
            self.assertGreaterEqual(result["connectedBackgroundWhiteRatio"], 0.94)

    def test_foreground_mask_does_not_hide_cream_background(self):
        with TemporaryDirectory() as directory:
            image_path = Path(directory) / "cow-on-cream.png"
            image = Image.new("RGB", (512, 512), (255, 255, 255))
            ImageDraw.Draw(image).rectangle((48, 48, 464, 464), fill=(248, 242, 226))
            draw_white_cow(image)
            image.save(image_path)

            result = evaluate_background(image_path)

            self.assertFalse(result["passed"])
            self.assertTrue(result["foregroundMaskApplied"])
            self.assertLess(result["connectedBackgroundWhiteRatio"], 0.94)

    def test_foreground_mask_does_not_hide_ground_shadow(self):
        with TemporaryDirectory() as directory:
            image_path = Path(directory) / "cow-with-shadow.png"
            image = Image.new("RGB", (512, 512), (255, 255, 255))
            draw_white_cow(image)
            ImageDraw.Draw(image).ellipse((120, 420, 392, 465), fill=(205, 205, 205))
            image.save(image_path)

            result = evaluate_background(image_path)

            self.assertFalse(result["passed"])
            self.assertTrue(result["wideGroundShadowDetected"])

    def test_pose_mask_counts_narrow_dark_shadow_as_background(self):
        with TemporaryDirectory() as directory:
            image_path = Path(directory) / "tpose-with-narrow-shadow.png"
            image = Image.new("RGB", (256, 256), (255, 255, 255))
            draw = ImageDraw.Draw(image)
            draw.line(((25, 95), (128, 95), (231, 95)), fill=(35, 45, 55), width=18)
            draw.rectangle((105, 70, 151, 160), fill=(35, 45, 55))
            draw.line(((115, 155), (115, 220)), fill=(35, 45, 55), width=14)
            draw.line(((141, 155), (141, 220)), fill=(35, 45, 55), width=14)
            draw.ellipse((92, 218, 164, 238), fill=(120, 120, 120))
            image.save(image_path)

            result = evaluate_background(image_path, {"poseKeypoints": tpose_keypoints_256()})

            self.assertFalse(result["passed"])
            self.assertTrue(result["poseForegroundMaskApplied"])
            self.assertGreater(result["poseGroundArtifactRatio"], 0.01)


class TposePoseQaTests(unittest.TestCase):
    def test_strict_horizontal_tpose_passes(self):
        result = evaluate_pose(pose_payload())

        self.assertTrue(result["passed"])
        self.assertEqual(result["metrics"]["armHorizontalError"], 0.0)

    def test_visibly_downward_sloping_arms_fail(self):
        result = evaluate_pose(pose_payload(wrist_drop=20))

        self.assertFalse(result["passed"])
        self.assertIn("双臂不够水平", result["summary"])
        self.assertGreater(result["metrics"]["armHorizontalError"], 0.19)

    def test_complete_stylized_character_does_not_need_human_body_coverage(self):
        points = [
            (500, 350, 0.99), (500, 420, 0.99),
            (450, 460, 0.99), (320, 460, 0.99), (180, 460, 0.99),
            (550, 460, 0.99), (680, 460, 0.99), (820, 460, 0.99),
            (460, 650, 0.99), (460, 760, 0.99), (460, 840, 0.99),
            (540, 650, 0.99), (540, 760, 0.99), (540, 840, 0.99),
        ]
        payload = [{
            "canvas_width": 1000,
            "canvas_height": 1000,
            "people": [{"pose_keypoints_2d": [value for point in points for value in point]}],
        }]

        result = evaluate_pose(payload)

        self.assertTrue(result["passed"])
        self.assertLess(result["metrics"]["bodyCoverage"], 0.55)
        self.assertTrue(result["metrics"]["fullBody"])


if __name__ == "__main__":
    unittest.main()
