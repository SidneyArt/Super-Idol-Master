import type { Metadata } from "next";
import "./globals.css";

const themeInitializer = `
  (() => {
    try {
      const savedTheme = window.localStorage.getItem("sim-theme");
      document.documentElement.dataset.theme =
        savedTheme === "light" || savedTheme === "dark" ? savedTheme : "dark";
    } catch {
      document.documentElement.dataset.theme = "dark";
    }
  })();
`;

export const metadata: Metadata = {
  title: "Super Idol Master · 多智能体数字角色资产生产线",
  description: "从角色描述、2D 概念图到 3D 模型与自动绑骨的多智能体数字角色资产生产线。",
  openGraph: {
    title: "Super Idol Master · 多智能体数字角色资产生产线",
    description: "从角色描述到可用 3D 资产，一眼看懂多智能体协作的完整生产流程。",
    images: ["/character-preview.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitializer }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
