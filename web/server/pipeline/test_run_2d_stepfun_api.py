from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from run_2d_stepfun_api import (
    endpoint_for,
    request_with_content_retry,
    safe_semantic_rewrite,
    submit_request,
    validate_model_usage,
)


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self.ok = status_code < 400
        self._payload = payload
        self.text = ""

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, responses=None):
        self.responses = list(responses or [])
        self.calls = []

    def post(self, endpoint, **kwargs):
        self.calls.append((endpoint, kwargs))
        return self.responses.pop(0) if self.responses else FakeResponse(200, {"data": []})


class StepFunImageApiTests(unittest.TestCase):
    def test_text_generation_uses_generation_endpoint_and_json(self):
        session = FakeSession()
        endpoint = endpoint_for("https://api.stepfun.com/step_plan/v1", "generation")

        submit_request(
            session,
            endpoint=endpoint,
            api_key="secret",
            model="step-image-edit-2",
            prompt="三个虚构游戏角色",
            negative_prompt="文字",
            source_path=None,
        )

        called_endpoint, kwargs = session.calls[0]
        self.assertEqual(called_endpoint, "https://api.stepfun.com/step_plan/v1/images/generations")
        self.assertIn("json", kwargs)
        self.assertNotIn("files", kwargs)

    def test_edit_uses_edit_endpoint_and_multipart(self):
        session = FakeSession()
        with TemporaryDirectory() as directory:
            image_path = Path(directory) / "source.png"
            image_path.write_bytes(b"test")
            submit_request(
                session,
                endpoint=endpoint_for("https://api.stepfun.com/v1", "edit"),
                api_key="secret",
                model="step-image-edit-2",
                prompt="修改服装配色",
                negative_prompt="文字",
                source_path=image_path,
            )

        called_endpoint, kwargs = session.calls[0]
        self.assertEqual(called_endpoint, "https://api.stepfun.com/v1/images/edits")
        self.assertIn("files", kwargs)
        self.assertIn("data", kwargs)
        self.assertNotIn("json", kwargs)

    def test_step_plan_rejects_unsupported_model_before_request(self):
        with self.assertRaisesRegex(RuntimeError, "只支持 step-image-edit-2"):
            validate_model_usage(
                "https://api.stepfun.com/step_plan/v1",
                "step-2x-large",
                "generation",
            )

    def test_safe_rewrite_preserves_goal_but_removes_risky_role_wording(self):
        rewritten = safe_semantic_rewrite("三名角色：刺客、法师、战士，刺客携带匕首")
        self.assertIn("全年龄虚构游戏角色", rewritten)
        self.assertIn("潜行侦察员", rewritten)
        self.assertNotIn("刺客", rewritten)

    def test_content_block_is_retried_exactly_once_with_safe_prompt(self):
        session = FakeSession([
            FakeResponse(451, {"error": {"message": "The content you provided or machine outputted is blocked."}}),
            FakeResponse(200, {"data": [{"finish_reason": "success", "b64_json": "ok"}]}),
        ])

        payload = request_with_content_retry(
            session,
            endpoint="https://api.stepfun.com/step_plan/v1/images/generations",
            api_key="secret",
            model="step-image-edit-2",
            prompt="刺客、法师与战士的虚构角色合集",
            negative_prompt="血腥",
            source_path=None,
        )

        self.assertEqual(payload["data"][0]["finish_reason"], "success")
        self.assertEqual(len(session.calls), 2)
        retry_body = session.calls[1][1]["json"]
        self.assertNotIn("刺客", retry_body["prompt"])
        self.assertEqual(retry_body["negative_prompt"], "低画质，重复角色，角色重叠，裁切，文字，水印，风格不一致")

    def test_second_content_block_returns_clear_error_without_more_retries(self):
        blocked = {"error": {"message": "The content you provided or machine outputted is blocked."}}
        session = FakeSession([FakeResponse(451, blocked), FakeResponse(451, blocked)])

        with self.assertRaisesRegex(RuntimeError, "一次全年龄安全语义改写重试均未通过"):
            request_with_content_retry(
                session,
                endpoint="https://api.stepfun.com/step_plan/v1/images/generations",
                api_key="secret",
                model="step-image-edit-2",
                prompt="刺客角色",
                negative_prompt="",
                source_path=None,
            )

        self.assertEqual(len(session.calls), 2)

    def test_success_response_with_content_filtered_finish_reason_is_retried(self):
        session = FakeSession([
            FakeResponse(200, {"data": [{"finish_reason": "content_filtered"}]}),
            FakeResponse(200, {"data": [{"finish_reason": "success", "b64_json": "ok"}]}),
        ])

        request_with_content_retry(
            session,
            endpoint="https://api.stepfun.com/step_plan/v1/images/generations",
            api_key="secret",
            model="step-image-edit-2",
            prompt="虚构游戏角色合集",
            negative_prompt="",
            source_path=None,
        )

        self.assertEqual(len(session.calls), 2)


if __name__ == "__main__":
    unittest.main()
