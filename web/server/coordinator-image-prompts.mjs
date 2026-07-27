const SINGLE_CHARACTER_NEGATIVE = [
  "多人",
  "第二个人物",
  "额外人物",
  "重复角色",
  "角色分身",
  "镜像人物",
  "双胞胎",
  "人物重叠",
  "多个身体",
  "多个头部",
  "角色合集",
  "角色展示板",
  "角色设定表",
  "分镜",
];

export function buildCoordinatorImagePrompts({
  characterCount,
  descriptions,
  style,
  additional = "",
  negative = "",
}) {
  if (characterCount === 1) {
    const positive = [
      "生成一张单角色原画，画面中必须只有一个人物、一个身体和一个头部。",
      `角色设定：${descriptions[0]}。`,
      `美术风格：${style}。`,
      "角色居中并完整全身出镜，背景简洁。禁止出现其他人物、分身、镜像人物、角色草图、角色设定表或角色展示板。",
      additional,
    ].filter(Boolean).join(" ").slice(0, 6000);
    const fallback = "低画质，肢体畸形，裁切身体，文字，水印";
    const negativePrompt = `${SINGLE_CHARACTER_NEGATIVE.join("，")}，${negative || fallback}`.slice(0, 2000);
    return { positive, negative: negativePrompt };
  }

  const enumerated = descriptions.map((item, index) => `${index + 1}. ${item}`).join("；");
  const positive = [
    `生成一张角色原画合集图，单张画布内准确包含 ${characterCount} 个不同角色。`,
    `所有角色保持完全一致的美术风格：${style}。`,
    `角色设定：${enumerated}。`,
    "横向整齐排列，每个角色及其全部装备占据独立的等宽安全区域，角色之间保留清晰可见的背景间隔。每个角色必须完整全身、彼此分离且不重叠；头发、帽檐、披风、手脚、武器、盾牌和法杖都不得伸入相邻角色区域或越出画布。比例统一，光照统一，背景简洁，清晰展示服装、配色和身份差异。不要拆成多张图片，不要生成角色卡边框或文字标签。",
    additional,
  ].filter(Boolean).join(" ").slice(0, 6000);
  return { positive, negative };
}

export function buildSingleCharacterTaskPrompts({
  description = "",
  positivePrompt = "",
  negativePrompt = "",
}) {
  const positive = [
    "单人单角色构图，画面中只能有一个完整角色，禁止出现第二个人物、分身、镜像人物或角色展示板。",
    description,
    positivePrompt,
  ].filter(Boolean).join("，").slice(0, 4000);
  const negative = [
    "多人",
    "第二个人物",
    "额外人物",
    "重复角色",
    "角色分身",
    "镜像人物",
    "双胞胎",
    "人物重叠",
    "多个身体",
    "多个头部",
    "角色合集",
    "角色展示板",
    "角色设定表",
    negativePrompt,
  ].filter(Boolean).join("，").slice(0, 2000);
  return { positivePrompt: positive, negativePrompt: negative };
}
