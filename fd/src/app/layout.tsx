import type { Metadata, Viewport } from "next";

import { I18nProvider } from "@/lib/i18n/context";

import "./globals.css";

export const metadata: Metadata = {
  title: "Scene Detect AR",
  description: "Mobile web AR that recognizes scenes and objects in real time.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0b2d72",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full overscroll-none bg-white text-zinc-900 antialiased">
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
