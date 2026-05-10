"use client";

import { ScanSearch, Sparkles } from "lucide-react";

import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

export type RankedCandidate = { label: string; score: number };

export type RecognizeMatchPrediction = {
  label: string;
  confidence: number;
  confidences: Record<string, number>;
  isNoBuilding?: boolean;
  isNotInDb?: boolean;
  isLowConfidence?: boolean;
  rankedAboveThreshold?: RankedCandidate[];
};

type Props = {
  prediction: RecognizeMatchPrediction | null;
  totalSamples: number;
  labelCount: number;
  hasGps: boolean;
  matchMinSimilarity: number;
  onSwitchTeach: () => void;
  onJoinDiscussion: (label: string) => void;
  onReportIssue: () => void;
  onConfirmTopMatch: (label: string) => void;
};

export function RecognizeMatchView({
  prediction,
  totalSamples,
  labelCount,
  hasGps,
  matchMinSimilarity,
  onSwitchTeach,
  onJoinDiscussion,
  onReportIssue,
  onConfirmTopMatch,
}: Props) {
  const { t } = useI18n();
  const RESULT_MIN_CONFIDENCE = 0.3;
  const isNoBuilding = prediction?.isNoBuilding === true;
  const isNotInDb = prediction?.isNotInDb === true;
  const isStrongMatch =
    !!prediction &&
    !isNoBuilding &&
    prediction.confidence >= RESULT_MIN_CONFIDENCE;
  const fallbackTop =
    prediction && Object.entries(prediction.confidences).sort((a, b) => b[1] - a[1])[0];

  if (!prediction) {
    if (hasGps) {
      return (
        <div className="flex flex-col items-center justify-center px-2 py-8 text-center">
          <p className="text-base font-bold text-zinc-900">{t("noBuildingsInRange")}</p>
          <p className="mt-2 max-w-[280px] text-sm leading-relaxed text-zinc-500">
            {t("showBuildingHint")}
          </p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center px-2 py-8 text-center">
        <p className="text-base font-bold text-zinc-900">{t("showBuildingTitle")}</p>
        <p className="mt-2 max-w-[280px] text-sm leading-relaxed text-zinc-500">
          {t("pointAtBuilding", { samples: totalSamples, labels: labelCount })}
        </p>
      </div>
    );
  }

  if (isNotInDb && !isStrongMatch) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-2 py-8 text-center">
        <Sparkles className="h-6 w-6 text-zinc-400" />
        <p className="text-base font-bold text-zinc-900">{t("notInLibraryTitle")}</p>
        <p className="max-w-[280px] text-sm leading-relaxed text-zinc-500">
          {t("notInLibraryHint")}
        </p>
        <button
          type="button"
          onClick={onReportIssue}
          className="mt-1 rounded-xl bg-ar-orange px-4 py-2 text-xs font-bold text-white shadow-sm"
        >
          {t("reportIssue")}
        </button>
        <button
          type="button"
          onClick={onSwitchTeach}
          className="mt-1 rounded-xl border border-zinc-200 bg-white px-4 py-2 text-xs font-semibold text-zinc-900 shadow-sm"
        >
          {t("modeTeach")}
        </button>
      </div>
    );
  }

  if (isNoBuilding) {
    return (
      <div className="flex flex-col items-center justify-center px-2 py-8 text-center">
        <p className="text-base font-bold text-zinc-900">{t("showBuildingTitle")}</p>
        <p className="mt-2 max-w-[280px] text-sm leading-relaxed text-zinc-500">
          {t("showBuildingHint")}
        </p>
      </div>
    );
  }

  if (prediction && !isStrongMatch) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-2 py-8 text-center">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-zinc-200 bg-zinc-50">
          <ScanSearch className="h-5 w-5 animate-pulse text-ar-navy" />
        </span>
        <p className="text-base font-bold text-zinc-900">{t("detectingSceneTitle")}</p>
        <p className="max-w-[280px] text-sm leading-relaxed text-zinc-500">
          {t("detectingSceneHint", { n: Math.round(RESULT_MIN_CONFIDENCE * 100) })}
        </p>
        {fallbackTop && (
          <p className="text-xs font-semibold text-zinc-700">
            {t("detectingSimilarityNow", {
              name: fallbackTop[0],
              n: Math.round((fallbackTop[1] ?? 0) * 100),
            })}
          </p>
        )}
      </div>
    );
  }

  const ranked =
    prediction.rankedAboveThreshold && prediction.rankedAboveThreshold.length > 0
      ? prediction.rankedAboveThreshold
      : Object.entries(prediction.confidences)
          .filter(([, s]) => s >= matchMinSimilarity)
          .sort((a, b) => b[1] - a[1])
          .map(([label, score]) => ({ label, score }));

  const alternates = ranked.length > 1 ? ranked.slice(1, 4) : [];
  const percent = Math.round(prediction.confidence * 100);

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => onConfirmTopMatch(prediction.label)}
        className="w-full rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-left shadow-sm transition active:scale-[0.99]"
      >
        <p className="text-center text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
          {t("matchedSceneNameLabel")}
        </p>
        <p className="mt-1 text-center text-lg font-bold text-zinc-900">{prediction.label}</p>
        <div className="mx-auto mt-2 h-2 w-full max-w-[260px] overflow-hidden rounded-full border border-zinc-300 bg-zinc-100">
          <div
            className="h-full rounded-full bg-ar-yellow transition-[width] duration-200"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="mt-2 text-right text-[10px] text-zinc-500">
          {t("resultThresholdHint", { n: Math.round(matchMinSimilarity * 100) })}
        </p>
      </button>
      <button
        type="button"
        onClick={() => onJoinDiscussion(prediction.label)}
        className="w-full rounded-xl border border-ar-navy/20 bg-white px-4 py-2.5 text-sm font-semibold text-ar-navy shadow-sm transition active:scale-[0.99]"
      >
        {t("joinDiscussion")}
      </button>

      {alternates.length > 0 && (
        <div className="space-y-1.5 px-1">
          {alternates.map((row, idx) => (
            <button
              key={row.label}
              type="button"
              onClick={() => onConfirmTopMatch(row.label)}
              className={cn(
                "flex w-full items-center justify-between rounded-xl border border-zinc-100 bg-zinc-50 px-3 py-2 text-left text-[11px] transition active:bg-zinc-100",
              )}
            >
              <span className="tabular-nums font-semibold text-zinc-400">{idx + 2}.</span>
              <span className="min-w-0 flex-1 truncate px-2 text-zinc-700">{row.label}</span>
              <span className="tabular-nums text-zinc-500">{Math.round(row.score * 100)}%</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
