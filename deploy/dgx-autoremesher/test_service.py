from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("service.py")
SPEC = importlib.util.spec_from_file_location("autoremesher_service", MODULE_PATH)
assert SPEC and SPEC.loader
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)


class CommandOutputTests(unittest.TestCase):
    def test_qt_stylesheet_and_progress_noise_is_removed(self) -> None:
        output = """QComboBox { color: #4a4a4a; }QPushButton { color: red; }
0% done.
Found repeated halfedge:110532,110537
double free or corruption (out)
Aborted (core dumped)
"""
        self.assertEqual(
            service.useful_command_output(output),
            "double free or corruption (out)\nAborted (core dumped)",
        )

    def test_native_abort_has_actionable_message(self) -> None:
        message = service.describe_command_failure(
            "automatic retopology",
            134,
            "double free or corruption (out)\nAborted (core dumped)",
        )
        self.assertIn("heap corruption", message)
        self.assertIn("TOPOLOGY_PREPROCESS_MAX_FACES", message)
        self.assertNotIn("QComboBox", message)

    def test_regular_failure_keeps_relevant_output(self) -> None:
        message = service.describe_command_failure("texture rebake", 1, "Blender failed")
        self.assertEqual(message, "texture rebake failed (exit 1).\nBlender failed")


if __name__ == "__main__":
    unittest.main()
