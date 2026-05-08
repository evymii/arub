"use client";

import dynamic from "next/dynamic";
import { Camera } from "lucide-react";

const ARShell = dynamic(() => import("@/components/ar/ARShell"), {
  ssr: false,
  loading: () => <Splash />,
});

export default function Page() {
  return <ARShell />;
}

function Splash() {
  return (
    <main className="flex h-svh w-full items-center justify-center bg-neutral-950 px-6 text-center text-white">
      <div className="max-w-sm">
        <div className="mx-auto flex h-12 w-12 animate-pulse items-center justify-center rounded-2xl bg-cyan-300/15">
          <Camera className="h-6 w-6 text-cyan-300" />
        </div>
        <h1 className="mt-4 text-xl font-semibold">Building AR</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Loading camera and recognition model...
        </p>
      </div>
    </main>
  );
}
