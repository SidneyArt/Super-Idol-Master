const REQUIRED_TPOSE_CONSTRAINTS = [
  { label: "单人主体", pattern: /单人|1\s*个|one\s+(person|character|subject)/i },
  { label: "完整全身", pattern: /完整全身|全身出镜|full[- ]?body/i },
  { label: "严格正视", pattern: /严格正视|正面朝向|front[- ]?facing|front view/i },
  { label: "T-Pose", pattern: /t[- ]?pose|t\s*姿势/i },
  { label: "双臂水平伸展", pattern: /双臂水平|手臂水平|arms?\s+(fully\s+)?horizontal/i },
  { label: "肢体无遮挡", pattern: /肢体无遮挡|无遮挡|unoccluded/i },
  { label: "双手完全空置", pattern: /双手(?:完全)?空置|双手空手|不拿任何物品|不持有任何道具|empty[- ]?hands|no (?:held )?(?:items|props|weapons)/i },
  { label: "纯白背景", pattern: /纯白背景|白色背景|white background/i },
];
const REQUIRED_TPOSE_SUFFIX = "严格正视标准 T-Pose，单人完整全身，双臂水平伸直，双手完全空置且不拿任何道具，纯白背景 RGB(255,255,255)";
const REQUIRED_TPOSE_NEGATIVE_SUFFIX = "非T-Pose，A-Pose，V-Pose，手臂下垂，手臂倾斜，弯肘，手持物，道具，武器，非纯白背景，阴影，裁切";
const MAX_SAVED_POSITIVE_PROMPT = 600;
const MAX_SAVED_NEGATIVE_PROMPT = 250;

function stripGeneratedTposePolicy(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const marker = text.search(/(?:QA\s*自动修复第\s*\d+\s*轮|(?:严格正视)?标准\s*T-Pose|\bT-Pose\b|最高优先级\s*[:：]|【最高优先级)/i);
  return (marker >= 0 ? text.slice(0, marker) : text).replace(/[，,。；;\s]+$/g, "").trim();
}

function uniquePromptTerms(value) {
  const seen = new Set();
  return String(value || "")
    .split(/[，,。；;\n]+/)
    .map((item) => item.trim())
    .filter((item) => item && !seen.has(item) && seen.add(item));
}

function identityPromptOnly(value) {
  return uniquePromptTerms(stripGeneratedTposePolicy(value))
    .filter((item) => !/(?:手持|拿着|握着|持有|携带|背着|武器|盾牌|法杖|匕首|刀剑|枪械|锤子|工具包|道具)/i.test(item))
    .join("，");
}

function fitPromptToLength(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  if (maxLength <= 0) return "";
  const clipped = text.slice(0, maxLength);
  const boundary = Math.max(
    clipped.lastIndexOf("，"),
    clipped.lastIndexOf("；"),
    clipped.lastIndexOf("。"),
  );
  return (boundary >= Math.floor(maxLength * 0.6) ? clipped.slice(0, boundary) : clipped)
    .replace(/[，,。；;\s]+$/g, "")
    .trim();
}

function withRequiredSuffix(value, suffix, maxLength) {
  const base = stripGeneratedTposePolicy(value);
  const reservedBaseLength = base ? Math.min(base.length, Math.floor(maxLength * 0.25)) : 0;
  const suffixBudget = Math.max(0, maxLength - reservedBaseLength - (base ? 1 : 0));
  const fittedSuffix = fitPromptToLength(suffix, suffixBudget);
  const available = Math.max(0, maxLength - fittedSuffix.length - (base && fittedSuffix ? 1 : 0));
  const trimmed = base.slice(0, available).replace(/[，,。；;\s]+$/g, "");
  return `${trimmed}${trimmed && fittedSuffix ? "，" : ""}${fittedSuffix}`;
}

export function normalizePromptPlan(report, candidate) {
  const reviewedPositive = identityPromptOnly(report.positivePrompt || candidate.positivePrompt || "");
  const missing = REQUIRED_TPOSE_CONSTRAINTS.filter((item) => !item.pattern.test(reviewedPositive));
  const canonicalPolicyMissing = !reviewedPositive.includes("RGB(255,255,255)");
  const positivePrompt = withRequiredSuffix(reviewedPositive, REQUIRED_TPOSE_SUFFIX, MAX_SAVED_POSITIVE_PROMPT);
  const reviewedNegative = stripGeneratedTposePolicy(report.negativePrompt || candidate.negativePrompt || "");
  const negativeBase = uniquePromptTerms(reviewedNegative)
    .filter((item) => !REQUIRED_TPOSE_NEGATIVE_SUFFIX.includes(item))
    .join("，");
  const negativePrompt = withRequiredSuffix(negativeBase, REQUIRED_TPOSE_NEGATIVE_SUFFIX, MAX_SAVED_NEGATIVE_PROMPT);
  const issues = [...new Set([
    ...(Array.isArray(report.issues) ? report.issues : []),
    ...missing.map((item) => `缺少“${item.label}”约束，已由 PromptPolicy 自动补齐`),
  ])].slice(0, 20);
  const poseConstraints = [...new Set([
    ...(Array.isArray(report.poseConstraints) ? report.poseConstraints : []),
    ...REQUIRED_TPOSE_CONSTRAINTS.map((item) => item.label),
  ])].slice(0, 20);
  const policyNote = missing.length || canonicalPolicyMissing
    ? " PromptPolicy 已补齐精简的 T-Pose、空手和纯白背景约束。"
    : "";
  return {
    ...report,
    positivePrompt,
    negativePrompt,
    poseConstraints,
    issues,
    decision: report.decision === "manual_review" ? "manual_review" : missing.length || canonicalPolicyMissing ? "revise" : report.decision,
    summary: `${report.summary}${policyNote}`.slice(0, 500),
  };
}

