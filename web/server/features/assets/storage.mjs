import { randomUUID } from "node:crypto";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export function createAssetStorage({ animationDir, db, formatBytes, generatedDir, outputRoot, sourceImageMaxBytes }) {
  const MIXAMO_TARGET_BONES = new Set([
    "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    "LeftHandThumb1", "LeftHandThumb2", "LeftHandThumb3",
    "LeftHandIndex1", "LeftHandIndex2", "LeftHandIndex3",
    "LeftHandMiddle1", "LeftHandMiddle2", "LeftHandMiddle3",
    "LeftHandRing1", "LeftHandRing2", "LeftHandRing3",
    "RightHandThumb1", "RightHandThumb2", "RightHandThumb3",
    "RightHandIndex1", "RightHandIndex2", "RightHandIndex3",
    "RightHandMiddle1", "RightHandMiddle2", "RightHandMiddle3",
    "RightHandRing1", "RightHandRing2", "RightHandRing3",
    "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
    "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
  ]);
  const MIXAMO_REQUIRED_BONES = new Set([
    "Hips", "Spine", "Head",
    "LeftArm", "LeftForeArm", "LeftHand",
    "RightArm", "RightForeArm", "RightHand",
    "LeftUpLeg", "LeftLeg", "LeftFoot",
    "RightUpLeg", "RightLeg", "RightFoot",
  ]);
  
  function normalizeMixamoBoneName(value) {
    return String(value || "").replace(/^mixamorig[:_]?/i, "");
  }
  
  async function inspectAnimationFbx(buffer) {
    if (!buffer.length || buffer.length > 15 * 1024 * 1024) throw new Error("动画 FBX 不能为空且不能超过 15 MB");
    if (!globalThis.self) globalThis.self = globalThis;
    const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
    const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    let object;
    try {
      object = new FBXLoader().parse(bytes, "");
    } catch (error) {
      throw new Error(`FBX 解析失败：${error instanceof Error ? error.message : "文件格式不受支持"}`);
    }
    const clip = object.animations?.[0];
    if (!clip || !clip.tracks.length || !(clip.duration > 0)) throw new Error("FBX 中没有可播放的动画片段");
    const boneNames = [...new Set(clip.tracks.map((track) => normalizeMixamoBoneName(track.name.split(".")[0])).filter(Boolean))];
    const mappedBoneCount = boneNames.filter((name) => MIXAMO_TARGET_BONES.has(name)).length;
    const compatible = [...MIXAMO_REQUIRED_BONES].every((name) => boneNames.includes(name));
    return {
      clipName: clip.name || "mixamo.com",
      duration: Number(clip.duration.toFixed(4)),
      trackCount: clip.tracks.length,
      boneCount: boneNames.length,
      mappedBoneCount,
      compatible,
      boneNames,
    };
  }
  
  const animationSelect = `
    SELECT id, name, filename, file_path AS filePath, size, duration,
      track_count AS trackCount, bone_count AS boneCount, mapped_bone_count AS mappedBoneCount,
      compatible, bone_names AS boneNamesJson, created_at AS createdAt, updated_at AS updatedAt
    FROM animation_assets
  `;
  
  function serializeAnimationAsset(row) {
    if (!row) return null;
    let boneNames = [];
    try {
      boneNames = JSON.parse(row.boneNamesJson || "[]");
    } catch {
      boneNames = [];
    }
    const publicRow = { ...row };
    delete publicRow.filePath;
    delete publicRow.boneNamesJson;
    return {
      ...publicRow,
      compatible: Boolean(row.compatible),
      boneNames,
      fileUrl: `/api/animations/${encodeURIComponent(row.id)}/file`,
    };
  }
  
  function getAnimationAsset(id) {
    return db.prepare(`${animationSelect} WHERE id = ?`).get(id);
  }
  
  function listAnimationAssets() {
    return db.prepare(`${animationSelect} ORDER BY created_at ASC`).all()
      .filter((row) => row.filePath && existsSync(row.filePath) && statSync(row.filePath).isFile())
      .map(serializeAnimationAsset);
  }
  
  async function createAnimationAsset(input = {}) {
    const filename = basename(cleanText(input.filename, 180, "动画文件名", true));
    if (extname(filename).toLowerCase() !== ".fbx") throw new Error("只支持 Mixamo FBX 动画文件");
    const encoded = typeof input.data === "string" ? input.data.replace(/^data:[^,]+,/, "").replace(/\s+/g, "") : "";
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("动画文件内容无效");
    const buffer = Buffer.from(encoded, "base64");
    const inspection = await inspectAnimationFbx(buffer);
    const id = randomUUID();
    const filePath = join(animationDir, `${id}.fbx`);
    const now = new Date().toISOString();
    const name = cleanText(input.name, 80, "动画名称") || basename(filename, extname(filename));
    writeFileSync(filePath, buffer, { flag: "wx" });
    try {
      db.prepare(`
        INSERT INTO animation_assets (
          id, name, filename, file_path, size, duration, track_count, bone_count,
          mapped_bone_count, compatible, bone_names, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, name, filename, filePath, buffer.length, inspection.duration, inspection.trackCount,
        inspection.boneCount, inspection.mappedBoneCount, inspection.compatible ? 1 : 0,
        JSON.stringify(inspection.boneNames), now, now,
      );
    } catch (error) {
      if (existsSync(filePath)) unlinkSync(filePath);
      throw error;
    }
    return serializeAnimationAsset(getAnimationAsset(id));
  }
  
  function deleteAnimationAsset(id) {
    const row = getAnimationAsset(id);
    if (!row) throw new Error("动画不存在");
    const candidate = resolve(row.filePath);
    const root = resolve(animationDir);
    const normalized = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
    if (!(normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${sep}`))) throw new Error("拒绝删除动画目录之外的文件");
    if (existsSync(candidate) && statSync(candidate).isFile()) unlinkSync(candidate);
    db.prepare("DELETE FROM animation_assets WHERE id = ?").run(id);
    return { ok: true, animations: listAnimationAssets() };
  }
  
  function saveSourceImage(image, prefix = randomUUID()) {
    if (!image || typeof image !== "object") return null;
    const mimeType = typeof image.mimeType === "string" ? image.mimeType.toLowerCase() : "";
    const extensions = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
    const extension = extensions[mimeType];
    if (!extension) throw new Error("原画只支持 PNG、JPEG 或 WebP");
    const raw = typeof image.data === "string" ? image.data.replace(/^data:[^;]+;base64,/, "") : "";
    if (!raw || !/^[a-zA-Z0-9+/=\r\n]+$/.test(raw)) throw new Error("原画数据无效");
    const data = Buffer.from(raw, "base64");
    if (!data.length || data.length > sourceImageMaxBytes) throw new Error(`原画不能超过 ${formatBytes(sourceImageMaxBytes)}`);
    const isPng = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const isWebp = data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
    if ((mimeType === "image/png" && !isPng) || (mimeType === "image/jpeg" && !isJpeg) || (mimeType === "image/webp" && !isWebp)) {
      throw new Error("原画内容与文件类型不匹配");
    }
    const filename = `${prefix}${extension}`;
    const filePath = join(generatedDir, filename);
    writeFileSync(filePath, data);
    return { filePath, previewPath: `/generated/${filename}?v=${Date.now()}`, mimeType };
  }
  
  function resolveRunSourceImage(input = {}) {
    return input.sourceImagePath
      ? (() => {
          const filePath = resolve(input.sourceImagePath);
          const inGenerated = filePath.startsWith(`${generatedDir}${sep}`);
          const inOutput = filePath.startsWith(`${outputRoot}${sep}`);
          if ((!inGenerated && !inOutput) || !existsSync(filePath) || !statSync(filePath).isFile()) throw new Error("角色原画不在受控目录中");
          return { filePath, previewPath: input.sourcePreviewPath || null };
        })()
      : saveSourceImage(input.sourceImage, `source-${randomUUID()}`);
  }
  

  return {
    animations: { create: createAnimationAsset, get: getAnimationAsset, list: listAnimationAssets, remove: deleteAnimationAsset },
    resolveRunSourceImage,
    saveSourceImage,
  };
}
