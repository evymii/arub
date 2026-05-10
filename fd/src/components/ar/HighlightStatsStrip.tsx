"use client";

import {
  HighlightIconComments,
  HighlightIconReactions,
  HighlightIconViews,
} from "@/components/ar/HighlightIcons";

type Props = {
  views?: number;
  reactions?: number;
  comments?: number;
};

export function HighlightStatsStrip({ views = 1000, reactions = 110, comments = 22 }: Props) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[max(calc(env(safe-area-inset-bottom)+1rem),1rem)] z-12 flex justify-center px-3">
      <div className="flex w-full max-w-xs items-center justify-center gap-5 bg-transparent px-1 py-1 text-white">
        <p className="flex items-center gap-1 text-[12px] font-semibold drop-shadow-md">
          <HighlightIconViews className="h-4 w-4 animate-pulse text-white" />
          <span>{views}</span>
        </p>
        <p className="flex items-center gap-1 text-[12px] font-semibold drop-shadow-md">
          <HighlightIconReactions className="h-4 w-4 animate-pulse text-white" />
          <span>{reactions}</span>
        </p>
        <p className="flex items-center gap-1 text-[12px] font-semibold drop-shadow-md">
          <HighlightIconComments className="h-4 w-4 animate-pulse text-white" />
          <span>{comments}</span>
        </p>
      </div>
    </div>
  );
}
