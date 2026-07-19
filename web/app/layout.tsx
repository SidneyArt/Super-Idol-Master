import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Super Idol Master · 流程可视化",
  description: "从角色描述、2D 概念图到 3D 模型与自动绑骨的可视化生产流程。",
  openGraph: {
    title: "Super Idol Master · 流程可视化",
    description: "从角色描述到可用 3D 资产，一眼看懂完整生产流程。",
    images: ["/character-preview.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
