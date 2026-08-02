"""Blender background bridge: GLB -> OBJ -> remeshed textured GLB."""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bmesh
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


def prepare_for_remesher(
    target: bpy.types.Object,
    max_faces: int,
    merge_distance_ratio: float,
    voxel_resolution: int,
) -> tuple[int, int]:
    """Clean and optionally simplify the temporary mesh sent to AutoRemesher."""
    mesh = target.data
    input_faces = len(mesh.polygons)
    lower, upper = object_bounds([target])
    diagonal = max((upper - lower).length, 0.001)

    editable = bmesh.new()
    editable.from_mesh(mesh)
    loose_vertices = [vertex for vertex in editable.verts if not vertex.link_faces]
    if loose_vertices:
        bmesh.ops.delete(editable, geom=loose_vertices, context="VERTS")
    if merge_distance_ratio > 0:
        bmesh.ops.remove_doubles(
            editable,
            verts=list(editable.verts),
            dist=diagonal * merge_distance_ratio,
        )
    if editable.faces:
        bmesh.ops.recalc_face_normals(editable, faces=list(editable.faces))
    editable.to_mesh(mesh)
    editable.free()
    mesh.validate(verbose=False, clean_customdata=False)
    mesh.update()

    cleaned_faces = len(mesh.polygons)
    voxel_faces = cleaned_faces
    if voxel_resolution > 0:
        mesh.remesh_voxel_size = diagonal / voxel_resolution
        mesh.remesh_voxel_adaptivity = 0.0
        select_only([target], target)
        bpy.ops.object.voxel_remesh()
        mesh = target.data
        mesh.validate(verbose=False, clean_customdata=False)
        mesh.update()
        voxel_faces = len(mesh.polygons)

    # AutoRemesher consumes OBJ triangles.  Voxel Remesh normally produces quads,
    # so applying a ratio to the pre-triangulation polygon count can send roughly
    # twice the configured face limit to the native process.  Triangulate first so
    # max_faces describes the actual faces written to source.obj.
    editable = bmesh.new()
    editable.from_mesh(mesh)
    if editable.faces:
        bmesh.ops.triangulate(editable, faces=list(editable.faces))
    editable.to_mesh(mesh)
    editable.free()
    mesh.validate(verbose=False, clean_customdata=False)
    mesh.update()
    triangulated_faces = len(mesh.polygons)

    current_faces = triangulated_faces
    if max_faces > 0 and current_faces > max_faces:
        modifier = target.modifiers.new(name="AutoRemesherInputLimit", type="DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = max_faces / current_faces
        modifier.use_collapse_triangulate = True
        select_only([target], target)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        mesh = target.data
        mesh.validate(verbose=False, clean_customdata=False)
        mesh.update()

    output_faces = len(mesh.polygons)
    print(
        f"[topology] preprocess input_faces={input_faces} "
        f"cleaned_faces={cleaned_faces} voxel_faces={voxel_faces} "
        f"triangulated_faces={triangulated_faces} "
        f"output_faces={output_faces} max_faces={max_faces} "
        f"voxel_resolution={voxel_resolution}",
        flush=True,
    )
    if output_faces == 0:
        raise RuntimeError("Mesh preprocessing removed every face")
    if max_faces > 0 and output_faces > max_faces:
        raise RuntimeError(
            f"Mesh preprocessing exceeded face limit: {output_faces} > {max_faces}"
        )
    return input_faces, output_faces


def command_export_obj(args: argparse.Namespace) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.input))
    target = join_meshes(mesh_objects())
    prepare_for_remesher(
        target,
        args.max_faces,
        args.merge_distance_ratio,
        args.voxel_resolution,
    )
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


def apply_smooth_shading(target: bpy.types.Object, angle_degrees: float) -> tuple[int, int]:
    """Smooth organic surfaces while retaining boundaries and high-angle hard edges."""
    angle_limit = math.radians(max(0.0, min(angle_degrees, 180.0)))
    editable = bmesh.new()
    editable.from_mesh(target.data)
    for face in editable.faces:
        face.smooth = True
    hard_edges = 0
    for edge in editable.edges:
        is_smooth = len(edge.link_faces) == 2 and edge.calc_face_angle(0.0) <= angle_limit
        edge.smooth = is_smooth
        if not is_smooth:
            hard_edges += 1
    editable.to_mesh(target.data)
    editable.free()
    target.data.update()
    print(
        f"[topology] shading smooth_faces={len(target.data.polygons)} "
        f"hard_edges={hard_edges} angle_degrees={angle_degrees:g}",
        flush=True,
    )
    return len(target.data.polygons), hard_edges


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
    apply_smooth_shading(target, args.smooth_angle)
    bake_texture(source_objects, target, args.texture_size, args.output.parent)

    for item in source_objects:
        bpy.data.objects.remove(item, do_unlink=True)
    select_only([target], target)
    bpy.ops.export_scene.gltf(
        filepath=str(args.output), export_format="GLB", use_selection=True,
        export_apply=True, export_yup=True,
    )


def command_inspect_glb(args: argparse.Namespace) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.input))
    objects = mesh_objects()
    vertices = sum(len(item.data.vertices) for item in objects)
    faces = sum(len(item.data.polygons) for item in objects)
    materials = sum(len(item.data.materials) for item in objects)
    smooth_faces = sum(sum(1 for polygon in item.data.polygons if polygon.use_smooth) for item in objects)
    flat_faces = faces - smooth_faces
    if not objects or vertices == 0 or faces == 0:
        raise RuntimeError("GLB inspection found no usable mesh")
    print(
        f"[topology] inspect mesh_objects={len(objects)} vertices={vertices} "
        f"faces={faces} smooth_faces={smooth_faces} flat_faces={flat_faces} "
        f"materials={materials} images={len(bpy.data.images)}",
        flush=True,
    )


def parse_args() -> argparse.Namespace:
    raw = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    export = subparsers.add_parser("export-obj")
    export.add_argument("--input", type=Path, required=True)
    export.add_argument("--output", type=Path, required=True)
    export.add_argument("--max-faces", type=int, default=150_000)
    export.add_argument("--merge-distance-ratio", type=float, default=0.0000001)
    export.add_argument("--voxel-resolution", type=int, default=256)
    rebuild = subparsers.add_parser("rebuild-glb")
    rebuild.add_argument("--source", type=Path, required=True)
    rebuild.add_argument("--topology", type=Path, required=True)
    rebuild.add_argument("--output", type=Path, required=True)
    rebuild.add_argument("--texture-size", type=int, default=2048)
    rebuild.add_argument("--smooth-angle", type=float, default=60.0)
    inspect = subparsers.add_parser("inspect-glb")
    inspect.add_argument("--input", type=Path, required=True)
    return parser.parse_args(raw)


arguments = parse_args()
if arguments.command == "export-obj":
    command_export_obj(arguments)
elif arguments.command == "rebuild-glb":
    command_rebuild_glb(arguments)
else:
    command_inspect_glb(arguments)
