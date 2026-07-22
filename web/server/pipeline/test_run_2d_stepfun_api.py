from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from PIL import Image

from run_2d_stepfun_api import (
    MAX_PROMPT_CHARS,
    MIN_EDIT_ASPECT_RATIO,
    SAFE_TPOSE_NEGATIVE_PROMPT,
    TPOSE_CANVAS_SIZE,
    TPOSE_POSITIVE_CONSTRAINTS,
    endpoint_for,
    prepare_edit_source,
    prepare_tpose_source,
    prompt_with_required_constraints,
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
    def test_tall_edit_source_is_padded_into_supported_aspect_ratio(self):
        with TemporaryDirectory() as directory:
            source_path = Path(directory) / "too-tall.png"
            destination = Path(directory) / "accepted.png"
            Image.new("RGB", (310, 936), (255, 0, 0)).save(source_path)

            prepare_edit_source(source_path, destination)

            with Image.open(destination) as image:
                self.assertGreaterEqual(image.width / image.height, MIN_EDIT_ASPECT_RATIO)
                self.assertGreater(image.width, 310)
                self.assertEqual(image.getpixel((0, image.height // 2)), (255, 255, 255))
                self.assertEqual(image.getpixel((image.width // 2, image.height // 2)), (255, 0, 0))

    def test_tpose_source_is_square_with_safe_white_margin(self):
        with TemporaryDirectory() as directory:
            source_path = Path(directory) / "portrait.png"
            destination = Path(directory) / "square.png"
            Image.new("RGB", (240, 800), (255, 0, 0)).save(source_path)

            prepare_tpose_source(source_path, destination)

            with Image.open(destination) as image:
                self.assertEqual(image.size, (TPOSE_CANVAS_SIZE, TPOSE_CANVAS_SIZE))
                self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))
                self.assertEqual(image.getpixel((TPOSE_CANVAS_SIZE // 2, TPOSE_CANVAS_SIZE // 2)), (255, 0, 0))
                self.assertEqual(
                    image.getpixel((TPOSE_CANVAS_SIZE // 2, round(TPOSE_CANVAS_SIZE * 0.08))),
                    (255, 255, 255),
                )

    def test_tpose_constraints_survive_long_prompt_truncation(self):
        prompt = prompt_with_required_constraints("角色设定" * 300, TPOSE_POSITIVE_CONSTRAINTS, "正向提示词")

        self.assertLessEqual(len(prompt), MAX_PROMPT_CHARS)
        self.assertTrue(prompt.startswith(TPOSE_POSITIVE_CONSTRAINTS))
        self.assertIn("原始提示补充：", prompt)
        self.assertIn("左手腕、左肘、左肩、右肩、右肘、右手腕", prompt)
        self.assertIn("不得低于或高于肩关节", prompt)
        self.assertIn("不是A-Pose或V-Pose", prompt)
        self.assertIn("左右手", prompt)
        self.assertIn("完全空置", prompt)
        self.assertIn("所有手持物", prompt)
        self.assertIn("RGB(255,255,255)", prompt)
        self.assertIn("至少12%留白", prompt)

    def test_tpose_source_replaces_connected_cream_background_with_white(self):
        with TemporaryDirectory() as directory:
            source_path = Path(directory) / "cream.png"
            destination = Path(directory) / "white.png"
            image = Image.new("RGB", (400, 600), (248, 242, 226))
            for y in range(150, 500):
                for x in range(140, 260):
                    image.putpixel((x, y), (35, 70, 120))
            for y in range(200, 350):
                for x in range(0, 60):
                    image.putpixel((x, y), (225, 235, 245))
            image.save(source_path)

            prepare_tpose_source(source_path, destination)

            with Image.open(destination) as prepared:
                self.assertEqual(prepared.getpixel((prepared.width // 2, 250)), (255, 255, 255))
                self.assertEqual(prepared.getpixel((prepared.width // 2, prepared.height // 2)), (35, 70, 120))
                self.assertEqual(prepared.getpixel((320, 450)), (225, 235, 245))

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

    def test_tpose_content_retry_keeps_safe_pose_and_background_constraints(self):
        session = FakeSession([
            FakeResponse(451, {"error": {"message": "The content you provided or machine outputted is blocked."}}),
            FakeResponse(200, {"data": [{"finish_reason": "success", "b64_json": "ok"}]}),
        ])

        request_with_content_retry(
            session,
            endpoint="https://api.stepfun.com/v1/images/edits",
            api_key="secret",
            model="step-image-edit-2",
            prompt="严格 T-Pose 的刺客角色",
            negative_prompt="原始负向提示词",
            source_path=None,
            safe_negative_prompt=SAFE_TPOSE_NEGATIVE_PROMPT,
        )

        retry_body = session.calls[1][1]["json"]
        self.assertIn("双臂斜向下", retry_body["negative_prompt"])
        self.assertIn("手腕低于肩膀", retry_body["negative_prompt"])
        self.assertIn("米白背景", retry_body["negative_prompt"])

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