export function buildQaRepairPrompts(run, failureReason, attempt) {
  const reason = String(failureReason || "");
  const positiveBase = identityPromptOnly(run.positivePrompt);
  const negativeBase = uniquePromptTerms(stripGeneratedTposePolicy(run.negativePrompt))
    .filter((item) => !REQUIRED_TPOSE_NEGATIVE_SUFFIX.includes(item))
    .join("，");
  const positiveRepairs = [];
  const negativeRepairs = [];
  if (/(?:背景不是纯白|backgroundPassed[^a-z]*false|whiteBorderRatio|connectedBackgroundWhiteRatio|灰色|米白|暖白|渐变|阴影)/i.test(reason)) {
    positiveRepairs.push("主体外区域必须为均匀纯白 RGB(255,255,255)，角色轮廓外不得保留灰边、渐变、地面或投影");
    negativeRepairs.push("灰色渐变，暖白背景，柔光阴影，接地阴影，地面投影，背景纹理");
  }
  if (/(?:双臂不够水平|armHorizontalError|手臂倾斜|手腕)/i.test(reason)) {
    positiveRepairs.push("双侧手腕与肩同高，肩、肘、腕位于同一水平线，左右手臂完全对称");
    negativeRepairs.push("手腕高于肩膀，手腕低于肩膀，不对称手臂");
  }
  if (/(?:肘部未充分伸直|肘部|弯肘|rightElbowAngle|leftElbowAngle)/i.test(reason)) {
    positiveRepairs.push("左右肘部完全伸直并接近 180 度，肩、肘、腕形成连续直线");
    negativeRepairs.push("弯肘，屈肘，手臂折线");
  }
  if (/(?:肩线倾斜|shoulderTilt|高低肩|肩膀倾斜)/i.test(reason)) {
    positiveRepairs.push("双肩严格同高且肩线水平，躯干保持竖直不侧倾");
    negativeRepairs.push("高低肩，肩线倾斜，躯干侧倾");
  }
  if (/(?:不是严格正视|非正视|frontFacing|侧身|侧面|三分之[一二三四]|背面)/i.test(reason)) {
    positiveRepairs.push("角色保持严格正面视图，脸部、胸腔和骨盆同时正对镜头且左右对称");
    negativeRepairs.push("侧视图，背面视图，三分之四视图，身体扭转");
  }
  if (/(?:肢体存在遮挡|limbsUnoccluded|肢体遮挡|互相遮挡|轮廓重叠)/i.test(reason)) {
    positiveRepairs.push("双臂、双手、躯干和双腿轮廓清晰分离，所有肢体完整可见且不得互相遮挡");
    negativeRepairs.push("肢体遮挡，手臂贴住躯干，双腿重叠，轮廓粘连");
  }
  if (/(?:仍持有道具|持有道具|持有武器|手持|拿着|握着|handsEmpty|道具或武器)/i.test(reason)) {
    positiveRepairs.push("双手完全空置，左右手掌和手指清晰可见且不接触任何道具");
    negativeRepairs.push("手持道具，手持武器，手握物体，物体遮挡手掌");
  }
  if (/(?:Character Consistency|角色身份不一致|身份不一致|identityConsistent|身份漂移|发型不一致|服装不一致|配色不一致)/i.test(reason)) {
    positiveRepairs.push("保持输入角色的身份特征、发型、脸部、服装、配色和穿戴式配饰不变，只修复姿态与背景");
    negativeRepairs.push("身份漂移，发型变化，服装变化，配色变化，角色重设计");
  }
  if (/(?:画面不是严格单主体|personCount|多个角色|多主体)/i.test(reason)) {
    positiveRepairs.push("画面中只能保留一个居中的完整角色，不得出现其他人物或重复肢体");
    negativeRepairs.push("多人物，重复角色，额外头部，额外肢体");
  }
  if (/(?:关键点置信度不足|minConfidence|人体关键点数量不足)/i.test(reason)) {
    positiveRepairs.push("人体轮廓和各关节必须清晰可辨，四肢与躯干保持足够间距以便稳定识别关键点");
    negativeRepairs.push("模糊肢体，粘连轮廓，隐藏关节，低对比度人体轮廓");
  }
  if (/(?:未识别到完整全身|bodyCoverage|裁切|头顶|脚底)/i.test(reason)) {
    const coverage = Number(attempt) >= 2 ? "70% 至 82%" : "65% 至 80%";
    positiveRepairs.push(`角色占画布高度 ${coverage}，头顶、双手和脚底完整可见并保留窄幅留白`);
    negativeRepairs.push("角色过小，留白过多，头顶裁切，脚底裁切，手部出框");
  }
  const positiveSuffix = [REQUIRED_TPOSE_SUFFIX, ...positiveRepairs].join("，");
  const negativeSuffix = [REQUIRED_TPOSE_NEGATIVE_SUFFIX, ...negativeRepairs].join("，");
  return {
    positivePrompt: withRequiredSuffix(positiveBase, positiveSuffix, MAX_SAVED_POSITIVE_PROMPT),
    negativePrompt: withRequiredSuffix(negativeBase, negativeSuffix, MAX_SAVED_NEGATIVE_PROMPT),
  };
}

