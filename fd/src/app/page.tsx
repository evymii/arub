"use client";

import dynamic from "next/dynamic";
import { Camera } from "lucide-react";

import { useI18n } from "@/lib/i18n/context";

const ARShell = dynamic(() => import("@/components/ar/ARShell"), {
  ssr: false,
  loading: () => <Splash />,
});

export default function Page() {
  return <ARShell />;
}

function Splash() {
  const { t } = useI18n();
  return (
    <main className="flex h-svh w-full items-center justify-center bg-white px-6 text-center text-zinc-900">
      <div className="max-w-sm">
        <div className="mx-auto flex h-12 w-12 animate-pulse items-center justify-center rounded-2xl border border-ar-navy/15 bg-white shadow-sm ring-1 ring-zinc-100">
          <Camera className="h-6 w-6 text-ar-navy" />
        </div>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">{t("appTitle")}</h1>
        <p className="mt-2 text-sm text-zinc-500">{t("splashSubtitle")}</p>
      </div>
    </main>
  );
}
