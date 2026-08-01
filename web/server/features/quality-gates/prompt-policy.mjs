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

function withRequiredSuffix(value, suffix, maxLength) {
  const base = stripGeneratedTposePolicy(value);
  const available = Math.max(0, maxLength - suffix.length - (base ? 1 : 0));
  const trimmed = base.slice(0, available).replace(/[，,。；;\s]+$/g, "");
  return `${trimmed}${trimmed ? "，" : ""}${suffix}`;
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
  void failureReason;
  void attempt;
  const positiveBase = identityPromptOnly(run.positivePrompt);
  const negativeBase = uniquePromptTerms(stripGeneratedTposePolicy(run.negativePrompt))
    .filter((item) => !REQUIRED_TPOSE_NEGATIVE_SUFFIX.includes(item))
    .join("，");
  return {
    positivePrompt: withRequiredSuffix(positiveBase, REQUIRED_TPOSE_SUFFIX, MAX_SAVED_POSITIVE_PROMPT),
    negativePrompt: withRequiredSuffix(negativeBase, REQUIRED_TPOSE_NEGATIVE_SUFFIX, MAX_SAVED_NEGATIVE_PROMPT),
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
