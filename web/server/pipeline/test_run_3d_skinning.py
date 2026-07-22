from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from comfy_client import RemoteArtifact
from run_3d_skinning import resolve_server_mesh_path


class FakeClient:
    def __init__(self):
        self.uploads = []

    def upload_file(self, file_path: Path, remote_name: str | None = None) -> RemoteArtifact:
        self.uploads.append((file_path, remote_name))
        return RemoteArtifact("upload", remote_name or file_path.name, file_type="input")


class SkinningInputTests(unittest.TestCase):
    def test_same_local_basename_gets_unique_remote_paths(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first" / "retopologized.glb"
            second = root / "second" / "retopologized.glb"
            first.parent.mkdir()
            second.parent.mkdir()
            first.write_bytes(b"first")
            second.write_bytes(b"second")
            client = FakeClient()

            first_remote = resolve_server_mesh_path(client, str(first), "/comfy")
            second_remote = resolve_server_mesh_path(client, str(second), "/comfy")

            self.assertNotEqual(first_remote, second_remote)
            self.assertTrue(first_remote.startswith("/comfy/input/skin-input-"))
            self.assertTrue(first_remote.endswith(".glb"))
            self.assertNotEqual(client.uploads[0][1], client.uploads[1][1])

    def test_absolute_server_path_is_not_reuploaded(self):
        client = FakeClient()

        result = resolve_server_mesh_path(client, "/comfy/output/existing.glb", "/comfy")

        self.assertEqual(result, "/comfy/output/existing.glb")
        self.assertEqual(client.uploads, [])


if __name__ == "__main__":
    unittest.main()
