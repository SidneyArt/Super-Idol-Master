import { Type } from "@earendil-works/pi-ai";

export const PROMPT_PLAN_SCHEMA = Type.Object({
  positivePrompt: Type.String({ minLength: 1, maxLength: 4000 }),
  negativePrompt: Type.String({ maxLength: 2000 }),
  identityAnchors: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 20 }),
  poseConstraints: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 20 }),
  issues: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 20 }),
  decision: Type.Union([Type.Literal("approve"), Type.Literal("revise"), Type.Literal("manual_review")]),
  summary: Type.String({ minLength: 1, maxLength: 500 }),
});

export const VISUAL_QA_SCHEMA = Type.Object({
  assetKind: Type.Union([Type.Literal("humanoid"), Type.Literal("non_humanoid"), Type.Literal("unknown")]),
  fullBody: Type.Boolean(),
  singleSubject: Type.Boolean(),
  frontFacing: Type.Boolean(),
  armsHorizontal: Type.Boolean(),
  limbsUnoccluded: Type.Boolean(),
  handsEmpty: Type.Boolean(),
  whiteBackground: Type.Boolean(),
  identityConsistent: Type.Union([Type.Boolean(), Type.Null()]),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  issues: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 20 }),
  decision: Type.Union([
    Type.Literal("pass"),
    Type.Literal("repairable"),
    Type.Literal("manual_review"),
    Type.Literal("reject"),
  ]),
  summary: Type.String({ minLength: 1, maxLength: 500 }),
});

export const CHARACTER_CONSISTENCY_SCHEMA = Type.Object({
  referenceAvailable: Type.Boolean(),
  identityConsistent: Type.Union([Type.Boolean(), Type.Null()]),
  matchedAnchors: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 20 }),
  driftedAnchors: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 20 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  decision: Type.Union([
    Type.Literal("pass"), Type.Literal("repairable"), Type.Literal("manual_review"), Type.Literal("reject"),
  ]),
  summary: Type.String({ minLength: 1, maxLength: 500 }),
});

export const ASSET_INSPECTION_SCHEMA = Type.Object({
  geometryUsable: Type.Boolean(),
  materialsPresent: Type.Boolean(),
  visualEvidenceAvailable: Type.Boolean(),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  issues: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 20 }),
  decision: Type.Union([
    Type.Literal("pass"), Type.Literal("repairable"), Type.Literal("manual_review"), Type.Literal("reject"),
  ]),
  summary: Type.String({ minLength: 1, maxLength: 500 }),
});

export const RIGGING_QA_SCHEMA = Type.Object({
  skinPresent: Type.Boolean(),
  jointsPresent: Type.Boolean(),
  hierarchyPlausible: Type.Boolean(),
  deformationEvidenceAvailable: Type.Boolean(),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  issues: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 20 }),
  decision: Type.Union([
    Type.Literal("pass"), Type.Literal("repairable"), Type.Literal("manual_review"), Type.Literal("reject"),
  ]),
  summary: Type.String({ minLength: 1, maxLength: 500 }),
});

export const EXPORT_REVIEW_SCHEMA = Type.Object({
  profile: Type.Union([
    Type.Literal("generic_glb"), Type.Literal("unity"), Type.Literal("unreal"), Type.Literal("vrm"), Type.Literal("web"),
  ]),
  structureReady: Type.Boolean(),
  materialsPackaged: Type.Boolean(),
  rigReady: Type.Boolean(),
  warnings: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 20 }),
  decision: Type.Union([Type.Literal("pass"), Type.Literal("manual_review"), Type.Literal("reject")]),
  summary: Type.String({ minLength: 1, maxLength: 500 }),
});

export const WORKFLOW_DIAGNOSIS_SCHEMA = Type.Object({
  failureCategory: Type.Union([
    Type.Literal("generation"), Type.Literal("network"), Type.Literal("workflow"),
    Type.Literal("input"), Type.Literal("resource"), Type.Literal("unknown"),
  ]),
  recommendation: Type.Union([
    Type.Literal("retry_same"), Type.Literal("retry_with_changes"),
    Type.Literal("manual_intervention"), Type.Literal("abort"),
  ]),
  safeActions: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 12 }),
  suspectedCause: Type.String({ minLength: 1, maxLength: 500 }),
  summary: Type.String({ minLength: 1, maxLength: 500 }),
});
