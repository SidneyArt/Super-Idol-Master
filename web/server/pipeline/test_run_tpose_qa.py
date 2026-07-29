from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from PIL import Image

from run_tpose_qa import evaluate_background, evaluate_pose


def pose_payload(*, wrist_drop=0, confidence=0.99):
    points = [
        (500, 100, confidence), (500, 200, confidence),
        (450, 220, confidence), (320, 220, confidence), (180, 220 + wrist_drop, confidence),
        (550, 220, confidence), (680, 220, confidence), (820, 220 + wrist_drop, confidence),
        (460, 500, confidence), (460, 680, confidence), (460, 850, confidence),
        (540, 500, confidence), (540, 680, confidence), (540, 850, confidence),
    ]
    return [{
        "canvas_width": 1000,
        "canvas_height": 1000,
        "people": [{"pose_keypoints_2d": [value for point in points for value in point]}],
    }]


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


class TposePoseQaTests(unittest.TestCase):
    def test_strict_horizontal_tpose_passes(self):
        result = evaluate_pose(pose_payload())

        self.assertTrue(result["passed"])
        self.assertEqual(result["metrics"]["armHorizontalError"], 0.0)

    def test_score_of_exactly_75_passes_even_when_an_old_hard_gate_fails(self):
        result = evaluate_pose(pose_payload(wrist_drop=20, confidence=0.1875))

        self.assertTrue(result["passed"])
        self.assertEqual(result["score"], 75)
        self.assertGreater(result["metrics"]["armHorizontalError"], 0.12)

    def test_score_below_75_fails(self):
        result = evaluate_pose(pose_payload(wrist_drop=20, confidence=0.175))

        self.assertFalse(result["passed"])
        self.assertEqual(result["score"], 74)


if __name__ == "__main__":
    unittest.main()
