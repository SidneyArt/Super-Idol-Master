"use client";

import { Bone, Check, CloudSun, Focus, Grid3X3, Lightbulb, Orbit, Palette, RotateCcw, SunMedium, Triangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

type ModelViewerProps = {
  src: string;
  label: string;
  rigged?: boolean;
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
type PoseBoneRuntime = { bone: THREE.Bone; restQuaternion: THREE.Quaternion };
type BonePickerRuntime = {
  mesh: THREE.Mesh;
  bone: THREE.Bone;
  parentBone: THREE.Bone | null;
  kind: "joint" | "segment";
};

const EMPTY_POSE_ROTATION: PoseRotation = { x: 0, y: 0, z: 0 };

function rotationFromRestPose(runtime: PoseBoneRuntime): PoseRotation {
  const delta = runtime.restQuaternion.clone().invert().multiply(runtime.bone.quaternion).normalize();
  const euler = new THREE.Euler().setFromQuaternion(delta, "XYZ");
  const degrees = (value: number) => Math.round(THREE.MathUtils.radToDeg(value));
  return { x: degrees(euler.x), y: degrees(euler.y), z: degrees(euler.z) };
}

function disposeMaterial(material: THREE.Material) {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  material.dispose();
}

export default function ModelViewer({ src, label, rigged = false }: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
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
  const resetViewRef = useRef<() => void>(() => undefined);
  const setCameraViewRef = useRef<(view: CameraView) => void>(() => undefined);
  const autoRotateRef = useRef(false);
  const skeletonVisibleRef = useRef(rigged);
  const wireframeRef = useRef(false);
  const showGridRef = useRef(true);
  const environmentColorRef = useRef("#ffffff");
  const environmentIntensityRef = useRef(1);
  const directionalColorRef = useRef("#ffffff");
  const directionalIntensityRef = useRef(0.5);
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
  const [directionalIntensity, setDirectionalIntensity] = useState(0.5);
  const [backgroundColor, setBackgroundColor] = useState("#464646");
  const [stats, setStats] = useState<ModelStats | null>(null);
  const [poseBones, setPoseBones] = useState<PoseBoneOption[]>([]);
  const [selectedPoseBoneId, setSelectedPoseBoneId] = useState("");
  const [selectedPoseRotation, setSelectedPoseRotation] = useState<PoseRotation>(EMPTY_POSE_ROTATION);
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
    autoRotateRef.current = autoRotate;
    if (controlsRef.current) controlsRef.current.autoRotate = autoRotate;
  }, [autoRotate]);

  useEffect(() => {
    skeletonVisibleRef.current = showSkeleton;
    if (skeletonRef.current) skeletonRef.current.visible = showSkeleton;
    const transformControls = transformControlsRef.current;
    if (transformControls) {
      transformControls.enabled = showSkeleton;
      transformControls.getHelper().visible = showSkeleton && Boolean(selectedPoseBoneIdRef.current);
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
      transformControls.enabled = skeletonVisibleRef.current;
      transformControls.getHelper().visible = skeletonVisibleRef.current;
    } else {
      transformControls?.detach();
    }
  }

  function updatePoseRotation(axis: PoseAxis, value: number) {
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
    const runtime = poseBonesRef.current.get(selectedPoseBoneId);
    if (!runtime) return;
    runtime.bone.quaternion.copy(runtime.restQuaternion);
    runtime.bone.updateMatrixWorld(true);
    poseRotationsRef.current.set(selectedPoseBoneId, { ...EMPTY_POSE_ROTATION });
    setSelectedPoseRotation({ ...EMPTY_POSE_ROTATION });
  }

  function resetEntirePose() {
    for (const [id, runtime] of poseBonesRef.current) {
      runtime.bone.quaternion.copy(runtime.restQuaternion);
      runtime.bone.updateMatrixWorld(true);
      poseRotationsRef.current.set(id, { ...EMPTY_POSE_ROTATION });
    }
    setSelectedPoseRotation({ ...EMPTY_POSE_ROTATION });
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let frameId = 0;
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
      if (event.button !== 0 || !skeletonVisibleRef.current || transformControls.dragging || transformControls.axis) return;
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
            poseBonesRef.current.set(id, { bone: object, restQuaternion: object.quaternion.clone() });
            poseRotationsRef.current.set(id, { ...EMPTY_POSE_ROTATION });
          }
        });
        for (const { source, overlay } of wireframeOverlays) {
          source.parent?.add(overlay);
          wireframeOverlaysRef.current.add(overlay);
        }

        scene.add(model);
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
      controls.update();
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

  function chooseOption(action: () => void) {
    action();
    setOpenPanel(null);
  }

  return (
    <div className="model-viewer-shell">
      <div ref={hostRef} className="model-viewer-canvas" aria-label={`${label} 交互式三维预览`} />

      <div className="model-viewer-toolbar" aria-label="三维预览控制">
        <div className="model-viewer-menu">
          <button className={`viewer-tool-button ${wireframe ? "active" : ""}`} onClick={() => togglePanel("render")} type="button" title="显示模式" aria-label="显示模式" aria-expanded={openPanel === "render"} aria-haspopup="menu">
            <Triangle size={16} />
          </button>
          {openPanel === "render" && <div className="viewer-options" role="menu" aria-label="显示模式选项">
            <button className={!wireframe ? "active" : ""} onClick={() => chooseOption(() => setWireframe(false))} type="button" role="menuitem"><Check size={14} />实体材质</button>
            <button className={wireframe ? "active" : ""} onClick={() => chooseOption(() => setWireframe(true))} type="button" role="menuitem"><Check size={14} />拓扑线框</button>
          </div>}
        </div>
        <div className="model-viewer-menu">
          <button className={`viewer-tool-button ${autoRotate ? "active" : ""}`} onClick={() => togglePanel("rotation")} type="button" title="旋转设置" aria-label="旋转设置" aria-expanded={openPanel === "rotation"} aria-haspopup="menu">
            <Orbit size={16} />
          </button>
          {openPanel === "rotation" && <div className="viewer-options" role="menu" aria-label="旋转选项">
            <button className={!autoRotate ? "active" : ""} onClick={() => chooseOption(() => setAutoRotate(false))} type="button" role="menuitem"><Check size={14} />停止旋转</button>
            <button className={autoRotate ? "active" : ""} onClick={() => chooseOption(() => setAutoRotate(true))} type="button" role="menuitem"><Check size={14} />自动旋转</button>
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
                <select value={selectedPoseBoneId} onChange={(event) => selectPoseBone(event.target.value)}>
                  {poseBones.map((bone) => <option value={bone.id} key={bone.id}>{bone.name}</option>)}
                </select>
              </label>
              <div className="viewer-pose-axes">
                {(["x", "y", "z"] as const).map((axis) => (
                  <label key={axis}>
                    <span><b>{axis.toUpperCase()}</b> 旋转<output>{selectedPoseRotation[axis]}°</output></span>
                    <input type="range" min="-180" max="180" step="1" value={selectedPoseRotation[axis]} onChange={(event) => updatePoseRotation(axis, Number(event.target.value))} aria-label={`${axis.toUpperCase()} 轴旋转`} />
                  </label>
                ))}
              </div>
              <div className="viewer-pose-actions">
                <button type="button" onClick={resetSelectedPoseBone}><RotateCcw size={13} />复位当前骨骼</button>
                <button type="button" onClick={resetEntirePose}><RotateCcw size={13} />复位全部姿态</button>
              </div>
            </div>}
          </div>
        )}
        <div className="model-viewer-menu">
          <button className={`viewer-tool-button ${showGrid ? "active" : ""}`} onClick={() => togglePanel("grid")} type="button" title="网格设置" aria-label="网格设置" aria-expanded={openPanel === "grid"} aria-haspopup="menu">
            <Grid3X3 size={16} />
          </button>
          {openPanel === "grid" && <div className="viewer-options" role="menu" aria-label="网格显示选项">
            <button className={!showGrid ? "active" : ""} onClick={() => chooseOption(() => setShowGrid(false))} type="button" role="menuitem"><Check size={14} />隐藏网格</button>
            <button className={showGrid ? "active" : ""} onClick={() => chooseOption(() => setShowGrid(true))} type="button" role="menuitem"><Check size={14} />显示网格</button>
          </div>}
        </div>
        <div className="model-viewer-menu">
          <button className="viewer-tool-button" onClick={() => togglePanel("view")} type="button" title="视角设置" aria-label="视角设置" aria-expanded={openPanel === "view"} aria-haspopup="menu">
            <Focus size={16} />
          </button>
          {openPanel === "view" && <div className="viewer-options" role="menu" aria-label="视角选项">
            <button onClick={() => chooseOption(() => resetViewRef.current())} type="button" role="menuitem">默认视角</button>
            <button onClick={() => chooseOption(() => setCameraViewRef.current("front"))} type="button" role="menuitem">正面视角</button>
            <button onClick={() => chooseOption(() => setCameraViewRef.current("back"))} type="button" role="menuitem">背面视角</button>
            <button onClick={() => chooseOption(() => setCameraViewRef.current("left"))} type="button" role="menuitem">左侧视角</button>
            <button onClick={() => chooseOption(() => setCameraViewRef.current("right"))} type="button" role="menuitem">右侧视角</button>
          </div>}
        </div>
      </div>

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

      <div className="model-viewer-help">{showSkeleton && rigged ? "点击骨骼选择 · 拖动彩色旋转环摆姿态 · 不会保存" : wireframe ? "拓扑模式：原材质 + 白色线框" : "左键旋转 · 滚轮缩放 · 右键平移"}</div>
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
