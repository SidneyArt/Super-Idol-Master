export type AnimationAsset = {
  id: string;
  name: string;
  filename: string;
  size: number;
  duration: number;
  trackCount: number;
  boneCount: number;
  mappedBoneCount: number;
  compatible: boolean;
  boneNames: string[];
  fileUrl: string;
  createdAt: string;
};

type AnimationCollection = {
  animation?: AnimationAsset;
  animations?: AnimationAsset[];
  error?: string;
};

async function jsonRequest(
  url: string,
  init: RequestInit,
  fallbackError: string,
): Promise<AnimationCollection> {
  const response = await fetch(url, init);
  const data = await response.json() as AnimationCollection;
  if (!response.ok) throw new Error(data.error || fallbackError);
  return data;
}

export async function fetchAnimations(baseUrl: string, signal: AbortSignal) {
  const data = await jsonRequest(
    `${baseUrl}/api/animations`,
    { signal },
    "动画库读取失败",
  );
  return Array.isArray(data.animations) ? data.animations : [];
}

export async function fetchAnimationFile(baseUrl: string, fileUrl: string) {
  const url = fileUrl.startsWith("http") ? fileUrl : `${baseUrl}${fileUrl}`;
  const response = await fetch(url);
  if (!response.ok) {
    let message = "动画文件读取失败";
    try {
      message = (await response.json() as { error?: string }).error || message;
    } catch {
      // Animation downloads normally return binary data.
    }
    throw new Error(message);
  }
  return { data: await response.arrayBuffer(), url };
}

export async function createAnimation(
  baseUrl: string,
  input: { filename: string; name: string; data: string },
) {
  const result = await jsonRequest(
    `${baseUrl}/api/animations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    "动画上传失败",
  );
  return {
    animation: result.animation || null,
    animations: Array.isArray(result.animations) ? result.animations : [],
  };
}

export async function removeAnimation(baseUrl: string, animationId: string) {
  const result = await jsonRequest(
    `${baseUrl}/api/animations/${encodeURIComponent(animationId)}`,
    { method: "DELETE" },
    "动画删除失败",
  );
  return Array.isArray(result.animations) ? result.animations : [];
}
