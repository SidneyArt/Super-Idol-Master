from pathlib import Path
from tempfile import TemporaryDirectory
import json
import unittest
from unittest.mock import patch

from comfy_client import (
    ComfyUIExecutionError,
    ComfyUIClient,
    execute_workflow,
)


class FakeClient(ComfyUIClient):
    def __init__(self, history_entry: dict | None = None, submit_prompt_id: str = "prompt-test"):
        super().__init__("http://fake.invalid")
        self._submitted = []
        self._history = history_entry
        self.submit_prompt_id = submit_prompt_id

    def submit(self, workflow: dict) -> str:
        self._submitted.append(workflow)
        return self.submit_prompt_id

    def wait_for_completion(self, prompt_id: str) -> dict:
        entry = self._history or {}
        status = entry.get("status", {})
        for message in status.get("messages", []):
            if isinstance(message, list) and message and message[0] == "execution_error":
                detail = message[1] if len(message) > 1 else message
                raise ComfyUIExecutionError(
                    f"ComfyUI execution error: {detail}", detail=detail
                ) from None
        return entry

    def download(self, artifact, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"fake")


def error_history(detail: dict) -> dict:
    return {
        "outputs": {},
        "status": {
            "status_str": "error",
            "completed": False,
            "messages": [["execution_error", detail]],
        },
    }


class ComfyClientErrorRunTests(unittest.TestCase):
    def test_execution_error_persists_failure_run(self):
        detail = {
            "node_type": "CLIPLoader",
            "exception_message": "params = layout_cls.Params(**scales...) failed",
            "exception_type": "RuntimeError",
            "traceback": ["comfy/ops.py:1108 in _load_quantized_module"],
        }
        client = FakeClient(history_entry=error_history(detail))
        workflow = {"mock": "workflow"}

        with TemporaryDirectory() as directory:
            root = Path(directory)
            with patch("comfy_client.OUTPUT_ROOT", root):
                with self.assertRaises(ComfyUIExecutionError):
                    execute_workflow(client, "2d", workflow)

            run_dirs = list(root.glob("2d/*"))
            self.assertEqual(len(run_dirs), 1, "failed run directory must be created")

            run_dir = run_dirs[0]
            submitted = json.loads((run_dir / "submitted_workflow.json").read_text(encoding="utf-8"))
            self.assertEqual(submitted, {"mock": "workflow"})

            error_file = json.loads((run_dir / "error.json").read_text(encoding="utf-8"))
            self.assertEqual(error_file["prompt_id"], "prompt-test")
            self.assertEqual(error_file["detail"]["node_type"], "CLIPLoader")
            self.assertIn("_load_quantized_module", error_file["detail"]["traceback"][0])

    def test_successful_run_still_creates_run_dir_with_no_error_file(self):
        client = FakeClient(
            history_entry={
                "outputs": {},
                "status": {"status_str": "success", "completed": True, "messages": []},
            }
        )
        workflow = {"mock": "workflow"}

        with TemporaryDirectory() as directory:
            root = Path(directory)
            with patch("comfy_client.OUTPUT_ROOT", root):
                result = execute_workflow(client, "2d", workflow)

            submitted = json.loads(
                (result.run_dir / "submitted_workflow.json").read_text(encoding="utf-8")
            )
            self.assertEqual(submitted, {"mock": "workflow"})
            self.assertTrue((result.run_dir / "history.json").is_file())
            self.assertFalse((result.run_dir / "error.json").exists())


if __name__ == "__main__":
    unittest.main()