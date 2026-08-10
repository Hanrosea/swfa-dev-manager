import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "마이비인프라 개발업무관리",
  description: "부서 간 개발 일정, 공수, 이슈를 한눈에 관리하는 업무 시스템",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
