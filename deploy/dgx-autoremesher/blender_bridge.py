"""Blender background bridge: GLB -> OBJ -> remeshed textured GLB."""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def import_obj(path: Path) -> None:
    if hasattr(bpy.ops.wm, "obj_import"):
        bpy.ops.wm.obj_import(filepath=str(path))
    else:
        bpy.ops.import_scene.obj(filepath=str(path))


def export_obj(path: Path) -> None:
    if hasattr(bpy.ops.wm, "obj_export"):
        bpy.ops.wm.obj_export(
            filepath=str(path), export_selected_objects=True,
            export_uv=False, export_normals=True, export_materials=False,
        )
    else:
        bpy.ops.export_scene.obj(
            filepath=str(path), use_selection=True,
            use_uvs=False, use_normals=True, use_materials=False,
        )


def mesh_objects() -> list[bpy.types.Object]:
    return [item for item in bpy.context.scene.objects if item.type == "MESH"]


def select_only(objects: list[bpy.types.Object], active: bpy.types.Object | None = None) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for item in objects:
        item.select_set(True)
    if active:
        bpy.context.view_layer.objects.active = active


def join_meshes(objects: list[bpy.types.Object]) -> bpy.types.Object:
    if not objects:
        raise RuntimeError("No mesh was found")
    select_only(objects, objects[0])
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(objects) > 1:
        bpy.ops.object.join()
    return bpy.context.view_layer.objects.active


def command_export_obj(args: argparse.Namespace) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.input))
    target = join_meshes(mesh_objects())
    select_only([target], target)
    export_obj(args.output)


def object_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [item.matrix_world @ Vector(corner) for item in objects for corner in item.bound_box]
    return (
        Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points))),
        Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points))),
    )


def bake_texture(source_objects: list[bpy.types.Object], target: bpy.types.Object, size: int, output_dir: Path) -> None:
    select_only([target], target)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")

    image = bpy.data.images.new("RetopologyBake", width=size, height=size, alpha=True)
    material = bpy.data.materials.new("RetopologizedMaterial")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    principled = nodes.get("Principled BSDF")
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    nodes.active = texture
    material.node_tree.links.new(texture.outputs["Color"], principled.inputs["Base Color"])
    target.data.materials.clear()
    target.data.materials.append(material)

    lower, upper = object_bounds(source_objects + [target])
    diagonal = max((upper - lower).length, 0.001)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.render.bake.use_selected_to_active = True
    scene.render.bake.use_pass_direct = False
    scene.render.bake.use_pass_indirect = False
    scene.render.bake.use_pass_color = True
    scene.render.bake.cage_extrusion = diagonal * 0.005
    scene.render.bake.max_ray_distance = diagonal * 0.03
    select_only(source_objects + [target], target)
    bpy.ops.object.bake(type="DIFFUSE")
    image.filepath_raw = str(output_dir / "retopology-basecolor.png")
    image.file_format = "PNG"
    image.save()
    image.pack()


def command_rebuild_glb(args: argparse.Namespace) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.source))
    source_objects = mesh_objects()
    if not source_objects:
        raise RuntimeError("Source GLB has no mesh")
    for item in source_objects:
        item.name = f"SOURCE_{item.name}"

    import_obj(args.topology)
    targets = [item for item in mesh_objects() if item not in source_objects]
    target = join_meshes(targets)
    target.name = "RetopologizedMesh"
    bake_texture(source_objects, target, args.texture_size, args.output.parent)

    for item in source_objects:
        bpy.data.objects.remove(item, do_unlink=True)
    select_only([target], target)
    bpy.ops.export_scene.gltf(
        filepath=str(args.output), export_format="GLB", use_selection=True,
        export_apply=True, export_yup=True,
    )


def parse_args() -> argparse.Namespace:
    raw = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    export = subparsers.add_parser("export-obj")
    export.add_argument("--input", type=Path, required=True)
    export.add_argument("--output", type=Path, required=True)
    rebuild = subparsers.add_parser("rebuild-glb")
    rebuild.add_argument("--source", type=Path, required=True)
    rebuild.add_argument("--topology", type=Path, required=True)
    rebuild.add_argument("--output", type=Path, required=True)
    rebuild.add_argument("--texture-size", type=int, default=2048)
    return parser.parse_args(raw)


arguments = parse_args()
if arguments.command == "export-obj":
    command_export_obj(arguments)
else:
    command_rebuild_glb(arguments)
