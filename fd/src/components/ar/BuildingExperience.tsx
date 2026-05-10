"use client";

import { useRef, useState, type TouchEvent } from "react";
import { GripHorizontal, Heart, MessageCircle, RefreshCw, UsersRound } from "lucide-react";

import { FloatingGlbIcon } from "@/components/ar/FloatingGlbIcon";
import type { ApiIssue, ApiIssueComment } from "@/lib/ar/backend";
import { glbUrlForExperienceId } from "@/lib/ar/glb-assets";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

const EXPERIENCES = [
  { id: "music-room" },
  { id: "gallery" },
  { id: "history" },
  { id: "media" },
  { id: "viewpoint" },
  { id: "archive" },
  { id: "activity" },
] as const;

const FLOAT_POSITIONS = [
  { left: 12, top: 28 },
  { left: 88, top: 30 },
  { left: 10, top: 42 },
  { left: 90, top: 45 },
  { left: 14, top: 56 },
  { left: 86, top: 60 },
  { left: 12, top: 68 },
] as const;

const COMMUNITY_COUNTS = {
  people: 1000,
  support: 110,
  comments: 22,
} as const;

function isRoadIssueScene(label: string): boolean {
  const key = label.trim().toLowerCase();
  return (
    key.includes("road") ||
    key.includes("break") ||
    key.includes("pothole") ||
    key.includes("zamiin") ||
    key.includes("зам")
  );
}

type Props = {
  buildingName: string;
  issue: ApiIssue | null;
  issueComments: ApiIssueComment[];
  issueBusy: boolean;
  onSupportIssue: () => void;
  onAddIssueComment: () => void;
  onRefreshRecognition: () => void;
};

