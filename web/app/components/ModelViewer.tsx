"use client";

import { Bone, Focus, Grid3X3, Orbit, Palette, SunMedium, Triangle } from "lucide-react";
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
  const autoRotateRef = useRef(false);
  const skeletonVisibleRef = useRef(false);
  const wireframeRef = useRef(false);
  const showGridRef = useRef(true);
  const lightingRef = useRef(1.2);
  const backgroundColorRef = useRef("#0b0e12");
  const materialsRef = useRef<Set<WireframeMaterial>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [autoRotate, setAutoRotate] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [lighting, setLighting] = useState(1.2);
  const [backgroundColor, setBackgroundColor] = useState("#0b0e12");
  const [stats, setStats] = useState<ModelStats | null>(null);

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
    lightingRef.current = lighting;
    const lights = lightsRef.current;
    if (!lights) return;
    lights.hemisphere.intensity = 3.2 * lighting;
    lights.key.intensity = 4.5 * lighting;
    lights.rim.intensity = 2.5 * lighting;
    lights.fill.intensity = 1.9 * lighting;
  }, [lighting]);

  useEffect(() => {
    backgroundColorRef.current = backgroundColor;
    const scene = sceneRef.current;
    if (!scene) return;
    scene.background = new THREE.Color(backgroundColor);
    if (scene.fog) scene.fog.color.set(backgroundColor);
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
    scene.fog = new THREE.FogExp2(backgroundColorRef.current, 0.025);
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

    const hemisphere = new THREE.HemisphereLight(0xe8f2ff, 0x18202a, 3.2 * lightingRef.current);
    scene.add(hemisphere);
    const keyLight = new THREE.DirectionalLight(0xffffff, 4.5 * lightingRef.current);
    keyLight.position.set(5, 8, 7);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x70b7ff, 2.5 * lightingRef.current);
    rimLight.position.set(-6, 3, -5);
    scene.add(rimLight);
    const fillLight = new THREE.DirectionalLight(0xffd6a1, 1.9 * lightingRef.current);
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
        scene.fog = new THREE.FogExp2(backgroundColorRef.current, 0.55 / maxDimension);

        const fitView = () => {
          const verticalFov = THREE.MathUtils.degToRad(camera.fov);
          const fitHeightDistance = size.y / (2 * Math.tan(verticalFov / 2));
          const fitWidthDistance = size.x / (2 * Math.tan(verticalFov / 2) * Math.max(camera.aspect, 0.1));
          const distance = Math.max(fitHeightDistance, fitWidthDistance, maxDimension) * 1.25;
          const direction = new THREE.Vector3(0.78, 0.38, 1).normalize();
          camera.near = Math.max(distance / 100, 0.001);
          camera.far = Math.max(distance * 100, 100);
          camera.position.copy(center).addScaledVector(direction, distance);
          camera.updateProjectionMatrix();
          controls.target.copy(center);
          controls.minDistance = maxDimension * 0.15;
          controls.maxDistance = maxDimension * 12;
          controls.update();
        };
        resetViewRef.current = fitView;
        fitView();

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

  return (
    <div className="model-viewer-shell">
      <div ref={hostRef} className="model-viewer-canvas" aria-label={`${label} 交互式三维预览`} />

      <div className="model-viewer-toolbar" aria-label="三维预览控制">
        <button className={wireframe ? "active" : ""} onClick={() => setWireframe((value) => !value)} type="button" title={wireframe ? "显示材质" : "显示拓扑线框"}>
          <Triangle size={15} /><span>{wireframe ? "显示材质" : "拓扑线框"}</span>
        </button>
        <button className={autoRotate ? "active" : ""} onClick={() => setAutoRotate((value) => !value)} type="button" title={autoRotate ? "停止自动旋转" : "开始自动旋转"}>
          <Orbit size={15} /><span>{autoRotate ? "停止旋转" : "自动旋转"}</span>
        </button>
        {rigged && stats && stats.bones > 0 && (
          <button className={showSkeleton ? "active" : ""} onClick={() => setShowSkeleton((value) => !value)} type="button" title={showSkeleton ? "隐藏骨骼" : "显示骨骼"}>
            <Bone size={15} /><span>{showSkeleton ? "隐藏骨骼" : "显示骨骼"}</span>
          </button>
        )}
        <button className={showGrid ? "active" : ""} onClick={() => setShowGrid((value) => !value)} type="button" title={showGrid ? "隐藏地面网格" : "显示地面网格"}>
          <Grid3X3 size={15} /><span>{showGrid ? "隐藏网格" : "显示网格"}</span>
        </button>
        <button onClick={() => resetViewRef.current()} type="button" title="重置视角"><Focus size={15} /><span>重置视角</span></button>
        <label className="viewer-control viewer-range" title="调整预览灯光强度">
          <SunMedium size={15} /><span>灯光</span>
          <input aria-label="灯光强度" type="range" min="0.6" max="2.2" step="0.1" value={lighting} onChange={(event) => setLighting(Number(event.target.value))} />
          <output>{lighting.toFixed(1)}x</output>
        </label>
        <label className="viewer-control viewer-color" title="设置预览背景颜色">
          <Palette size={15} /><span>背景</span>
          <input aria-label="背景颜色" type="color" value={backgroundColor} onChange={(event) => setBackgroundColor(event.target.value)} />
        </label>
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
