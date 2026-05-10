"use client";

import type { Locale } from "@/lib/i18n/dictionaries";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

const LOCALE_LABEL: Record<Locale, string> = {
  en: "ENG",
  mn: "MNG",
};

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  const toggle = () => {
    setLocale(locale === "en" ? "mn" : "en");
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-zinc-200",
        "bg-white/95 text-zinc-900 shadow-md ring-1 ring-zinc-100 backdrop-blur-sm",
        "transition active:scale-95",
      )}
      aria-label={`${t("languageSwitcherAria")}: ${LOCALE_LABEL[locale]}`}
      title={`${t("languageSwitcherAria")}: ${LOCALE_LABEL[locale]}`}
    >
      <span className="text-[11px] font-extrabold leading-none tracking-wide">
        {LOCALE_LABEL[locale]}
      </span>
    </button>
  );
}