export function normalizeVisualQaReport(report, deterministicQa) {
  const evidenceText = `${report.summary || ""}\n${Array.isArray(report.issues) ? report.issues.join("\n") : ""}`;
  const hasPositiveEvidence = (pattern) => [...evidenceText.matchAll(pattern)].some((match) => {
    const prefix = evidenceText.slice(Math.max(0, Number(match.index) - 4), Number(match.index));
    return !/(?:无|未|没有|并未|不再|并不)$/.test(prefix);
  });
  const heldPropEvidence = hasPositiveEvidence(/(?:手持|拿着|握着|持有|手中有|手里有)[^。；\n]{0,24}(?:武器|道具|刀|剑|枪|法杖|锤|球|滑板|工具|苦无)/gi);
  const nonWhiteBackgroundEvidence = hasPositiveEvidence(/(?:灰色|彩色|米白|奶油色|暖白|渐变|阴影|投影|纹理|场景|地平线)[^。；\n]{0,12}背景|背景(?:为|是|存在)[^。；\n]{0,12}(?:灰色|彩色|米白|奶油色|暖白|渐变|阴影|投影|纹理|场景|地平线)/gi);
  const normalized = {
    ...report,
    handsEmpty: heldPropEvidence ? false : report.handsEmpty,
    whiteBackground: nonWhiteBackgroundEvidence ? false : report.whiteBackground,
  };
  const failures = [
    [normalized.singleSubject, "画面不是严格单主体"],
    [normalized.fullBody, "角色没有完整全身出镜"],
    [normalized.frontFacing, "角色不是严格正视"],
    [normalized.armsHorizontal, "双臂没有水平伸展"],
    [normalized.limbsUnoccluded, "肢体存在遮挡或裁切"],
    [normalized.handsEmpty, heldPropEvidence ? "Visual QA 文本证据显示角色仍持有道具或武器" : "角色手中仍持有道具或武器"],
    [normalized.whiteBackground, nonWhiteBackgroundEvidence ? "Visual QA 文本证据显示背景不是纯白无渐变背景" : "背景不是纯白无渐变背景"],
  ].filter(([passed]) => passed !== true).map(([, issue]) => issue);
  if (deterministicQa.status === "failed") failures.push("SDPose 与背景像素硬门禁未通过");
  if (normalized.decision === "pass" && Number(normalized.confidence || 0) < 0.8) failures.push("Visual QA 置信度不足 0.8");
  if (!failures.length) return normalized;
  return {
    ...normalized,
    decision: normalized.decision === "reject"
      ? "reject"
      : failures.some((item) => item.includes("置信度")) && failures.length === 1
        ? "manual_review"
        : "repairable",
    issues: [...new Set([...(normalized.issues || []), ...failures])].slice(0, 20),
    summary: `${normalized.summary} 硬门禁未通过：${failures.join("；")}。`.slice(0, 500),
  };
}

export function normalizeAssetInspection(report, inspection) {
  if (inspection.meshCount > 0 || report.decision !== "pass") return report;
  return {
    ...report,
    geometryUsable: false,
    decision: "reject",
    issues: [...new Set([...(report.issues || []), "GLB 硬门禁未检测到 mesh"])].slice(0, 20),
    summary: `${report.summary} GLB 结构硬门禁未通过。`.slice(0, 500),
  };
}

export function normalizeRiggingQa(report, inspection) {
  if ((inspection.skinCount > 0 && inspection.jointCount > 0) || report.decision !== "pass") return report;
  return {
    ...report,
    skinPresent: inspection.skinCount > 0,
    jointsPresent: inspection.jointCount > 0,
    decision: "reject",
    issues: [...new Set([...(report.issues || []), "GLB 硬门禁未检测到 skin/joints"])].slice(0, 20),
    summary: `${report.summary} 绑骨结构硬门禁未通过。`.slice(0, 500),
  };
}
