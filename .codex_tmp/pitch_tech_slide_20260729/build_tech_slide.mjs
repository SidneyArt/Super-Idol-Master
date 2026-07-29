import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, PresentationFile } from "@oai/artifact-tool";

const TMP_DIR =
  "D:\\CodeWorks\\AgentLearning\\DGX比赛 RAG Agent Learning\\Super-Idol-Master\\.codex_tmp\\pitch_tech_slide_20260729";
const STARTER_PPTX = path.join(TMP_DIR, "template-starter.pptx");
const FINAL_PPTX =
  "D:\\CodeWorks\\AgentLearning\\DGX比赛 RAG Agent Learning\\Super-Idol-Master\\Super-Idol-Master_项目技术核心介绍_单页.pptx";
const PREVIEW_DIR = path.join(TMP_DIR, "final-preview");
const LAYOUT_DIR = path.join(TMP_DIR, "final-layout", "final");

const COLORS = {
  black: "#000000",
  dark: "#313131",
  gray: "#757575",
  green: "#76B900",
};

const FONT = {
  zh: "Noto Sans SC",
  en: "NVIDIA Sans",
  enMedium: "NVIDIA Sans Medium",
};

function run(text, { size = "36pt", typeface = FONT.zh, bold = false, color = COLORS.black } = {}) {
  return {
    run: text,
    textStyle: {
      fontSize: size,
      typeface,
      bold,
      color,
    },
  };
}

function paragraph(runs, { marginLeft = 0, indent = 0, spaceBefore = 0, spaceAfter = 0 } = {}) {
  return {
    bulletCharacter: "",
    marginLeft,
    indent,
    spaceBefore,
    spaceAfter,
    runs,
  };
}

async function writeBlob(filePath, blob) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

