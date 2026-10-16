import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // AI 审核用的 Prompt 文件是运行时用动态路径读取的，Vercel 的构建期文件追踪
  // 默认可能不会把它们打进函数产物里，这里显式声明确保线上也能读到。
  outputFileTracingIncludes: {
    "/*": ["./src/lib/moderation/prompts/**"],
  },
  images: {
    remotePatterns: [
      // Google 头像（Google 登录用户的默认头像）
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      // Supabase Storage（后续存放用户上传的图片 / 产品截图）
      { protocol: "https", hostname: "*.supabase.co" },
      // bman 预设 Agent 头像，只允许公开 Agent 资源目录
      { protocol: "https", hostname: "bman-assets.buidl4.top", port: "", pathname: "/agents/**", search: "" },
      // TRON 预设 Agent 当前使用的精确头像路径
      { protocol: "https", hostname: "cryptologos.cc", port: "", pathname: "/logos/tron-trx-logo.png", search: "" },
    ],
  },
};

export default withNextIntl(nextConfig);
