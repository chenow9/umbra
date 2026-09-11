"use client";

import { Activity, ArrowUpRight, Globe2, Layers, Moon, Radio, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useTheme } from "@/components/app-providers";
import { LanguageSelect } from "@/components/language-picker";
import { useI18n } from "@/lib/i18n";
import { applyTheme, persistTheme } from "@/lib/theme";

export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  return (
    <div className="auth-page">
      <header className="auth-header">
        <div className="network-brand" aria-label="umbra">
          <img
            src="/favicon.svg?v=umbra-eclipse-1"
            className="eclipse-mark"
            width={29}
            height={29}
            alt=""
          />
          <span>umbra</span>
        </div>
        <div className="auth-preferences">
          <div className="auth-language">
            <Globe2 size={15} aria-hidden="true" />
            <LanguageSelect />
          </div>
          <button
            type="button"
            className="auth-theme"
            aria-label={t(theme === "moye" ? "theme.light" : "theme.dark")}
            title={t(theme === "moye" ? "theme.light" : "theme.dark")}
            onClick={() => {
              const next = theme === "moye" ? "yueying" : "moye";
              setTheme(next);
              applyTheme(next);
              persistTheme(next);
            }}
          >
            {theme === "moye" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>
      <main className="auth-main">
        <aside className="auth-intro">
          <p className="auth-eyebrow">
            <span /> UMBRA / {t("login.workspace")}
          </p>
          <h2>{t("login.introTitle")}</h2>
          <p className="auth-intro-copy">{t("login.introBody")}</p>
          <div className="auth-network" aria-hidden="true">
            <div className="auth-network-line" />
            <div className="auth-network-node">
              <Radio size={23} />
            </div>
            <div className="auth-network-hub">
              <img src="/favicon.svg?v=umbra-eclipse-1" width={82} height={82} alt="" />
            </div>
            <div className="auth-network-node">
              <Layers size={23} />
            </div>
            <span className="auth-network-pulse" />
          </div>
          <div className="auth-features">
            {[
              { icon: Radio, label: "featureNodes" },
              { icon: Layers, label: "featureServices" },
              { icon: Activity, label: "featureObserve" },
            ].map(({ icon: Icon, label }, index) => (
              <div key={label}>
                <span className="auth-feature-number">0{index + 1}</span>
                <Icon size={16} />
                <span>{t(`login.${label}`)}</span>
                <ArrowUpRight size={14} className="ml-auto opacity-40" />
              </div>
            ))}
          </div>
        </aside>
        <section className="auth-form-panel">
          <div className="auth-form-content">{children}</div>
          <p className="auth-footnote">{t("login.privateHint")}</p>
        </section>
      </main>
      <footer className="auth-footer">
        <span>umbra</span>
        <span>{t("login.tagline")}</span>
      </footer>
    </div>
  );
}
