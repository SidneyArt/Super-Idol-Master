"use client";

import { Bone, Check, CloudSun, Film, Focus, Grid3X3, Lightbulb, LoaderCircle, Orbit, Palette, Pause, PersonStanding, Play, RotateCcw, SunMedium, Trash2, Triangle, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

import {
  createAnimation,
  fetchAnimationFile,
  fetchAnimations,
  removeAnimation,
  type AnimationAsset,
} from "../studio/features/assets/animation-api";

type ModelViewerProps = {
  src: string;
  label: string;
  rigged?: boolean;
  animationApiBase?: string;
};

type ModelStats = {
  meshes: number;
  bones: number;
  vertices: number;
  triangles: number;
};

type ViewerPanel = "render" | "rotation" | "skeleton" | "grid" | "view" | "lighting";
type CameraView = "default" | "front" | "back" | "left" | "right";
type PoseAxis = "x" | "y" | "z";
type PoseRotation = Record<PoseAxis, number>;
type PoseBoneOption = { id: string; name: string };
type PoseBoneRuntime = { bone: THREE.Bone; restPosition: THREE.Vector3; restQuaternion: THREE.Quaternion };
type BonePickerRuntime = {
  mesh: THREE.Mesh;
  bone: THREE.Bone;
  parentBone: THREE.Bone | null;
  kind: "joint" | "segment";
};
type RetargetedClip = { clip: THREE.AnimationClip; mappedBoneCount: number };

const EMPTY_POSE_ROTATION: PoseRotation = { x: 0, y: 0, z: 0 };

function rotationFromRestPose(runtime: PoseBoneRuntime): PoseRotation {
  const delta = runtime.restQuaternion.clone().invert().multiply(runtime.bone.quaternion).normalize();
  const euler = new THREE.Euler().setFromQuaternion(delta, "XYZ");
  const degrees = (value: number) => Math.round(THREE.MathUtils.radToDeg(value));
  return { x: degrees(euler.x), y: degrees(euler.y), z: degrees(euler.z) };
}

function normalizeMixamoBoneName(value: string) {
  return value.replace(/^mixamorig[:_]?/i, "");
}

function boneDepth(bone: THREE.Bone) {
  let depth = 0;
  let parent = bone.parent;
  while (parent) {
    if (parent instanceof THREE.Bone) depth += 1;
    parent = parent.parent;
  }
  return depth;
}

function skeletonHeight(bones: THREE.Bone[]) {
  const position = new THREE.Vector3();
  let minY = Infinity;
  let maxY = -Infinity;
  for (const bone of bones) {
    bone.getWorldPosition(position);
    minY = Math.min(minY, position.y);
    maxY = Math.max(maxY, position.y);
  }
  return Number.isFinite(minY) && Number.isFinite(maxY) ? Math.max(maxY - minY, 0.0001) : 1;
}

function retargetMixamoClip(
  source: THREE.Group,
  sourceClip: THREE.AnimationClip,
  targetBones: Map<string, PoseBoneRuntime>,
  inPlace: boolean,
): RetargetedClip {
  const sourceBones = new Map<string, THREE.Bone>();
  source.traverse((object) => {
    if (object instanceof THREE.Bone) sourceBones.set(normalizeMixamoBoneName(object.name), object);
  });
  const targetByName = new Map([...targetBones.values()].map((runtime) => [runtime.bone.name, runtime]));
  const targets = [...targetBones.values()]
    .filter(({ bone }) => sourceBones.has(bone.name))
    .sort((left, right) => boneDepth(left.bone) - boneDepth(right.bone));
  if (!targets.length) throw new Error("动画骨骼与当前模型不匹配");

  source.updateMatrixWorld(true);
  const sourceRestWorld = new Map<string, THREE.Quaternion>();
  for (const [name, bone] of sourceBones) sourceRestWorld.set(name, bone.getWorldQuaternion(new THREE.Quaternion()));
  const targetRestWorld = new Map<string, THREE.Quaternion>();
  for (const { bone } of targetBones.values()) targetRestWorld.set(bone.uuid, bone.getWorldQuaternion(new THREE.Quaternion()));

  const sourceHeight = skeletonHeight([...sourceBones.values()]);
  const targetHeight = skeletonHeight([...targetBones.values()].map(({ bone }) => bone));
  const movementScale = targetHeight / sourceHeight;
  const fps = 30;
  const frameCount = Math.max(2, Math.ceil(sourceClip.duration * fps) + 1);
  const times = new Float32Array(frameCount);
  const rotations = new Map<string, Float32Array>();
  for (const { bone } of targets) rotations.set(bone.uuid, new Float32Array(frameCount * 4));

  const sourceMixer = new THREE.AnimationMixer(source);
  const sourceAction = sourceMixer.clipAction(sourceClip);
  sourceAction.setLoop(THREE.LoopOnce, 1);
  sourceAction.clampWhenFinished = true;
  sourceAction.play();

  const sourceHip = sourceBones.get("Hips");
  const targetHipRuntime = targetByName.get("Hips");
  const targetHip = targetHipRuntime?.bone;
  const hipPositions = sourceHip && targetHip ? new Float32Array(frameCount * 3) : null;
  const sourceHipOrigin = new THREE.Vector3();
  const sourceHipPosition = new THREE.Vector3();
  const movement = new THREE.Vector3();
  const parentWorldQuaternion = new THREE.Quaternion();
  const parentWorldScale = new THREE.Vector3(1, 1, 1);
  const sourceAnimated = new THREE.Quaternion();
  const motionDelta = new THREE.Quaternion();
  const desiredWorld = new THREE.Quaternion();
  const localRotation = new THREE.Quaternion();
  const desiredWorldRotations = new Map<string, THREE.Quaternion>();

  sourceMixer.setTime(0);
  source.updateMatrixWorld(true);
  sourceHip?.getWorldPosition(sourceHipOrigin);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = Math.min((frame / (frameCount - 1)) * sourceClip.duration, Math.max(sourceClip.duration - 0.000001, 0));
    times[frame] = (frame / (frameCount - 1)) * sourceClip.duration;
    sourceMixer.setTime(time);
    source.updateMatrixWorld(true);
    desiredWorldRotations.clear();

    for (const { bone } of targets) {
      const sourceBone = sourceBones.get(bone.name)!;
      sourceBone.getWorldQuaternion(sourceAnimated);
      motionDelta.copy(sourceAnimated).multiply(sourceRestWorld.get(bone.name)!.clone().invert()).normalize();
      desiredWorld.copy(motionDelta).multiply(targetRestWorld.get(bone.uuid)!).normalize();
      const parentBone = bone.parent instanceof THREE.Bone ? bone.parent : null;
      const parentDesired = parentBone
        ? desiredWorldRotations.get(parentBone.uuid) || targetRestWorld.get(parentBone.uuid) || parentBone.getWorldQuaternion(new THREE.Quaternion())
        : bone.parent?.getWorldQuaternion(parentWorldQuaternion) || parentWorldQuaternion.identity();
      localRotation.copy(parentDesired).invert().multiply(desiredWorld).normalize();
      desiredWorldRotations.set(bone.uuid, desiredWorld.clone());
      const values = rotations.get(bone.uuid)!;
      if (frame > 0) {
        const previous = new THREE.Quaternion().fromArray(values, (frame - 1) * 4);
        if (previous.dot(localRotation) < 0) localRotation.set(-localRotation.x, -localRotation.y, -localRotation.z, -localRotation.w);
      }
      localRotation.toArray(values, frame * 4);
    }

    if (hipPositions && sourceHip && targetHip) {
      sourceHip.getWorldPosition(sourceHipPosition);
      movement.subVectors(sourceHipPosition, sourceHipOrigin).multiplyScalar(movementScale);
      if (inPlace) {
        movement.x = 0;
        movement.z = 0;
      }
      const parent = targetHip.parent;
      if (parent) {
        parent.getWorldQuaternion(parentWorldQuaternion).invert();
        parent.getWorldScale(parentWorldScale);
        movement.applyQuaternion(parentWorldQuaternion);
        movement.set(
          movement.x / Math.max(Math.abs(parentWorldScale.x), 0.0001),
          movement.y / Math.max(Math.abs(parentWorldScale.y), 0.0001),
          movement.z / Math.max(Math.abs(parentWorldScale.z), 0.0001),
        );
      }
      movement.add(targetHipRuntime!.restPosition).toArray(hipPositions, frame * 3);
    }
  }
  sourceAction.stop();
  sourceMixer.uncacheRoot(source);

  const tracks: THREE.KeyframeTrack[] = targets.map(({ bone }) => new THREE.QuaternionKeyframeTrack(
    `${bone.name}.quaternion`,
    times,
    rotations.get(bone.uuid)!,
  ));
  if (hipPositions && targetHip) tracks.push(new THREE.VectorKeyframeTrack(`${targetHip.name}.position`, times, hipPositions));
  return { clip: new THREE.AnimationClip(sourceClip.name || "Mixamo", sourceClip.duration, tracks), mappedBoneCount: targets.length };
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function formatClipTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00.0";
  const minutes = Math.floor(value / 60);
  const seconds = (value % 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${seconds}`;
}

function disposeMaterial(material: THREE.Material) {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  material.dispose();
}

export default function ModelViewer({ src, label, rigged = false, animationApiBase = "" }: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const animationFileRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const lightsRef = useRef<{
    hemisphere: THREE.HemisphereLight;
    key: THREE.DirectionalLight;
    rim: THREE.DirectionalLight;
    fill: THREE.DirectionalLight;
  } | null>(null);
  const skeletonRef = useRef<THREE.SkeletonHelper | null>(null);
  const poseBonesRef = useRef<Map<string, PoseBoneRuntime>>(new Map());
  const poseRotationsRef = useRef<Map<string, PoseRotation>>(new Map());
  const selectedPoseBoneIdRef = useRef("");
  const transformControlsRef = useRef<TransformControls | null>(null);
  const modelRef = useRef<THREE.Group | null>(null);
  const animationMixerRef = useRef<THREE.AnimationMixer | null>(null);
  const animationActionRef = useRef<THREE.AnimationAction | null>(null);
  const animationClipRef = useRef<THREE.AnimationClip | null>(null);
  const animationPlayingRef = useRef(false);
  const animationLoopRef = useRef(true);
  const animationSpeedRef = useRef(1);
  const animationActiveRef = useRef(false);
  const resetViewRef = useRef<() => void>(() => undefined);
  const setCameraViewRef = useRef<(view: CameraView) => void>(() => undefined);
  const autoRotateRef = useRef(false);
  const skeletonVisibleRef = useRef(rigged);
  const wireframeRef = useRef(false);
  const showGridRef = useRef(true);
  const environmentColorRef = useRef("#ffffff");
  const environmentIntensityRef = useRef(1);
  const directionalColorRef = useRef("#ffffff");
  const directionalIntensityRef = useRef(1);
  const backgroundColorRef = useRef("#464646");
  const wireframeOverlaysRef = useRef<Set<THREE.Mesh>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [autoRotate, setAutoRotate] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(rigged);
  const [wireframe, setWireframe] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [environmentColor, setEnvironmentColor] = useState("#ffffff");
  const [environmentIntensity, setEnvironmentIntensity] = useState(1);
  const [directionalColor, setDirectionalColor] = useState("#ffffff");
  const [directionalIntensity, setDirectionalIntensity] = useState(1);
  const [backgroundColor, setBackgroundColor] = useState("#464646");
  const [stats, setStats] = useState<ModelStats | null>(null);
  const [poseBones, setPoseBones] = useState<PoseBoneOption[]>([]);
  const [selectedPoseBoneId, setSelectedPoseBoneId] = useState("");
  const [selectedPoseRotation, setSelectedPoseRotation] = useState<PoseRotation>(EMPTY_POSE_ROTATION);
  const [animations, setAnimations] = useState<AnimationAsset[]>([]);
  const [animationsLoading, setAnimationsLoading] = useState(rigged && Boolean(animationApiBase));
  const [animationBusy, setAnimationBusy] = useState(false);
  const [animationError, setAnimationError] = useState("");
  const [selectedAnimationId, setSelectedAnimationId] = useState("");
  const [loadedAnimationId, setLoadedAnimationId] = useState("");
  const [animationPlaying, setAnimationPlaying] = useState(false);
  const [animationLoop, setAnimationLoop] = useState(true);
  const [animationInPlace, setAnimationInPlace] = useState(true);
  const [animationSpeed, setAnimationSpeed] = useState(1);
  const [animationTime, setAnimationTime] = useState(0);
  const [animationDuration, setAnimationDuration] = useState(0);
  const [pendingAnimationDeleteId, setPendingAnimationDeleteId] = useState("");
  const [animationSidebarCollapsed, setAnimationSidebarCollapsed] = useState(true);
  const [openPanel, setOpenPanel] = useState<ViewerPanel | null>(null);

  useEffect(() => {
    if (!openPanel) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(".model-viewer-menu, .model-viewer-lighting")) return;
      setOpenPanel(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenPanel(null);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openPanel]);

  useEffect(() => {
    if (!rigged || !animationApiBase) return;
    const controller = new AbortController();
    fetchAnimations(animationApiBase, controller.signal)
      .then((items) => {
        setAnimations(items);
        setSelectedAnimationId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id || "");
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setAnimationError(reason instanceof Error ? reason.message : "动画库读取失败");
      })
      .finally(() => setAnimationsLoading(false));
    return () => controller.abort();
  }, [rigged, animationApiBase]);

  useEffect(() => {
    autoRotateRef.current = autoRotate;
    if (controlsRef.current) controlsRef.current.autoRotate = autoRotate;
  }, [autoRotate]);

  useEffect(() => {
    animationPlayingRef.current = animationPlaying;
    if (animationActionRef.current) animationActionRef.current.paused = !animationPlaying;
  }, [animationPlaying]);

  useEffect(() => {
    animationLoopRef.current = animationLoop;
    const action = animationActionRef.current;
    if (action) {
      action.setLoop(animationLoop ? THREE.LoopRepeat : THREE.LoopOnce, animationLoop ? Infinity : 1);
      action.clampWhenFinished = !animationLoop;
    }
  }, [animationLoop]);

  useEffect(() => {
    animationSpeedRef.current = animationSpeed;
    if (animationMixerRef.current) animationMixerRef.current.timeScale = animationSpeed;
  }, [animationSpeed]);

  useEffect(() => {
    skeletonVisibleRef.current = showSkeleton;
    if (skeletonRef.current) skeletonRef.current.visible = showSkeleton;
    const transformControls = transformControlsRef.current;
    if (transformControls) {
      transformControls.enabled = showSkeleton && !animationActiveRef.current;
      transformControls.getHelper().visible = showSkeleton && !animationActiveRef.current && Boolean(selectedPoseBoneIdRef.current);
    }
  }, [showSkeleton]);

  useEffect(() => {
    wireframeRef.current = wireframe;
    for (const overlay of wireframeOverlaysRef.current) overlay.visible = wireframe;
  }, [wireframe]);

  useEffect(() => {
    showGridRef.current = showGrid;
    if (gridRef.current) gridRef.current.visible = showGrid;
  }, [showGrid]);

  useEffect(() => {
    environmentColorRef.current = environmentColor;
    environmentIntensityRef.current = environmentIntensity;
    const lights = lightsRef.current;
    if (!lights) return;
    lights.hemisphere.color.set(environmentColor);
    lights.hemisphere.intensity = 3.2 * environmentIntensity;
  }, [environmentColor, environmentIntensity]);

  useEffect(() => {
    directionalColorRef.current = directionalColor;
    directionalIntensityRef.current = directionalIntensity;
    const lights = lightsRef.current;
    if (!lights) return;
    lights.key.color.set(directionalColor);
    lights.rim.color.set(directionalColor);
    lights.fill.color.set(directionalColor);
    lights.key.intensity = 4.5 * directionalIntensity;
    lights.rim.intensity = 2.5 * directionalIntensity;
    lights.fill.intensity = 1.9 * directionalIntensity;
  }, [directionalColor, directionalIntensity]);

  useEffect(() => {
    backgroundColorRef.current = backgroundColor;
    const scene = sceneRef.current;
    if (!scene) return;
    scene.background = new THREE.Color(backgroundColor);
  }, [backgroundColor]);

  function selectPoseBone(id: string) {
    selectedPoseBoneIdRef.current = id;
    setSelectedPoseBoneId(id);
    setSelectedPoseRotation({ ...(poseRotationsRef.current.get(id) || EMPTY_POSE_ROTATION) });
    const runtime = poseBonesRef.current.get(id);
    const transformControls = transformControlsRef.current;
    if (runtime && transformControls) {
      transformControls.attach(runtime.bone);
      transformControls.enabled = skeletonVisibleRef.current && !animationActiveRef.current;
      transformControls.getHelper().visible = skeletonVisibleRef.current && !animationActiveRef.current;
    } else {
      transformControls?.detach();
    }
  }

  function updatePoseRotation(axis: PoseAxis, value: number) {
    if (animationActiveRef.current) return;
    const runtime = poseBonesRef.current.get(selectedPoseBoneId);
    if (!runtime) return;
    const current = poseRotationsRef.current.get(selectedPoseBoneId) || EMPTY_POSE_ROTATION;
    const next = { ...current, [axis]: value };
    poseRotationsRef.current.set(selectedPoseBoneId, next);
    const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(next.x),
      THREE.MathUtils.degToRad(next.y),
      THREE.MathUtils.degToRad(next.z),
      "XYZ",
    ));
    runtime.bone.quaternion.copy(runtime.restQuaternion).multiply(delta);
    runtime.bone.updateMatrixWorld(true);
    setSelectedPoseRotation(next);
  }

  function resetSelectedPoseBone() {
    if (animationActiveRef.current) return;
    const runtime = poseBonesRef.current.get(selectedPoseBoneId);
    if (!runtime) return;
    runtime.bone.position.copy(runtime.restPosition);
    runtime.bone.quaternion.copy(runtime.restQuaternion);
    runtime.bone.updateMatrixWorld(true);
    poseRotationsRef.current.set(selectedPoseBoneId, { ...EMPTY_POSE_ROTATION });
    setSelectedPoseRotation({ ...EMPTY_POSE_ROTATION });
  }

  function resetEntirePose() {
    for (const [id, runtime] of poseBonesRef.current) {
      runtime.bone.position.copy(runtime.restPosition);
      runtime.bone.quaternion.copy(runtime.restQuaternion);
      runtime.bone.updateMatrixWorld(true);
      poseRotationsRef.current.set(id, { ...EMPTY_POSE_ROTATION });
    }
    setSelectedPoseRotation({ ...EMPTY_POSE_ROTATION });
  }

  function clearAnimationPreview() {
    const mixer = animationMixerRef.current;
    const clip = animationClipRef.current;
    const model = modelRef.current;
    mixer?.stopAllAction();
    if (mixer && clip) mixer.uncacheClip(clip);
    if (mixer && model) mixer.uncacheRoot(model);
    animationMixerRef.current = null;
    animationActionRef.current = null;
    animationClipRef.current = null;
    animationActiveRef.current = false;
    animationPlayingRef.current = false;
    setLoadedAnimationId("");
    setAnimationPlaying(false);
    setAnimationTime(0);
    setAnimationDuration(0);
    resetEntirePose();
    model?.updateMatrixWorld(true);
    const transformControls = transformControlsRef.current;
    if (transformControls) {
      transformControls.enabled = skeletonVisibleRef.current;
      transformControls.getHelper().visible = skeletonVisibleRef.current && Boolean(selectedPoseBoneIdRef.current);
    }
  }

  async function loadSelectedAnimation(animationId = selectedAnimationId) {
    const asset = animations.find((item) => item.id === animationId);
    const model = modelRef.current;
    if (!asset || !model) throw new Error(asset ? "绑定模型尚未加载完成" : "请先选择动画");
    if (loadedAnimationId === asset.id && animationActionRef.current) return animationActionRef.current;
    clearAnimationPreview();
    setAnimationBusy(true);
    setAnimationError("");
    try {
      const file = await fetchAnimationFile(animationApiBase, asset.fileUrl);
      const source = new FBXLoader().parse(file.data, file.url.slice(0, file.url.lastIndexOf("/") + 1));
      const sourceClip = source.animations?.[0];
      if (!sourceClip) throw new Error("FBX 中没有动画片段");
      resetEntirePose();
      model.updateMatrixWorld(true);
      const { clip, mappedBoneCount } = retargetMixamoClip(source, sourceClip, poseBonesRef.current, animationInPlace);
      source.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(disposeMaterial);
      });
      if (mappedBoneCount < 15) throw new Error(`仅匹配 ${mappedBoneCount} 根骨骼，无法安全播放`);
      const mixer = new THREE.AnimationMixer(model);
      mixer.timeScale = animationSpeedRef.current;
      const action = mixer.clipAction(clip);
      action.setLoop(animationLoopRef.current ? THREE.LoopRepeat : THREE.LoopOnce, animationLoopRef.current ? Infinity : 1);
      action.clampWhenFinished = !animationLoopRef.current;
      action.play();
      action.paused = true;
      animationMixerRef.current = mixer;
      animationActionRef.current = action;
      animationClipRef.current = clip;
      animationActiveRef.current = true;
      setLoadedAnimationId(asset.id);
      setAnimationDuration(clip.duration);
      setAnimationTime(0);
      const transformControls = transformControlsRef.current;
      if (transformControls) {
        transformControls.enabled = false;
        transformControls.getHelper().visible = false;
      }
      return action;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "动画加载失败";
      setAnimationError(message);
      throw reason;
    } finally {
      setAnimationBusy(false);
    }
  }

  async function toggleAnimationPlayback() {
    if (animationBusy) return;
    try {
      const action = await loadSelectedAnimation();
      if (animationPlayingRef.current) {
        action.paused = true;
        setAnimationPlaying(false);
        return;
      }
      if (!animationLoopRef.current && action.time >= Math.max(action.getClip().duration - 0.01, 0)) action.reset().play();
      action.paused = false;
      setAnimationPlaying(true);
    } catch {
      // loadSelectedAnimation 已显示错误。
    }
  }

  async function restartAnimation() {
    if (animationBusy) return;
    try {
      const action = await loadSelectedAnimation();
      action.reset().play();
      action.paused = false;
      setAnimationTime(0);
      setAnimationPlaying(true);
    } catch {
      // loadSelectedAnimation 已显示错误。
    }
  }

  async function previewAnimation(animationId: string) {
    if (animationBusy) return;
    setSelectedAnimationId(animationId);
    setPendingAnimationDeleteId("");
    setAnimationError("");
    try {
      const action = await loadSelectedAnimation(animationId);
      action.reset().play();
      action.paused = false;
      setAnimationTime(0);
      setAnimationPlaying(true);
    } catch {
      // loadSelectedAnimation 已显示错误。
    }
  }

  function scrubAnimation(value: number) {
    const action = animationActionRef.current;
    const mixer = animationMixerRef.current;
    if (!action || !mixer) return;
    action.time = Math.max(0, Math.min(value, action.getClip().duration));
    mixer.update(0);
    setAnimationTime(action.time);
  }

  async function uploadAnimation(file: File) {
    if (!animationApiBase) return;
    if (!file.name.toLowerCase().endsWith(".fbx")) {
      setAnimationError("只支持 Mixamo FBX 动画文件");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setAnimationError("动画 FBX 不能超过 15 MB");
      return;
    }
    setAnimationBusy(true);
    setAnimationError("");
    try {
      const data = await createAnimation(animationApiBase, {
        filename: file.name,
        name: file.name.replace(/\.fbx$/i, ""),
        data: arrayBufferToBase64(await file.arrayBuffer()),
      });
      const items = data.animations;
      clearAnimationPreview();
      setAnimations(items);
      setSelectedAnimationId(data.animation?.id || items[0]?.id || "");
      setPendingAnimationDeleteId("");
    } catch (reason) {
      setAnimationError(reason instanceof Error ? reason.message : "动画上传失败");
    } finally {
      setAnimationBusy(false);
    }
  }

  async function deleteSelectedAnimation() {
    const asset = animations.find((item) => item.id === selectedAnimationId);
    if (!asset || !animationApiBase) return;
    if (pendingAnimationDeleteId !== asset.id) {
      setPendingAnimationDeleteId(asset.id);
      return;
    }
    setAnimationBusy(true);
    setAnimationError("");
    try {
      const items = await removeAnimation(animationApiBase, asset.id);
      clearAnimationPreview();
      setAnimations(items);
      setSelectedAnimationId(items[0]?.id || "");
      setPendingAnimationDeleteId("");
    } catch (reason) {
      setAnimationError(reason instanceof Error ? reason.message : "动画删除失败");
    } finally {
      setAnimationBusy(false);
    }
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let frameId = 0;
    let previousFrameAt = 0;
    let animationUiUpdatedAt = 0;
    setLoading(true);
    setError("");
    setStats(null);
    skeletonVisibleRef.current = rigged;
    setShowSkeleton(rigged);
    setPoseBones([]);
    setSelectedPoseBoneId("");
    selectedPoseBoneIdRef.current = "";
    setSelectedPoseRotation({ ...EMPTY_POSE_ROTATION });
    poseBonesRef.current = new Map();
    poseRotationsRef.current = new Map();
    animationMixerRef.current?.stopAllAction();
    animationMixerRef.current = null;
    animationActionRef.current = null;
    animationClipRef.current = null;
    animationActiveRef.current = false;
    animationPlayingRef.current = false;
    modelRef.current = null;
    setLoadedAnimationId("");
    setAnimationPlaying(false);
    setAnimationTime(0);
    setAnimationDuration(0);
    wireframeOverlaysRef.current = new Set();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(backgroundColorRef.current);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.autoRotate = autoRotateRef.current;
    controls.autoRotateSpeed = 0.8;
    controls.screenSpacePanning = true;
    controlsRef.current = controls;

    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.mode = "rotate";
    transformControls.space = "local";
    transformControls.size = 0.78;
    transformControls.enabled = false;
    const transformHelper = transformControls.getHelper();
    transformHelper.visible = false;
    scene.add(transformHelper);
    transformControlsRef.current = transformControls;
    const handleTransformDragging = (event: { value: unknown }) => {
      controls.enabled = !Boolean(event.value);
    };
    const handleTransformChange = () => {
      if (disposed) return;
      const bone = transformControls.object;
      if (!(bone instanceof THREE.Bone)) return;
      const runtime = poseBonesRef.current.get(bone.uuid);
      if (!runtime) return;
      bone.updateMatrixWorld(true);
      const rotation = rotationFromRestPose(runtime);
      poseRotationsRef.current.set(bone.uuid, rotation);
      if (selectedPoseBoneIdRef.current === bone.uuid) setSelectedPoseRotation(rotation);
    };
    transformControls.addEventListener("dragging-changed", handleTransformDragging);
    transformControls.addEventListener("objectChange", handleTransformChange);

    const hemisphere = new THREE.HemisphereLight(environmentColorRef.current, 0x18202a, 3.2 * environmentIntensityRef.current);
    scene.add(hemisphere);
    const keyLight = new THREE.DirectionalLight(directionalColorRef.current, 4.5 * directionalIntensityRef.current);
    keyLight.position.set(5, 8, 7);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(directionalColorRef.current, 2.5 * directionalIntensityRef.current);
    rimLight.position.set(-6, 3, -5);
    scene.add(rimLight);
    const fillLight = new THREE.DirectionalLight(directionalColorRef.current, 1.9 * directionalIntensityRef.current);
    fillLight.position.set(4, 1, -6);
    scene.add(fillLight);
    lightsRef.current = { hemisphere, key: keyLight, rim: rimLight, fill: fillLight };

    const grid = new THREE.GridHelper(20, 20, 0x314052, 0x18202c);
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.65;
    grid.visible = showGridRef.current;
    scene.add(grid);
    gridRef.current = grid;

    const wireframeMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: false,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      toneMapped: false,
    });
    const bonePickerGroup = new THREE.Group();
    bonePickerGroup.name = "BonePickerGroup";
    scene.add(bonePickerGroup);
    const bonePickerSphereGeometry = new THREE.SphereGeometry(1, 8, 6);
    const bonePickerSegmentGeometry = new THREE.CylinderGeometry(1, 1, 1, 8);
    const bonePickerMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      colorWrite: false,
      side: THREE.DoubleSide,
    });
    const bonePickers: BonePickerRuntime[] = [];
    const bonePickerMeshes: THREE.Mesh[] = [];
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pickerStart = new THREE.Vector3();
    const pickerEnd = new THREE.Vector3();
    const pickerDirection = new THREE.Vector3();
    const pickerMidpoint = new THREE.Vector3();
    const pickerUp = new THREE.Vector3(0, 1, 0);
    let bonePickerRadius = 0.01;

    const updateBonePickers = () => {
      for (const picker of bonePickers) {
        picker.bone.getWorldPosition(pickerEnd);
        if (picker.kind === "joint") {
          picker.mesh.position.copy(pickerEnd);
          picker.mesh.quaternion.identity();
          picker.mesh.scale.setScalar(bonePickerRadius * 1.35);
          continue;
        }
        picker.parentBone?.getWorldPosition(pickerStart);
        pickerDirection.subVectors(pickerEnd, pickerStart);
        const length = Math.max(pickerDirection.length(), bonePickerRadius * 2);
        pickerMidpoint.addVectors(pickerStart, pickerEnd).multiplyScalar(0.5);
        picker.mesh.position.copy(pickerMidpoint);
        picker.mesh.quaternion.setFromUnitVectors(pickerUp, pickerDirection.normalize());
        picker.mesh.scale.set(bonePickerRadius, length, bonePickerRadius);
      }
    };

    const handleBonePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !skeletonVisibleRef.current || animationActiveRef.current || transformControls.dragging || transformControls.axis) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * 2 - 1,
        -((event.clientY - bounds.top) / Math.max(bounds.height, 1)) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(bonePickerMeshes, false)[0];
      const boneId = hit?.object.userData.poseBoneId;
      if (typeof boneId !== "string") return;
      selectPoseBone(boneId);
      setOpenPanel("skeleton");
    };
    renderer.domElement.addEventListener("pointerdown", handleBonePointerDown);

    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const loader = new GLTFLoader();
    loader.load(
      src,
      (gltf) => {
        if (disposed) return;
        const model = gltf.scene;
        let meshes = 0;
        let bones = 0;
        let vertices = 0;
        let triangles = 0;
        const poseBoneOptions: PoseBoneOption[] = [];
        const wireframeOverlays: Array<{ source: THREE.Mesh; overlay: THREE.Mesh }> = [];
        model.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            meshes += 1;
            const geometry = object.geometry;
            const position = geometry.getAttribute("position");
            vertices += position?.count || 0;
            triangles += geometry.index ? geometry.index.count / 3 : (position?.count || 0) / 3;
            const overlay = object.clone(false) as THREE.Mesh;
            overlay.name = `${object.name || "mesh"}-wireframe-overlay`;
            overlay.material = wireframeMaterial;
            overlay.visible = wireframeRef.current;
            overlay.renderOrder = 100;
            overlay.frustumCulled = false;
            overlay.userData = { ...overlay.userData, wireframeOverlay: true };
            wireframeOverlays.push({ source: object, overlay });
          }
          if (object instanceof THREE.Bone) {
            bones += 1;
            const id = object.uuid;
            poseBoneOptions.push({ id, name: object.name || `Bone ${bones}` });
            poseBonesRef.current.set(id, { bone: object, restPosition: object.position.clone(), restQuaternion: object.quaternion.clone() });
            poseRotationsRef.current.set(id, { ...EMPTY_POSE_ROTATION });
          }
        });
        for (const { source, overlay } of wireframeOverlays) {
          source.parent?.add(overlay);
          wireframeOverlaysRef.current.add(overlay);
        }

        scene.add(model);
        modelRef.current = model;
        const bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const maxDimension = Math.max(size.x, size.y, size.z, 0.1);
        bonePickerRadius = maxDimension * 0.018;
        grid.position.y = bounds.min.y;
        grid.scale.setScalar(Math.max(maxDimension / 6, 0.25));

        const setCameraView = (view: CameraView) => {
          const verticalFov = THREE.MathUtils.degToRad(camera.fov);
          const fitHeightDistance = size.y / (2 * Math.tan(verticalFov / 2));
          const fitWidthDistance = size.x / (2 * Math.tan(verticalFov / 2) * Math.max(camera.aspect, 0.1));
          const distance = Math.max(fitHeightDistance, fitWidthDistance, maxDimension) * 1.25;
          const directions: Record<CameraView, THREE.Vector3> = {
            default: new THREE.Vector3(0.78, 0.38, 1),
            front: new THREE.Vector3(0, 0, 1),
            back: new THREE.Vector3(0, 0, -1),
            left: new THREE.Vector3(-1, 0, 0),
            right: new THREE.Vector3(1, 0, 0),
          };
          const direction = directions[view].normalize();
          camera.near = Math.max(distance / 100, 0.001);
          camera.far = Math.max(distance * 100, 100);
          camera.position.copy(center).addScaledVector(direction, distance);
          camera.updateProjectionMatrix();
          controls.target.copy(center);
          controls.minDistance = maxDimension * 0.15;
          controls.maxDistance = maxDimension * 12;
          controls.update();
        };
        resetViewRef.current = () => setCameraView("default");
        setCameraViewRef.current = setCameraView;
        setCameraView("default");

        if (rigged && bones > 0) {
          const skeleton = new THREE.SkeletonHelper(model);
          skeleton.visible = skeletonVisibleRef.current;
          scene.add(skeleton);
          skeletonRef.current = skeleton;
          for (const runtime of poseBonesRef.current.values()) {
            const joint = new THREE.Mesh(bonePickerSphereGeometry, bonePickerMaterial);
            joint.userData = { poseBoneId: runtime.bone.uuid, bonePicker: true };
            bonePickerGroup.add(joint);
            bonePickerMeshes.push(joint);
            bonePickers.push({ mesh: joint, bone: runtime.bone, parentBone: null, kind: "joint" });
            const parentBone = runtime.bone.parent instanceof THREE.Bone ? runtime.bone.parent : null;
            if (parentBone) {
              const segment = new THREE.Mesh(bonePickerSegmentGeometry, bonePickerMaterial);
              segment.userData = { poseBoneId: runtime.bone.uuid, bonePicker: true };
              bonePickerGroup.add(segment);
              bonePickerMeshes.push(segment);
              bonePickers.push({ mesh: segment, bone: runtime.bone, parentBone, kind: "segment" });
            }
          }
          updateBonePickers();
          setPoseBones(poseBoneOptions);
          selectPoseBone(poseBoneOptions[0]?.id || "");
        }

        setStats({ meshes, bones, vertices, triangles: Math.round(triangles) });
        setLoading(false);
      },
      undefined,
      (reason) => {
        if (disposed) return;
        setLoading(false);
        setError(reason instanceof Error ? reason.message : "GLB 加载失败");
      },
    );

    const animate = () => {
      frameId = window.requestAnimationFrame(animate);
      const now = performance.now();
      const delta = previousFrameAt ? Math.min(Math.max((now - previousFrameAt) / 1000, 0), 0.1) : 0;
      previousFrameAt = now;
      controls.update();
      const mixer = animationMixerRef.current;
      const action = animationActionRef.current;
      if (mixer && action) {
        mixer.update(delta);
        if (now - animationUiUpdatedAt >= 80) {
          animationUiUpdatedAt = now;
          setAnimationTime(action.time);
        }
        if (!animationLoopRef.current && animationPlayingRef.current && action.time >= Math.max(action.getClip().duration - 0.001, 0)) {
          action.paused = true;
          animationPlayingRef.current = false;
          setAnimationPlaying(false);
          setAnimationTime(action.getClip().duration);
        }
      }
      updateBonePickers();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      resetViewRef.current = () => undefined;
      setCameraViewRef.current = () => undefined;
      controls.dispose();
      controlsRef.current = null;
      renderer.domElement.removeEventListener("pointerdown", handleBonePointerDown);
      transformControls.removeEventListener("dragging-changed", handleTransformDragging);
      transformControls.removeEventListener("objectChange", handleTransformChange);
      transformControls.detach();
      transformControls.dispose();
      scene.remove(transformHelper);
      transformControlsRef.current = null;
      animationMixerRef.current?.stopAllAction();
      animationMixerRef.current = null;
      animationActionRef.current = null;
      animationClipRef.current = null;
      animationActiveRef.current = false;
      animationPlayingRef.current = false;
      modelRef.current = null;
      scene.remove(bonePickerGroup);
      bonePickerSphereGeometry.dispose();
      bonePickerSegmentGeometry.dispose();
      bonePickerMaterial.dispose();
      sceneRef.current = null;
      gridRef.current = null;
      lightsRef.current = null;
      poseBonesRef.current = new Map();
      poseRotationsRef.current = new Map();
      selectedPoseBoneIdRef.current = "";
      wireframeOverlaysRef.current = new Set();
      if (skeletonRef.current) {
        skeletonRef.current.geometry.dispose();
        const material = skeletonRef.current.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material.dispose();
      }
      skeletonRef.current = null;
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          if (object.userData.wireframeOverlay) return;
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach(disposeMaterial);
        }
      });
      wireframeMaterial.dispose();
      grid.geometry.dispose();
      gridMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [src, rigged]);

  function togglePanel(panel: ViewerPanel) {
    setOpenPanel((current) => current === panel ? null : panel);
  }

  function applyOption(action: () => void) {
    action();
  }

  const selectedAnimation = animations.find((item) => item.id === selectedAnimationId) || null;
  const poseLockedByAnimation = Boolean(loadedAnimationId);
  const timelineDuration = animationDuration || selectedAnimation?.duration || 0;
  const showAnimationSidebar = Boolean(rigged && stats && stats.bones > 0);

  return (
    <div className={`model-viewer-shell ${showAnimationSidebar ? "has-animation-sidebar" : ""} ${showAnimationSidebar && animationSidebarCollapsed ? "animation-sidebar-collapsed" : ""}`}>
      <div ref={hostRef} className="model-viewer-canvas" aria-label={`${label} 交互式三维预览`} />

      <div className="model-viewer-toolbar" aria-label="三维预览控制">
        <div className="model-viewer-menu">
          <button className={`viewer-tool-button ${wireframe ? "active" : ""}`} onClick={() => togglePanel("render")} type="button" title="显示模式" aria-label="显示模式" aria-expanded={openPanel === "render"} aria-haspopup="menu">
            <Triangle size={16} />
          </button>
          {openPanel === "render" && <div className="viewer-options" role="menu" aria-label="显示模式选项">
            <button className={!wireframe ? "active" : ""} onClick={() => applyOption(() => setWireframe(false))} type="button" role="menuitem"><Check size={14} />实体材质</button>
            <button className={wireframe ? "active" : ""} onClick={() => applyOption(() => setWireframe(true))} type="button" role="menuitem"><Check size={14} />拓扑线框</button>
          </div>}
        </div>
        <div className="model-viewer-menu">
          <button className={`viewer-tool-button ${autoRotate ? "active" : ""}`} onClick={() => togglePanel("rotation")} type="button" title="旋转设置" aria-label="旋转设置" aria-expanded={openPanel === "rotation"} aria-haspopup="menu">
            <Orbit size={16} />
          </button>
          {openPanel === "rotation" && <div className="viewer-options" role="menu" aria-label="旋转选项">
            <button className={!autoRotate ? "active" : ""} onClick={() => applyOption(() => setAutoRotate(false))} type="button" role="menuitem"><Check size={14} />停止旋转</button>
            <button className={autoRotate ? "active" : ""} onClick={() => applyOption(() => setAutoRotate(true))} type="button" role="menuitem"><Check size={14} />自动旋转</button>
          </div>}
        </div>
        {rigged && stats && stats.bones > 0 && (
          <div className="model-viewer-menu">
            <button className={`viewer-tool-button ${showSkeleton || openPanel === "skeleton" ? "active" : ""}`} onClick={() => { togglePanel("skeleton"); setShowSkeleton(true); }} type="button" title="骨骼与临时姿态" aria-label="骨骼与临时姿态" aria-expanded={openPanel === "skeleton"} aria-haspopup="dialog">
              <Bone size={16} />
            </button>
            {openPanel === "skeleton" && <div className="viewer-options viewer-pose-panel" role="dialog" aria-label="临时姿态编辑器">
              <div className="viewer-pose-heading"><span><Bone size={15} />临时姿态预览</span><small>点击骨骼后拖动旋转环，不会保存或修改模型</small></div>
              <button className={`viewer-pose-visibility ${showSkeleton ? "active" : ""}`} onClick={() => setShowSkeleton((value) => !value)} type="button"><Check size={14} />{showSkeleton ? "隐藏骨骼线" : "显示骨骼线"}</button>
              <label className="viewer-pose-bone-select">
                <span>选择骨骼</span>
                <select value={selectedPoseBoneId} disabled={poseLockedByAnimation} onChange={(event) => selectPoseBone(event.target.value)}>
                  {poseBones.map((bone) => <option value={bone.id} key={bone.id}>{bone.name}</option>)}
                </select>
              </label>
              <div className="viewer-pose-axes">
                {(["x", "y", "z"] as const).map((axis) => (
                  <label key={axis}>
                    <span><b>{axis.toUpperCase()}</b> 旋转<output>{selectedPoseRotation[axis]}°</output></span>
                    <input type="range" min="-180" max="180" step="1" disabled={poseLockedByAnimation} value={selectedPoseRotation[axis]} onChange={(event) => updatePoseRotation(axis, Number(event.target.value))} aria-label={`${axis.toUpperCase()} 轴旋转`} />
                  </label>
                ))}
              </div>
              <div className="viewer-pose-actions">
                <button type="button" disabled={poseLockedByAnimation} onClick={resetSelectedPoseBone}><RotateCcw size={13} />复位当前骨骼</button>
                <button type="button" disabled={poseLockedByAnimation} onClick={resetEntirePose}><RotateCcw size={13} />复位全部姿态</button>
              </div>
              {poseLockedByAnimation && <p className="viewer-pose-locked">动画预览占用骨骼。点击动画面板中的“恢复静态姿态”后可继续手动摆姿态。</p>}
            </div>}
          </div>
        )}
        <div className="model-viewer-menu">
          <button className={`viewer-tool-button ${showGrid ? "active" : ""}`} onClick={() => togglePanel("grid")} type="button" title="网格设置" aria-label="网格设置" aria-expanded={openPanel === "grid"} aria-haspopup="menu">
            <Grid3X3 size={16} />
          </button>
          {openPanel === "grid" && <div className="viewer-options" role="menu" aria-label="网格显示选项">
            <button className={!showGrid ? "active" : ""} onClick={() => applyOption(() => setShowGrid(false))} type="button" role="menuitem"><Check size={14} />隐藏网格</button>
            <button className={showGrid ? "active" : ""} onClick={() => applyOption(() => setShowGrid(true))} type="button" role="menuitem"><Check size={14} />显示网格</button>
          </div>}
        </div>
        <div className="model-viewer-menu">
          <button className="viewer-tool-button" onClick={() => togglePanel("view")} type="button" title="视角设置" aria-label="视角设置" aria-expanded={openPanel === "view"} aria-haspopup="menu">
            <Focus size={16} />
          </button>
          {openPanel === "view" && <div className="viewer-options" role="menu" aria-label="视角选项">
            <button onClick={() => applyOption(() => resetViewRef.current())} type="button" role="menuitem">默认视角</button>
            <button onClick={() => applyOption(() => setCameraViewRef.current("front"))} type="button" role="menuitem">正面视角</button>
            <button onClick={() => applyOption(() => setCameraViewRef.current("back"))} type="button" role="menuitem">背面视角</button>
            <button onClick={() => applyOption(() => setCameraViewRef.current("left"))} type="button" role="menuitem">左侧视角</button>
            <button onClick={() => applyOption(() => setCameraViewRef.current("right"))} type="button" role="menuitem">右侧视角</button>
          </div>}
        </div>
      </div>

      {showAnimationSidebar && (
        <aside className={`viewer-animation-sidebar ${animationSidebarCollapsed ? "collapsed" : ""}`} aria-label="动画预览">
          <input ref={animationFileRef} hidden type="file" accept=".fbx,application/octet-stream" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAnimation(file); event.currentTarget.value = ""; }} />
          <header>
            <span><Film size={16} /></span>
            <div><strong>动画预览</strong><small>点击片段立即播放</small></div>
            <button className="viewer-animation-import" type="button" disabled={animationBusy} onClick={() => animationFileRef.current?.click()} title="导入 FBX" aria-label="导入 FBX"><Upload size={14} /></button>
            <button className="viewer-animation-sidebar-toggle" type="button" onClick={() => setAnimationSidebarCollapsed((value) => !value)} title={animationSidebarCollapsed ? "展开动画侧栏" : "收起动画侧栏"} aria-label={animationSidebarCollapsed ? "展开动画侧栏" : "收起动画侧栏"} aria-expanded={!animationSidebarCollapsed}><PersonStanding size={17} /></button>
          </header>
          {!animationSidebarCollapsed && (animationsLoading ? (
            <div className="viewer-animation-empty"><LoaderCircle className="spinning" size={18} />正在读取动画库…</div>
          ) : animations.length ? (
            <>
              <div className="viewer-animation-list" role="list" aria-label="动画片段">
                {animations.map((animation) => {
                  const selected = animation.id === selectedAnimationId;
                  const loadingAnimation = animationBusy && selected;
                  return (
                    <button
                      className={selected ? "active" : ""}
                      type="button"
                      aria-pressed={selected}
                      disabled={animationBusy || !animation.compatible}
                      onClick={() => void previewAnimation(animation.id)}
                      key={animation.id}
                    >
                      <span>{loadingAnimation ? <LoaderCircle className="spinning" size={14} /> : selected && animationPlaying ? <Pause size={14} /> : <Play size={14} />}</span>
                      <span><strong>{animation.name}</strong><small>{animation.duration.toFixed(2)} 秒 · {animation.mappedBoneCount} 骨骼</small></span>
                      {animation.bundled && <em>内置</em>}
                    </button>
                  );
                })}
              </div>
              <div className="viewer-animation-details">
                {selectedAnimation && <div className="viewer-animation-meta">
                  <span className={selectedAnimation.compatible ? "compatible" : "incompatible"}>{selectedAnimation.compatible ? "Mixamo 骨骼已匹配" : "骨骼不完整"}</span>
                  <small>{selectedAnimation.trackCount} 条轨道 · {selectedAnimation.mappedBoneCount} 根目标骨骼</small>
                </div>}
                <div className="viewer-animation-controls">
                  <button className="primary" type="button" disabled={animationBusy || !selectedAnimation?.compatible} onClick={() => void toggleAnimationPlayback()}>{animationBusy ? <LoaderCircle className="spinning" size={14} /> : animationPlaying ? <Pause size={14} /> : <Play size={14} />}{animationBusy ? "处理中" : animationPlaying ? "暂停" : "继续"}</button>
                  <button type="button" disabled={animationBusy || !selectedAnimation?.compatible} onClick={() => void restartAnimation()}><RotateCcw size={14} />重播</button>
                  <button type="button" disabled={!poseLockedByAnimation} onClick={clearAnimationPreview}><Bone size={14} />静态</button>
                </div>
                <label className="viewer-animation-timeline">
                  <span><output>{formatClipTime(animationTime)}</output><output>{formatClipTime(timelineDuration)}</output></span>
                  <input aria-label="动画播放进度" type="range" min="0" max={Math.max(timelineDuration, 0.01)} step="0.01" disabled={!poseLockedByAnimation} value={Math.min(animationTime, Math.max(timelineDuration, 0.01))} onChange={(event) => scrubAnimation(Number(event.target.value))} />
                </label>
                <div className="viewer-animation-options">
                  <label><input type="checkbox" checked={animationLoop} onChange={(event) => setAnimationLoop(event.target.checked)} />循环</label>
                  <label><input type="checkbox" checked={animationInPlace} onChange={(event) => { clearAnimationPreview(); setAnimationInPlace(event.target.checked); }} />原地</label>
                  <label><span>速度</span><select value={animationSpeed} onChange={(event) => setAnimationSpeed(Number(event.target.value))}><option value="0.5">0.5x</option><option value="0.75">0.75x</option><option value="1">1.0x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2.0x</option></select></label>
                </div>
                <div className="viewer-animation-library-actions">
                  <button type="button" disabled={animationBusy} onClick={() => animationFileRef.current?.click()}><Upload size={14} />导入</button>
                  <button className={pendingAnimationDeleteId === selectedAnimationId ? "confirm-delete" : ""} type="button" disabled={animationBusy || !selectedAnimation || selectedAnimation.bundled} onClick={() => void deleteSelectedAnimation()} title={selectedAnimation?.bundled ? "内置动画由仓库版本管理" : "删除动画"}><Trash2 size={14} />{selectedAnimation?.bundled ? "内置动画" : pendingAnimationDeleteId === selectedAnimationId ? "确认删除" : "删除"}</button>
                </div>
                {animationError && <div className="viewer-animation-error">{animationError}</div>}
              </div>
            </>
          ) : (
            <div className="viewer-animation-empty"><Film size={20} /><strong>动画库为空</strong><span>导入 Mixamo 的 FBX Binary／Without Skin 文件。</span><button type="button" onClick={() => animationFileRef.current?.click()}><Upload size={14} />导入第一个动画</button></div>
          ))}
        </aside>
      )}

      <div className="model-viewer-lighting">
        <button className={`viewer-tool-button ${openPanel === "lighting" ? "active" : ""}`} onClick={() => togglePanel("lighting")} type="button" title="灯光设置" aria-label="灯光设置" aria-expanded={openPanel === "lighting"} aria-haspopup="dialog">
          <Lightbulb size={16} />
        </button>
        {openPanel === "lighting" && <div className="viewer-lighting-panel" role="dialog" aria-label="灯光设置面板">
          <div className="viewer-lighting-heading"><Lightbulb size={16} /><strong>灯光设置</strong></div>
          <label className="viewer-lighting-field">
            <span><CloudSun size={15} />环境光 <output>{environmentIntensity.toFixed(1)}x</output></span>
            <div><input aria-label="环境光颜色" type="color" value={environmentColor} onChange={(event) => setEnvironmentColor(event.target.value)} /><input aria-label="环境光强度" type="range" min="0" max="2.5" step="0.1" value={environmentIntensity} onChange={(event) => setEnvironmentIntensity(Number(event.target.value))} /></div>
          </label>
          <label className="viewer-lighting-field">
            <span><SunMedium size={15} />直射光 <output>{directionalIntensity.toFixed(1)}x</output></span>
            <div><input aria-label="直射光颜色" type="color" value={directionalColor} onChange={(event) => setDirectionalColor(event.target.value)} /><input aria-label="直射光强度" type="range" min="0" max="2.5" step="0.1" value={directionalIntensity} onChange={(event) => setDirectionalIntensity(Number(event.target.value))} /></div>
          </label>
          <label className="viewer-lighting-field viewer-background-field">
            <span><Palette size={15} />背景</span>
            <input aria-label="背景颜色" type="color" value={backgroundColor} onChange={(event) => setBackgroundColor(event.target.value)} />
          </label>
        </div>}
      </div>

      <div className="model-viewer-help">{animationPlaying ? "正在播放 Mixamo 动画 · 仅用于预览" : poseLockedByAnimation ? "动画已暂停 · 可拖动时间轴检查蒙皮" : showSkeleton && rigged ? "点击骨骼选择 · 拖动彩色旋转环摆姿态 · 不会保存" : wireframe ? "拓扑模式：原材质 + 白色线框" : "左键旋转 · 滚轮缩放 · 右键平移"}</div>
      {stats && (
        <div className="model-viewer-stats">
          <span>{stats.meshes} MESH</span>
          <span>{stats.bones} BONE</span>
          <span>{stats.vertices.toLocaleString()} VERT</span>
          <span>{stats.triangles.toLocaleString()} TRI</span>
        </div>
      )}
      {loading && <div className="model-viewer-state"><i /><strong>正在读取真实 GLB</strong><span>{label}</span></div>}
      {error && <div className="model-viewer-state error"><strong>3D 预览加载失败</strong><span>{error}</span></div>}
    </div>
  );
}
