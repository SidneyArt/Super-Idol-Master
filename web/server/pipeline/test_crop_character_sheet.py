import unittest

from crop_character_sheet import safe_box


class CharacterSheetCropTests(unittest.TestCase):
    def test_three_character_lane_expands_to_preserve_wide_equipment(self):
        left, top, right, bottom = safe_box(
            {"x": 0.02, "y": 0.05, "width": 0.32, "height": 0.90},
            1024,
            1024,
            3,
        )

        self.assertEqual(left, 0)
        self.assertGreaterEqual(right, 500)
        self.assertEqual(top, 0)
        self.assertEqual(bottom, 1024)

    def test_middle_character_keeps_context_on_both_sides(self):
        left, _, right, _ = safe_box(
            {"x": 0.33, "y": 0.08, "width": 0.30, "height": 0.87},
            1024,
            1024,
            3,
        )

        self.assertLessEqual(left, 230)
        self.assertGreaterEqual(right, 750)

    def test_right_edge_character_stays_inside_canvas(self):
        left, _, right, _ = safe_box(
            {"x": 0.63, "y": 0.08, "width": 0.35, "height": 0.90},
            1024,
            1024,
            3,
        )

        self.assertLessEqual(left, 520)
        self.assertEqual(right, 1024)


if __name__ == "__main__":
    unittest.main()
