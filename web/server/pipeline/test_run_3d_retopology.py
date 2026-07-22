from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from run_3d_retopology import run_retopology, service_endpoint


MINIMAL_GLB = b"glTF" + b"\x02\x00\x00\x00" + b"\x14\x00\x00\x00" + b"\x00" * 8


class FakeResponse:
    ok = True
    status_code = 200
    text = ""

    def iter_content(self, _chunk_size: int):
        yield MINIMAL_GLB


class RetopologyClientTests(unittest.TestCase):
    def test_service_endpoint_appends_route_once(self):
        self.assertEqual(service_endpoint("http://dgx:8190"), "http://dgx:8190/v1/remesh")
        self.assertEqual(service_endpoint("http://dgx:8190/v1/remesh"), "http://dgx:8190/v1/remesh")

    def test_run_retopology_streams_and_validates_glb(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.glb"
            source.write_bytes(MINIMAL_GLB)
            with patch("run_3d_retopology.requests.post", return_value=FakeResponse()) as request:
                output = run_retopology(source, "http://dgx:8190", root / "output", 50_000, 60, "secret")
            self.assertEqual(output.read_bytes(), MINIMAL_GLB)
            self.assertEqual(request.call_args.kwargs["params"], {"target_quads": 50_000})
            self.assertEqual(request.call_args.kwargs["headers"]["Authorization"], "Bearer secret")

    def test_rejects_out_of_range_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source.glb"
            source.write_bytes(MINIMAL_GLB)
            with self.assertRaisesRegex(ValueError, "target-quads"):
                run_retopology(source, "http://dgx:8190", Path(temporary) / "output", 999, 60)


if __name__ == "__main__":
    unittest.main()
