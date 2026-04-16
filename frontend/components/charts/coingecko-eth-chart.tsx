"use client";

import { useEffect, useRef } from "react";

const SCRIPT_SRC = "https://widgets.coingecko.com/coingecko-coin-price-chart-widget.js";

/**
 * Placeholder: CoinGecko’s official web component (ETH).
 * Swap this wrapper later for your own chart feed.
 */
export function CoingeckoEthChart() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    const loadScript = () =>
      new Promise<void>((resolve, reject) => {
        if (document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
          resolve();
          return;
        }
        const s = document.createElement("script");
        s.src = SCRIPT_SRC;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("CoinGecko widget script failed"));
        document.body.appendChild(s);
      });

    const mount = async () => {
      try {
        await loadScript();
        if (cancelled || !hostRef.current) return;
        hostRef.current.innerHTML = "";
        const el = document.createElement("coingecko-coin-price-chart-widget");
        el.setAttribute("locale", "en");
        el.setAttribute("dark-mode", "true");
        el.setAttribute("coin-id", "ethereum");
        hostRef.current.appendChild(el);
      } catch {
        if (cancelled || !hostRef.current) return;
        hostRef.current.innerHTML =
          '<p class="p-6 text-center text-[0.875rem] text-team">Chart widget could not load (network / adblock). ETH price data still available from the trade panel via quotes.</p>';
      }
    };

    void mount();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-[min(22rem,55vh)] flex-col overflow-hidden rounded-xl border border-border bg-surface-elevated/60">
      <p className="border-b border-border/60 px-4 py-2 text-[0.75rem] font-medium uppercase tracking-wide text-muted">
        ETH / USD — CoinGecko widget (replace with Hypapad chart later)
      </p>
      <div ref={hostRef} className="min-h-[18rem] flex-1 bg-canvas/30 p-1 sm:p-2" />
    </div>
  );
}