export function BuildingExperience({
  buildingName,
  issue,
  issueComments,
  issueBusy,
  onSupportIssue,
  onAddIssueComment,
  onRefreshRecognition,
}: Props) {
  const { t } = useI18n();
  const isRoadIssue = isRoadIssueScene(buildingName);
  const issueStatusLabel = issue
    ? issue.status === "accepted"
      ? t("issueStatus_accepted")
      : issue.status === "consensus"
        ? t("issueStatus_consensus")
        : issue.status === "resolved"
          ? t("issueStatus_resolved")
          : t("issueStatus_open")
    : t("issueLoading");
  const [expanded, setExpanded] = useState(false);
  const startYRef = useRef<number | null>(null);

  const onTouchStart = (event: TouchEvent<HTMLElement>) => {
    startYRef.current = event.touches[0]?.clientY ?? null;
  };

  const onTouchEnd = (event: TouchEvent<HTMLElement>) => {
    const start = startYRef.current;
    if (start == null) return;
    const end = event.changedTouches[0]?.clientY ?? start;
    const delta = end - start;
    if (delta <= -36) setExpanded(true);
    if (delta >= 36) setExpanded(false);
    startYRef.current = null;
  };

  return (
    <>
      <button
        type="button"
        onClick={onRefreshRecognition}
        className="pointer-events-auto absolute right-3 top-[max(calc(env(safe-area-inset-top)+5.5rem),6rem)] z-[22] flex h-10 w-10 items-center justify-center rounded-full border border-white/70 bg-black/55 text-white shadow-lg ring-1 ring-white/25 backdrop-blur-sm"
        aria-label={t("refreshRecognitionAria")}
        title={t("refreshRecognition")}
      >
        <RefreshCw className="h-4 w-4" />
      </button>
      {isRoadIssue && (
        <div className="pointer-events-auto absolute left-1/2 top-[max(calc(env(safe-area-inset-top)+5.7rem),6.2rem)] z-[22] w-[86%] max-w-sm -translate-x-1/2 rounded-xl border border-ar-orange/30 bg-white/95 px-3 py-2 text-center text-xs font-semibold text-zinc-900 shadow-lg ring-1 ring-zinc-200 backdrop-blur-sm">
          {t("roadIssueJoinPrompt")}
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 z-[14]">
        {EXPERIENCES.map((exp, idx) => {
          const pos = FLOAT_POSITIONS[idx] ?? FLOAT_POSITIONS[0];
          const glb = glbUrlForExperienceId(exp.id);
          return (
            <div
              key={exp.id}
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/60 p-0.5 shadow-lg ring-1 ring-white/25 backdrop-blur-sm"
              style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
            >
              <FloatingGlbIcon
                src={glb}
                frameClassName="h-10 w-10"
                phaseOffsetTurns={(idx + 1) / 14}
              />
            </div>
          );
        })}
      </div>

      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-[21] transition-transform duration-300 ease-out",
          expanded ? "translate-y-0" : "translate-y-[calc(100%-8.5rem)]",
        )}
      >
        <section className="mx-auto w-full max-w-md rounded-t-3xl border border-zinc-200 bg-white shadow-[0_-12px_40px_rgba(0,0,0,0.08)]">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            className="flex w-full items-center justify-center py-2 text-zinc-400"
            aria-label={t("buildingSheetDrag")}
          >
            <GripHorizontal className="h-5 w-5" />
          </button>

          <div className="space-y-3 px-3 pb-[max(env(safe-area-inset-bottom),10px)]">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#fca311]">
                {t("insideBuildingTitle")}
              </p>
              <p className="mt-1 truncate text-base font-bold text-zinc-900">{buildingName}</p>
              <p className="mt-0.5 text-[11px] text-zinc-500">{t("insideBuildingHint")}</p>
              {isRoadIssue && (
                <div className="mt-2 rounded-lg border border-ar-orange/30 bg-white px-2.5 py-2">
                  <p className="text-[11px] font-semibold text-zinc-900">{t("roadIssueEta")}</p>
                  <div className="mt-2 grid grid-cols-3 gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5">
                    <p className="flex items-center justify-center gap-1 text-sm font-semibold text-zinc-900">
                      <UsersRound className="h-4 w-4 text-zinc-800" />
                      {issue?.supportCount ?? COMMUNITY_COUNTS.people}
                    </p>
                    <p className="flex items-center justify-center gap-1 text-sm font-semibold text-zinc-900">
                      <Heart className="h-4 w-4 text-zinc-800" />
                      {issue?.matchCount ?? COMMUNITY_COUNTS.support}
                    </p>
                    <p className="flex items-center justify-center gap-1 text-sm font-semibold text-zinc-900">
                      <MessageCircle className="h-4 w-4 text-zinc-800" />
                      {issue?.commentCount ?? COMMUNITY_COUNTS.comments}
                    </p>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={onSupportIssue}
                      disabled={issueBusy || !issue}
                      className="rounded-lg bg-ar-orange px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-50"
                    >
                      {t("joinDiscussion")}
                    </button>
                    <button
                      type="button"
                      onClick={onAddIssueComment}
                      disabled={issueBusy || !issue}
                      className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-zinc-800 disabled:opacity-50"
                    >
                      {t("addComment")}
                    </button>
                    <span className="text-[10px] font-semibold uppercase text-emerald-700">
                      {issueStatusLabel}
                    </span>
                  </div>
                  {issueComments.length > 0 && (
                    <p className="mt-1 text-[10px] text-zinc-600">
                      {t("issueCommentCount", { n: issueComments.length })}
                    </p>
                  )}
                </div>
              )}
              <div className="mt-2 flex h-28 items-center justify-center overflow-hidden rounded-lg border border-dashed border-zinc-300 bg-zinc-100">
                <FloatingGlbIcon
                  src={glbUrlForExperienceId("history")}
                  frameClassName="h-24 w-24"
                  phaseOffsetTurns={0.12}
                />
              </div>
            </div>

            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                {t("insideBuildingListTitle")}
              </p>
              <div className="grid grid-cols-4 gap-2">
                {EXPERIENCES.map((exp, i) => (
                  <div
                    key={exp.id}
                    className="flex h-12 items-center justify-center overflow-hidden rounded-lg border border-zinc-200 bg-white"
                  >
                    <FloatingGlbIcon
                      src={glbUrlForExperienceId(exp.id)}
                      frameClassName="h-10 w-10"
                      frameShapeClassName="rounded-lg"
                      phaseOffsetTurns={(i + 3) / 17}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
