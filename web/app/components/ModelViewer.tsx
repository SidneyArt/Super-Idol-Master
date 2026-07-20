"use client";

import { Bone, Check, CloudSun, Focus, Grid3X3, Lightbulb, Orbit, Palette, SunMedium, Triangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

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

type WireframeMaterial = THREE.Material & { wireframe: boolean };
type ViewerPanel = "render" | "rotation" | "skeleton" | "grid" | "view" | "lighting";
type CameraView = "default" | "front" | "back" | "left" | "right";

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
  const resetViewRef = useRef<() => void>(() => undefined);
  const setCameraViewRef = useRef<(view: CameraView) => void>(() => undefined);
  const autoRotateRef = useRef(false);
  const skeletonVisibleRef = useRef(false);
  const wireframeRef = useRef(false);
  const showGridRef = useRef(true);
  const environmentColorRef = useRef("#ffffff");
  const environmentIntensityRef = useRef(1);
  const directionalColorRef = useRef("#ffffff");
  const directionalIntensityRef = useRef(0.5);
  const backgroundColorRef = useRef("#464646");
  const materialsRef = useRef<Set<WireframeMaterial>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [autoRotate, setAutoRotate] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [environmentColor, setEnvironmentColor] = useState("#ffffff");
  const [environmentIntensity, setEnvironmentIntensity] = useState(1);
  const [directionalColor, setDirectionalColor] = useState("#ffffff");
  const [directionalIntensity, setDirectionalIntensity] = useState(0.5);
  const [backgroundColor, setBackgroundColor] = useState("#464646");
  const [stats, setStats] = useState<ModelStats | null>(null);
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
  }, [showSkeleton]);

  useEffect(() => {
    wireframeRef.current = wireframe;
    for (const material of materialsRef.current) {
      material.wireframe = wireframe;
      material.needsUpdate = true;
    }
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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let frameId = 0;
    setLoading(true);
    setError("");
    setStats(null);
    setShowSkeleton(false);
    materialsRef.current = new Set();

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
        model.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            meshes += 1;
            const geometry = object.geometry;
            const position = geometry.getAttribute("position");
            vertices += position?.count || 0;
            triangles += geometry.index ? geometry.index.count / 3 : (position?.count || 0) / 3;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) {
              if ("wireframe" in material) {
                const wireframeMaterial = material as WireframeMaterial;
                wireframeMaterial.wireframe = wireframeRef.current;
                wireframeMaterial.needsUpdate = true;
                materialsRef.current.add(wireframeMaterial);
              }
            }
          }
          if (object instanceof THREE.Bone) bones += 1;
        });

        scene.add(model);
        const bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const maxDimension = Math.max(size.x, size.y, size.z, 0.1);
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
      sceneRef.current = null;
      gridRef.current = null;
      lightsRef.current = null;
      materialsRef.current = new Set();
      if (skeletonRef.current) {
        skeletonRef.current.geometry.dispose();
        const material = skeletonRef.current.material;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material.dispose();
      }
      skeletonRef.current = null;
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach(disposeMaterial);
        }
      });
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
            <button className={`viewer-tool-button ${showSkeleton ? "active" : ""}`} onClick={() => togglePanel("skeleton")} type="button" title="骨骼显示" aria-label="骨骼显示" aria-expanded={openPanel === "skeleton"} aria-haspopup="menu">
              <Bone size={16} />
            </button>
            {openPanel === "skeleton" && <div className="viewer-options" role="menu" aria-label="骨骼显示选项">
              <button className={!showSkeleton ? "active" : ""} onClick={() => chooseOption(() => setShowSkeleton(false))} type="button" role="menuitem"><Check size={14} />隐藏骨骼</button>
              <button className={showSkeleton ? "active" : ""} onClick={() => chooseOption(() => setShowSkeleton(true))} type="button" role="menuitem"><Check size={14} />显示骨骼</button>
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

      <div className="model-viewer-help">{wireframe ? "拓扑模式：GLB 三角面" : "左键旋转 · 滚轮缩放 · 右键平移"}</div>
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
