"use client";

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
  const skeletonRef = useRef<THREE.SkeletonHelper | null>(null);
  const resetViewRef = useRef<() => void>(() => undefined);
  const autoRotateRef = useRef(true);
  const skeletonVisibleRef = useRef(false);
  const wireframeRef = useRef(false);
  const materialsRef = useRef<Set<WireframeMaterial>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [autoRotate, setAutoRotate] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [wireframe, setWireframe] = useState(false);
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
    scene.background = new THREE.Color(0x090d14);
    scene.fog = new THREE.FogExp2(0x090d14, 0.025);

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

    scene.add(new THREE.HemisphereLight(0xdcecff, 0x10151e, 2.4));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
    keyLight.position.set(5, 8, 7);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x31e6ce, 2.2);
    rimLight.position.set(-6, 3, -5);
    scene.add(rimLight);
    const fillLight = new THREE.DirectionalLight(0x8d7cff, 1.6);
    fillLight.position.set(4, 1, -6);
    scene.add(fillLight);

    const grid = new THREE.GridHelper(20, 20, 0x314052, 0x18202c);
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.65;
    scene.add(grid);

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
        scene.fog = new THREE.FogExp2(0x090d14, 0.55 / maxDimension);

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
        <button className={wireframe ? "active" : ""} onClick={() => setWireframe((value) => !value)} type="button">
          {wireframe ? "显示材质" : "拓扑线框"}
        </button>
        <button className={autoRotate ? "active" : ""} onClick={() => setAutoRotate((value) => !value)} type="button">
          {autoRotate ? "停止旋转" : "自动旋转"}
        </button>
        {rigged && stats && stats.bones > 0 && (
          <button className={showSkeleton ? "active" : ""} onClick={() => setShowSkeleton((value) => !value)} type="button">
            {showSkeleton ? "隐藏骨骼" : "显示骨骼"}
          </button>
        )}
        <button onClick={() => resetViewRef.current()} type="button">重置视角</button>
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
