import json
from pathlib import Path
import unittest


WORKFLOW_FILE = Path(__file__).with_name("3D_Gen_Pixal3D.json")


class Pixal3DWorkflowTests(unittest.TestCase):
    def test_conditioning_uses_full_pipeline_resolution(self):
        workflow = json.loads(WORKFLOW_FILE.read_text(encoding="utf-8"))

        crop = workflow["305"]["inputs"]

        self.assertEqual((crop["width"], crop["height"]), (1536, 1536))
        self.assertEqual(workflow["94"]["inputs"]["target_resolution"], "1536")
        self.assertEqual(workflow["288"]["inputs"]["value"], 4096)


if __name__ == "__main__":
    unittest.main()
