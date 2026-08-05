from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch

from run_3d_retopology import response_error_detail, run_retopology, service_endpoint, topology_session


MINIMAL_GLB = b"glTF" + b"\x02\x00\x00\x00" + b"\x14\x00\x00\x00" + b"\x00" * 8


class FakeResponse:
    ok = True
    status_code = 200
    text = ""

    def iter_content(self, _chunk_size: int):
        yield MINIMAL_GLB


class FakeErrorResponse:
    ok = False
    status_code = 500
    text = '{"error":"automatic retopology failed"}'

    def json(self):
        return {"error": "automatic retopology failed"}


class FakeGatewayResponse:
    ok = False
    status_code = 502
    text = ""

    def json(self):
        raise ValueError("not JSON")

    def close(self):
        pass


class RetopologyClientTests(unittest.TestCase):
    def test_service_endpoint_appends_route_once(self):
        self.assertEqual(service_endpoint("http://dgx:8190"), "http://dgx:8190/v1/remesh")
        self.assertEqual(service_endpoint("http://dgx:8190/v1/remesh"), "http://dgx:8190/v1/remesh")

    def test_run_retopology_streams_and_validates_glb(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.glb"
            source.write_bytes(MINIMAL_GLB)
            with patch("run_3d_retopology.requests.Session.post", return_value=FakeResponse()) as request:
                output = run_retopology(source, "http://dgx:8190", root / "output", 50_000, 60, "secret")
            self.assertEqual(output.read_bytes(), MINIMAL_GLB)
            self.assertEqual(request.call_args.kwargs["params"], {"target_quads": 50_000})
            self.assertEqual(request.call_args.kwargs["headers"]["Authorization"], "Bearer secret")

    def test_run_retopology_retries_a_transient_gateway_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.glb"
            source.write_bytes(MINIMAL_GLB)
            with patch(
                "run_3d_retopology.requests.Session.post",
                side_effect=[FakeGatewayResponse(), FakeResponse()],
            ) as request, patch("run_3d_retopology.time.sleep") as sleep:
                output = run_retopology(source, "http://dgx:8190", root / "output", 50_000, 60)
            self.assertEqual(output.read_bytes(), MINIMAL_GLB)
            self.assertEqual(request.call_count, 2)
            sleep.assert_called_once_with(1)

    def test_topology_session_ignores_environment_proxies(self):
        session = topology_session()
        try:
            self.assertFalse(session.trust_env)
        finally:
            session.close()

    def test_repeated_gateway_errors_fail_after_three_attempts_with_guidance(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.glb"
            source.write_bytes(MINIMAL_GLB)
            with patch(
                "run_3d_retopology.requests.Session.post",
                side_effect=[FakeGatewayResponse(), FakeGatewayResponse(), FakeGatewayResponse()],
            ) as request, patch("run_3d_retopology.time.sleep") as sleep:
                with self.assertRaisesRegex(RuntimeError, r"HTTP 502: empty response; verify.*healthz"):
                    run_retopology(source, "http://dgx:8190", root / "output", 50_000, 60)
            self.assertEqual(request.call_count, 3)
            self.assertEqual([call.args for call in sleep.call_args_list], [(1,), (2,)])

    def test_rejects_out_of_range_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source.glb"
            source.write_bytes(MINIMAL_GLB)
            with self.assertRaisesRegex(ValueError, "target-quads"):
                run_retopology(source, "http://dgx:8190", Path(temporary) / "output", 999, 60)

    def test_http_error_extracts_service_message_without_json_wrapper(self):
        self.assertEqual(
            response_error_detail(FakeErrorResponse()),
            "automatic retopology failed",
        )


if __name__ == "__main__":
    unittest.main()