async function main() {
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  await fs.mkdir(LAYOUT_DIR, { recursive: true });

  const presentation = await PresentationFile.importPptx(await FileBlob.load(STARTER_PPTX));
  if (presentation.slides.items.length !== 1) {
    throw new Error(`Expected a one-slide starter deck; found ${presentation.slides.items.length}.`);
  }

  const slide = presentation.slides.items[0];
  const findShape = (name) => {
    const shape = slide.shapes.items.find((item) => item.name === name);
    if (!shape) throw new Error(`Could not find inherited shape named "${name}".`);
    return shape;
  };
  const title = findShape("Title");
  const subtitle = findShape("Subtitle");
  const body = findShape("Text Placeholder");

  title.text.style = {
    fontSize: 96,
    typeface: FONT.enMedium,
    color: COLORS.black,
    alignment: "left",
    verticalAlignment: "bottom",
    autoFit: "none",
    wrap: "none",
    lineSpacing: 0.9,
    insets: { top: 4.8, right: 0, bottom: 4.8, left: 0 },
  };
  title.text.set([
    paragraph([
      run("StepFun", { size: "72pt", typeface: FONT.enMedium, bold: true }),
      run(" 决策，", { size: "72pt", typeface: FONT.zh, bold: true }),
      run("DGX Spark", { size: "72pt", typeface: FONT.enMedium, bold: true }),
      run(" 生产：把角色创意变成可交付 ", { size: "72pt", typeface: FONT.zh, bold: true }),
      run("GLB", { size: "72pt", typeface: FONT.enMedium, bold: true }),
    ]),
  ]);

  subtitle.text.style = {
    fontSize: 64,
    typeface: FONT.zh,
    color: COLORS.gray,
    alignment: "left",
    verticalAlignment: "top",
    autoFit: "none",
    wrap: "none",
    lineSpacing: 0.9,
    insets: { top: 9.6, right: 0, bottom: 4.8, left: 0 },
  };
  subtitle.text.set([
    paragraph([
      run("语义控制面", { size: "48pt", typeface: FONT.zh, color: COLORS.gray }),
      run("  ×  ", { size: "48pt", typeface: FONT.en, color: COLORS.green, bold: true }),
      run("本地资产工厂", { size: "48pt", typeface: FONT.zh, color: COLORS.gray }),
      run("  ×  ", { size: "48pt", typeface: FONT.en, color: COLORS.green, bold: true }),
      run("确定性质量门禁", { size: "48pt", typeface: FONT.zh, color: COLORS.gray }),
    ]),
  ]);

  body.text.style = {
    fontSize: 58.67,
    typeface: FONT.zh,
    color: COLORS.black,
    alignment: "left",
    verticalAlignment: "top",
    autoFit: "none",
    wrap: "square",
    lineSpacing: 0.9,
    insets: { top: 4.8, right: 0, bottom: 4.8, left: 0 },
  };
  body.text.set([
    paragraph(
      [
        run("01", { size: "44pt", typeface: FONT.enMedium, bold: true, color: COLORS.green }),
        run("   ", { size: "44pt", typeface: FONT.en }),
        run("StepFun", { size: "44pt", typeface: FONT.enMedium, bold: true }),
        run("：云端理解、规划与编排", { size: "44pt", typeface: FONT.zh, bold: true }),
      ],
      { spaceAfter: 10 },
    ),
    paragraph(
      [
        run("step-3.7-flash", { size: "36pt", typeface: FONT.enMedium, bold: true, color: COLORS.dark }),
        run(" 多模态理解 / 工具调用；", { size: "36pt", typeface: FONT.zh, color: COLORS.dark }),
        run("step-image-edit-2", { size: "36pt", typeface: FONT.enMedium, bold: true, color: COLORS.dark }),
        run(" 角色图与 ", { size: "36pt", typeface: FONT.zh, color: COLORS.dark }),
        run("T-Pose", { size: "36pt", typeface: FONT.en, color: COLORS.dark }),
        run(" 编辑", { size: "36pt", typeface: FONT.zh, color: COLORS.dark }),
      ],
      { marginLeft: 118, spaceAfter: 12 },
    ),
    paragraph([run("↓", { size: "32pt", typeface: FONT.enMedium, bold: true, color: COLORS.green })], {
      marginLeft: 37,
      spaceAfter: 10,
    }),
    paragraph(
      [
        run("02", { size: "44pt", typeface: FONT.enMedium, bold: true, color: COLORS.green }),
        run("   ", { size: "44pt", typeface: FONT.en }),
        run("DGX Spark", { size: "44pt", typeface: FONT.enMedium, bold: true }),
        run("：多模型本地生产", { size: "44pt", typeface: FONT.zh, bold: true }),
      ],
      { spaceAfter: 10 },
    ),
    paragraph(
      [
        run("GB10 + 128GB", { size: "36pt", typeface: FONT.enMedium, bold: true, color: COLORS.dark }),
        run(" 统一内存，减少 ", { size: "36pt", typeface: FONT.zh, color: COLORS.dark }),
        run("CPU / GPU", { size: "36pt", typeface: FONT.en, color: COLORS.dark }),
        run(" 间重复数据搬运", { size: "36pt", typeface: FONT.zh, color: COLORS.dark }),
      ],
      { marginLeft: 118, spaceAfter: 8 },
    ),
    paragraph(
      [
        run("GPU", { size: "36pt", typeface: FONT.enMedium, bold: true, color: COLORS.dark }),
        run("：", { size: "36pt", typeface: FONT.zh, color: COLORS.dark }),
        run("Qwen Image → SDPose → Pixal3D → SkinTokens", {
          size: "36pt",
          typeface: FONT.en,
          color: COLORS.dark,
        }),
        run("  ｜  ", { size: "36pt", typeface: FONT.zh, color: COLORS.gray }),
        run("CPU", { size: "36pt", typeface: FONT.enMedium, bold: true, color: COLORS.dark }),
        run("：", { size: "36pt", typeface: FONT.zh, color: COLORS.dark }),
        run("AutoRemesher + Blender", { size: "36pt", typeface: FONT.en, color: COLORS.dark }),
      ],
      { marginLeft: 118, spaceAfter: 12 },
    ),
    paragraph([run("↓", { size: "32pt", typeface: FONT.enMedium, bold: true, color: COLORS.green })], {
      marginLeft: 37,
      spaceAfter: 10,
    }),
    paragraph(
      [
        run("03", { size: "44pt", typeface: FONT.enMedium, bold: true, color: COLORS.green }),
        run("   ", { size: "44pt", typeface: FONT.en }),
        run("自研控制层：生成可控、可恢复", { size: "44pt", typeface: FONT.zh, bold: true }),
      ],
      { spaceAfter: 10 },
    ),
    paragraph(
      [
        run("Coordinator + Supervisor + 7", { size: "36pt", typeface: FONT.enMedium, bold: true, color: COLORS.dark }),
        run(" 个专业 ", { size: "36pt", typeface: FONT.zh, color: COLORS.dark }),
        run("Agent", { size: "36pt", typeface: FONT.enMedium, bold: true, color: COLORS.dark }),
        run("；硬门禁优先于模型判断", { size: "36pt", typeface: FONT.zh, color: COLORS.dark }),
      ],
      { marginLeft: 118, spaceAfter: 8 },
    ),
    paragraph(
      [
        run("自动推进、失败回退、断点恢复  →  带骨骼 ", {
          size: "36pt",
          typeface: FONT.zh,
          color: COLORS.dark,
        }),
        run("GLB", { size: "36pt", typeface: FONT.enMedium, bold: true, color: COLORS.dark }),
      ],
      { marginLeft: 118, spaceAfter: 22 },
    ),
    paragraph(
      [
        run("已验证闭环  ", { size: "36pt", typeface: FONT.zh, bold: true, color: COLORS.green }),
        run("T-Pose 94/100", { size: "36pt", typeface: FONT.enMedium, bold: true }),
        run("   ·   ", { size: "36pt", typeface: FONT.en, color: COLORS.gray }),
        run("69.7", { size: "36pt", typeface: FONT.enMedium, bold: true }),
        run(" 万面 → ", { size: "36pt", typeface: FONT.zh }),
        run("4.06", { size: "36pt", typeface: FONT.enMedium, bold: true }),
        run(" 万四边面", { size: "36pt", typeface: FONT.zh }),
        run("   ·   ", { size: "36pt", typeface: FONT.en, color: COLORS.gray }),
        run("1 skin / 49 joints", { size: "36pt", typeface: FONT.enMedium, bold: true }),
      ],
      { spaceAfter: 34 },
    ),
    paragraph([
      run("关键原则  ", { size: "40pt", typeface: FONT.zh, bold: true, color: COLORS.green }),
      run("Agent", { size: "40pt", typeface: FONT.enMedium, bold: true }),
      run(" 负责语义判断，程序负责最终放行", { size: "40pt", typeface: FONT.zh, bold: true }),
    ]),
  ]);

  const speakerNotes = [
    "【2–3 分钟讲稿】",
    "",
    "这一页先澄清：这里的 Spark 指 NVIDIA DGX Spark，不是 Apache Spark。我们要解决的不是“生成一张角色图”，而是怎样把角色创意可靠地推进成可以继续做动画的带骨骼 GLB。为此，我们把系统拆成三层。",
    "",
    "第一层是 StepFun 语义控制面。step-3.7-flash 负责理解文字和图片、拆解目标、编排工具，并驱动 Coordinator、Supervisor 和七个专业 Agent；step-image-edit-2 负责角色图生成与原画到标准 T-Pose 的编辑。也就是说，StepFun 决定“下一步应该做什么”，但不能越过程序门禁。",
    "",
    "第二层是 DGX Spark 本地资产工厂。GB10 Grace Blackwell 和 128GB 统一内存，让 CPU 与 GPU 共享同一物理内存，适合这类多模型、长流水线按阶段运行。GPU 侧通过 ComfyUI 执行 Qwen Image、SDPose、Pixal3D 和 SkinTokens；CPU 侧由 AutoRemesher 与 Blender 完成拓扑、UV 和基础色回烘。这里我们强调的是 DGX Spark 的本地算力与 CUDA / PyTorch 运行环境，不把这些工作流误称为 NVIDIA 官方模型。",
    "",
    "第三层是项目真正的可靠性核心：自研状态机、确定性硬门禁和专业 Agent 复核。T-Pose 必须先通过关键点与背景像素检查，静态 GLB 必须解析出 mesh，绑骨 GLB 必须包含 skin 和 joints。模型负责解释证据，程序负责最终放行；失败时系统会暂停、修复、重试或回退，任务和证据写入 SQLite，因此服务重启后也能从状态继续。",
    "",
    "我们已有真实链路证据：固定任务的 T-Pose QA 得到 94 分；一次真实角色回归从 696,639 面生成 40,589 个四边面；最终绑骨 GLB 检测到 1 个 skin 和 49 个 joints。项目的核心不是堆模型名称，而是把 StepFun 的理解能力与 DGX Spark 的本地生产能力，变成一条可检查、可恢复、可交付的数字角色资产生产线。",
    "",
    "【答辩口径】",
    "- 不宣称使用 Apache Spark。",
    "- 不宣称已直接接入 NVIDIA NIM、TensorRT、Nemotron 或 OpenUSD。",
    "- Qwen Image、SDPose、Pixal3D、SkinTokens 是运行在 DGX Spark 上的工作流，不是 NVIDIA 官方模型。",
    "- StepFun Agent 与部分图片能力使用云端 API，因此不说“全部数据不出本地”。",
    "- AutoRemesher 的核心主要运行在 CPU；不说整条链全部由 GPU 加速。",
    "",
    "[Sources]",
    "- https://docs.nvidia.com/dgx/dgx-spark/hardware.html — Grace Blackwell and 128 GB unified memory.",
    "- https://docs.nvidia.com/dgx/dgx-spark-porting-guide/overview.html — unified memory and reduced CPU RAM / VRAM copies.",
    "- https://docs.nvidia.com/dgx/dgx-spark/software.html — DGX Spark AI software environment.",
    "- https://static.stepfun.com/blog/step-3.7-flash/ — multimodal understanding, tool use, and orchestration.",
    "- https://platform.stepfun.com/docs/zh/guides/models/step-image-edit-2 — image generation and editing.",
    "- D:\\CodeWorks\\AgentLearning\\DGX比赛 RAG Agent Learning\\Super-Idol-Master\\README.zh-CN.md",
    "- D:\\CodeWorks\\AgentLearning\\DGX比赛 RAG Agent Learning\\Super-Idol-Master\\docs\\getting-started\\current-project-baseline.md",
    "- D:\\CodeWorks\\AgentLearning\\DGX比赛 RAG Agent Learning\\Super-Idol-Master\\docs\\deployment\\dgx-autoremesher-deployment.md",
    "- D:\\CodeWorks\\AgentLearning\\DGX比赛 RAG Agent Learning\\Super-Idol-Master\\docs\\product\\hackathon-submission-audit.md",
  ].join("\n");

  slide.speakerNotes.textFrame.setText(speakerNotes);
  slide.speakerNotes.setVisible(true);

  const preview = await presentation.export({ slide, format: "png", scale: 1 });
  await writeBlob(path.join(PREVIEW_DIR, "slide-01.png"), preview);

  const layout = await slide.export({ format: "layout" });
  await fs.writeFile(path.join(LAYOUT_DIR, "final-slide-01.layout.json"), await layout.text(), "utf8");

  const montage = await presentation.export({ format: "webp", montage: true, scale: 1 });
  await writeBlob(path.join(TMP_DIR, "final-montage.webp"), montage);

  const inspect = await presentation.inspect({
    kind: "deck,slide,textbox,shape,image,table,chart,notes,layout",
    maxChars: 80000,
  });
  await fs.writeFile(path.join(TMP_DIR, "final-inspect.ndjson"), inspect.ndjson, "utf8");

  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(FINAL_PPTX);

  console.log(
    JSON.stringify(
      {
        output: FINAL_PPTX,
        slides: presentation.slides.items.length,
        title: "StepFun 决策，DGX Spark 生产：把角色创意变成可交付 GLB",
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
