"use client";

import { useEffect } from "react";

/** AppKit keeps scroll max-heights inside shadow roots; Reown has no theme token for this. */
const STYLE_MARK = "data-hypapad-apkt-modal-compact";

const HOST_COMPACT_CSS: Record<string, string> = {
  "w3m-connect-view": `.connect{max-height:clamp(200px,48vh,300px)!important;}`,
  "w3m-connect-wallets-view": `wui-flex{max-height:clamp(200px,50vh,320px)!important;}`,
  "w3m-connect-socials-view": `wui-flex{max-height:clamp(200px,50vh,320px)!important;}`,
  "w3m-wallet-compatible-networks-view": `wui-flex{max-height:clamp(200px,50vh,320px)!important;}`,
  "w3m-unsupported-chain-view": `wui-flex{max-height:clamp(200px,50vh,320px)!important;}`,
  "w3m-networks-view": `.container{max-height:min(280px,65vh)!important;}`,
  "w3m-onramp-tokens-select-view": `:host>wui-grid{max-height:min(280px,65vh)!important;}`,
  "w3m-onramp-fiat-select-view": `:host>wui-grid{max-height:min(280px,65vh)!important;}`,
  "w3m-swap-select-token-view": `.tokens-container{max-height:min(300px,62vh)!important;}`,
  "w3m-profile-wallets-view": `.active-wallets-box,.empty-wallet-list-box{max-height:min(280px,52vh)!important;height:auto!important;}@media (max-width:430px){.active-wallets-box,.empty-wallet-list-box{max-height:clamp(200px,48vh,300px)!important;}}`,
};

function injectIfNeeded(shadow: ShadowRoot) {
  if (shadow.querySelector(`style[${STYLE_MARK}]`)) return;
  const host = shadow.host;
  if (!(host instanceof HTMLElement)) return;
  const css = HOST_COMPACT_CSS[host.tagName.toLowerCase()];
  if (!css) return;
  const el = document.createElement("style");
  el.setAttribute(STYLE_MARK, "");
  el.textContent = css;
  shadow.appendChild(el);
}

function walkShadowTree(root: ShadowRoot) {
  injectIfNeeded(root);
  root.querySelectorAll("*").forEach((node) => {
    if (node instanceof Element && node.shadowRoot) {
      walkShadowTree(node.shadowRoot);
    }
  });
}

function syncCompactHeights() {
  const modal = document.querySelector("w3m-modal");
  if (!modal?.shadowRoot) return;
  walkShadowTree(modal.shadowRoot);
}

export function AppKitModalCompactHeights() {
  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        syncCompactHeights();
      });
    };

    schedule();
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { childList: true, subtree: true });

    return () => {
      mo.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
