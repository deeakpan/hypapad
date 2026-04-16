"use client";

import Image from "next/image";
import Link from "next/link";
import {
  ArrowsLeftRight,
  CoinVertical,
  FileText,
  HandCoins,
  MagnifyingGlass,
  SwimmingPool,
  TelegramLogo,
  TerminalWindow,
  Wallet,
} from "@phosphor-icons/react";
import { useAppKit, useAppKitAccount } from "@reown/appkit/react";
import type { ComponentType, CSSProperties } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { StaircaseMenuIcon } from "./staircase-menu-icon";

function shortenAddress(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v >= 1) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  if (v > 0) return `$${v.toLocaleString(undefined, { maximumSignificantDigits: 4 })}`;
  return "$0";
}

function fmtCreationDate(unixSec: number | null | undefined): string {
  if (!unixSec || !Number.isFinite(unixSec) || unixSec <= 0) return "—";
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function SearchLoadingSkeleton() {
  return (
    <div className="space-y-3">
      <section>
        <p className="px-1 pb-1 text-[0.68rem] font-semibold uppercase tracking-wide text-muted">Tokens</p>
        <div className="space-y-1">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={`token-skel-${i}`}
              className="rounded-lg border border-border/70 bg-canvas/50 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="mt-0.5 h-9 w-9 shrink-0 animate-pulse rounded-full bg-surface-hover" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-3.5 w-40 max-w-[85%] animate-pulse rounded bg-surface-hover" />
                  <div className="h-3 w-28 animate-pulse rounded bg-surface-hover" />
                </div>
                <div className="shrink-0 space-y-1.5">
                  <div className="h-3.5 w-20 animate-pulse rounded bg-surface-hover" />
                  <div className="h-3 w-16 animate-pulse rounded bg-surface-hover" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <p className="px-1 pb-1 text-[0.68rem] font-semibold uppercase tracking-wide text-muted">Markets</p>
        <div className="space-y-1">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={`market-skel-${i}`}
              className="rounded-lg border border-border/70 bg-canvas/50 px-3 py-2"
            >
              <div className="space-y-1.5">
                <div className="h-3.5 w-[88%] animate-pulse rounded bg-surface-hover" />
                <div className="h-3 w-28 animate-pulse rounded bg-surface-hover" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** Deterministic “random” gradient from wallet address (same address → same colors). */
function walletGradientStyle(address: string): CSSProperties {
  const hex = address.slice(2).toLowerCase();
  let seed = 2166136261;
  for (let i = 0; i < hex.length; i++) {
    seed ^= hex.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const u = (n: number) => (n >>> 0) % 360;
  const h1 = u(seed);
  const h2 = u(Math.imul(seed, 48271) + 11);
  const h3 = u(Math.imul(seed, 69621) + 97);
  const s = 56 + (seed % 28);
  const s2 = Math.min(88, s + 10 + (seed % 12));
  const l1 = 36 + ((seed >> 8) % 18);
  const l2 = 44 + ((seed >> 16) % 14);
  const l3 = 52 + ((seed >> 24) % 12);
  return {
    backgroundImage: `linear-gradient(142deg, hsl(${h1} ${s}% ${l1}%) 0%, hsl(${h2} ${s2}% ${l2}%) 52%, hsl(${h3} ${s}% ${l3}%) 100%)`,
  };
}

type MenuIcon = ComponentType<{ className?: string; size?: number; weight?: "regular" | "bold" | "fill" }>;

const MENU_ITEMS: {
  label: string;
  href: string;
  external?: boolean;
  icon: MenuIcon;
}[] = [
  { label: "Stakes", href: "/stakes", icon: Wallet },
  { label: "Terminal", href: "/terminal", icon: TerminalWindow },
  { label: "Creator Revenue", href: "/creator-revenue", icon: HandCoins },
  { label: "telegram bots", href: "https://t.me/", external: true, icon: TelegramLogo },
  { label: "$HYPA Token", href: "/hypa", icon: CoinVertical },
  { label: "pools", href: "/swap#pool", icon: SwimmingPool },
  { label: "docs", href: "/docs", icon: FileText },
];

function MenuSlideout({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>(".menu-slideout-link")?.focus();
    }, 320);
    return () => window.clearTimeout(t);
  }, [open]);

  return (
    <div
      className={`fixed inset-0 z-50 ${open ? "pointer-events-auto" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label="Close menu"
        className={`absolute inset-0 bg-canvas/35 transition-opacity duration-300 ease-out ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
        tabIndex={open ? 0 : -1}
      />
      <aside
        ref={panelRef}
        id="site-menu-slideout"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        inert={!open ? true : undefined}
        className={`absolute right-3 top-[max(4.75rem,calc(0.75rem+env(safe-area-inset-top)))] z-10 flex w-[min(17rem,calc(100vw-1.5rem))] max-w-[17rem] shrink-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface-elevated shadow-[0_12px_40px_rgba(0,0,0,0.35)] transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] sm:right-6 sm:top-[max(5.25rem,calc(env(safe-area-inset-top)+4.5rem))] ${
          open ? "translate-x-0 opacity-100" : "translate-x-[calc(100%+0.75rem)] opacity-0"
        }`}
      >
        <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
          <h2
            id={titleId}
            className="font-heading text-[0.8125rem] font-semibold tracking-wide text-fg"
          >
            Menu
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-3 py-1.5 text-[0.75rem] font-medium text-team transition-colors hover:bg-surface-hover hover:text-accent"
          >
            Close
          </button>
        </div>
        <nav
          className={`flex flex-col gap-0.5 border-t border-accent/15 bg-canvas px-2 py-3 ${open ? "menu-slideout-open" : ""}`}
          aria-label="Site"
        >
          <button
            type="button"
            onClick={onClose}
            className="menu-slideout-link flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left font-heading text-[0.9375rem] font-semibold tracking-wide text-fg transition-colors hover:bg-surface-hover hover:text-accent"
            style={{ animationDelay: "0.12s" }}
          >
            <span className="menu-slideout-icon inline-flex" style={{ animationDelay: "0.12s" }}>
              <ArrowsLeftRight
                size={20}
                weight="regular"
                className="shrink-0 text-team"
              />
            </span>
            Swap
          </button>
          {MENU_ITEMS.map((item, i) => {
            const rowIndex = i + 1;
            const delay = `${0.12 + rowIndex * 0.065}s`;
            const className =
              "menu-slideout-link flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 font-heading text-[0.9375rem] font-semibold tracking-wide text-fg transition-colors hover:bg-surface-hover hover:text-accent";
            const rowStyle: CSSProperties = { animationDelay: delay };
            const iconStyle: CSSProperties = { animationDelay: delay };
            const Icon = item.icon;
            const iconEl = (
              <span className="menu-slideout-icon inline-flex" style={iconStyle}>
                <Icon size={20} weight="regular" className="shrink-0 text-team" />
              </span>
            );
            if (item.external) {
              return (
                <a
                  key={item.href + item.label}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={className}
                  style={rowStyle}
                  onClick={onClose}
                >
                  {iconEl}
                  {item.label}
                </a>
              );
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                className={className}
                style={rowStyle}
                onClick={onClose}
              >
                {iconEl}
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
    </div>
  );
}

function ConnectControl() {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();

  const onClick = useCallback(() => {
    if (isConnected) {
      void open({ view: "Account" });
    } else {
      void open();
    }
  }, [isConnected, open]);

  const connectedStyle = useMemo(
    () => (address ? walletGradientStyle(address) : undefined),
    [address],
  );

  if (isConnected && address) {
    return (
      <button
        type="button"
        onClick={onClick}
        style={connectedStyle}
        aria-label={`Wallet ${shortenAddress(address)}`}
        title={address}
        className="h-8 w-8 shrink-0 rounded-full border border-border/60 shadow-sm ring-1 ring-white/10 transition-[filter,transform] hover:brightness-110 hover:ring-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg/50 active:scale-[0.97] sm:h-11 sm:w-11"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="font-heading inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full bg-gradient-to-r from-accent to-accent-muted px-2.5 text-[0.625rem] font-semibold tracking-wide text-fg shadow-sm transition-[filter] hover:brightness-110 sm:h-11 sm:px-6 sm:text-[0.875rem]"
    >
      Connect
    </button>
  );
}

function SearchModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 200);
    return () => window.clearTimeout(t);
  }, [q, open]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setDebouncedQ("");
  }, [open]);

  const { data, isPending } = useQuery({
    queryKey: ["global-search", debouncedQ],
    enabled: open && debouncedQ.length >= 2,
    queryFn: async () => {
      const r = await fetch(`/api/search?q=${encodeURIComponent(debouncedQ)}`);
      const d = (await r.json()) as {
        tokens: {
          token: string;
          symbol: string;
          name: string;
          href: string;
          imageUrl: string | null;
          state: "bonding" | "graduated";
          priceUsd: number | null;
          launchedAt: number | null;
        }[];
        markets: {
          marketId: string;
          description: string;
          tokenSymbol: string;
          state: "open" | "ended";
          href: string;
        }[];
      };
      if (!r.ok) throw new Error("Search failed");
      return d;
    },
    staleTime: 30_000,
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh] px-4"
      role="presentation"
    >
      <button
        type="button"
        className="absolute inset-0 bg-canvas/45"
        aria-label="Close search"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-surface-elevated p-4 shadow-xl"
      >
        <h2 id={titleId} className="sr-only">
          Search
        </h2>
        <input
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search markets, tokens, wallets…"
          className="w-full rounded-xl border border-border bg-canvas px-4 py-3 text-[0.9375rem] text-fg outline-none ring-0 placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent/40"
        />
        <div className="mt-2 max-h-[52vh] overflow-y-auto">
          {q.trim().length < 2 ? (
            <p className="text-center text-[0.75rem] text-muted">Type at least 2 characters · Press Esc to close</p>
          ) : isPending ? (
            <SearchLoadingSkeleton />
          ) : (data?.tokens?.length ?? 0) === 0 && (data?.markets?.length ?? 0) === 0 ? (
            <p className="text-center text-[0.75rem] text-muted">No results</p>
          ) : (
            <div className="space-y-3">
              {data?.tokens?.length ? (
                <section>
                  <p className="px-1 pb-1 text-[0.68rem] font-semibold uppercase tracking-wide text-muted">Tokens</p>
                  <div className="space-y-1">
                    {data.tokens.map((t) => (
                      <Link
                        key={t.token}
                        href={t.href}
                        onClick={onClose}
                        className="block rounded-lg border border-border/70 bg-canvas/50 px-3 py-2 transition-colors hover:border-accent/40 hover:bg-surface-hover"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="mt-0.5 h-9 w-9 shrink-0 overflow-hidden rounded-full border border-border bg-canvas">
                            {t.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={t.imageUrl} alt="" className="h-full w-full object-contain p-0.5" />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-[0.62rem] font-semibold text-muted">
                                {t.symbol?.slice(0, 2) || "?"}
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[0.82rem] font-semibold text-fg">
                              {t.name} <span className="text-accent">${t.symbol}</span>
                            </p>
                            <p className="truncate text-[0.68rem] text-muted">{shortenAddress(t.token)}</p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-[0.76rem] font-semibold text-team">
                              {t.state === "bonding" ? "Bonding" : "DEX"} · {fmtUsd(t.priceUsd)}
                            </p>
                            <p className="text-[0.64rem] text-muted">{fmtCreationDate(t.launchedAt)}</p>
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </section>
              ) : null}
              {data?.markets?.length ? (
                <section>
                  <p className="px-1 pb-1 text-[0.68rem] font-semibold uppercase tracking-wide text-muted">Markets</p>
                  <div className="space-y-1">
                    {data.markets.map((m) => (
                      <Link
                        key={m.marketId}
                        href={m.href}
                        onClick={onClose}
                        className="block rounded-lg border border-border/70 bg-canvas/50 px-3 py-2 transition-colors hover:border-accent/40 hover:bg-surface-hover"
                      >
                        <p className="line-clamp-1 text-[0.8rem] font-medium text-fg">{m.description}</p>
                        <p className="text-[0.68rem] text-muted">
                          #{m.marketId} · ${m.tokenSymbol} · {m.state === "open" ? "Open" : "Ended"}
                        </p>
                      </Link>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function AppHeader() {
  const pathname = usePathname();
  const usesGradientHeader =
    pathname === "/" ||
    pathname === "/swap" ||
    pathname === "/launch" ||
    pathname.startsWith("/token/") ||
    pathname.startsWith("/predictions") ||
    pathname.startsWith("/stakes");
  const [launchScrolled, setLaunchScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || target.isContentEditable;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!usesGradientHeader) {
      setLaunchScrolled(false);
      return;
    }
    const onScroll = () => setLaunchScrolled(window.scrollY > 10);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [usesGradientHeader]);

  return (
    <>
      <MenuSlideout open={menuOpen} onClose={() => setMenuOpen(false)} />
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      <div
        className={
          usesGradientHeader
            ? `sticky top-0 z-40 transition-[background-color,backdrop-filter,border-color,box-shadow] duration-300 ${
                launchScrolled
                  ? "border-b border-white/[0.08] bg-[#0c0d0f]/82 backdrop-blur-md shadow-[0_10px_40px_rgba(0,0,0,0.35)]"
                  : "border-b-0 border-transparent bg-transparent shadow-none"
              }`
            : "sticky top-0 z-40 bg-canvas"
        }
      >
        <header className="flex w-full items-center gap-2 px-4 py-2 sm:gap-8 sm:px-8 sm:py-4">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 sm:gap-3 md:gap-4">
            <Link
              href="/"
              className="relative block h-10 w-[5.25rem] shrink-0 overflow-hidden sm:h-[4.5rem] sm:w-[8.75rem] md:h-[5.25rem] md:w-[10.25rem]"
              aria-label="Hypapad home"
            >
              <Image
                src="/logo.png"
                alt=""
                fill
                className="object-contain object-left origin-left scale-[1.12] sm:scale-[1.32] md:scale-[1.36]"
                sizes="(max-width:640px) 120px, 256px"
                priority
              />
            </Link>
            <nav
              className="font-heading flex min-w-0 flex-nowrap items-center gap-1 max-sm:-ml-0.5 sm:gap-4 sm:ml-0"
              aria-label="Primary"
            >
              <Link
                href="/predictions"
                className="shrink text-[0.6875rem] font-semibold tracking-wide text-fg transition-colors hover:text-accent sm:text-[0.9375rem]"
              >
                Predictions
              </Link>
              <Link
                href="/swap"
                className="swap-button relative hidden h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-transparent px-2.5 font-heading text-[0.6875rem] font-semibold tracking-wide text-team transition-colors hover:text-fg sm:inline-flex sm:h-11 sm:px-3.5 sm:text-[0.75rem]"
                aria-label="Swap"
              >
                <ArrowsLeftRight
                  size={18}
                  weight="regular"
                  className="swap-button__icon relative shrink-0 text-current"
                />
                <span className="relative">Swap</span>
              </Link>
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-0.5 sm:gap-3">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-team sm:h-11 sm:w-11"
              aria-label="Search"
            >
              <MagnifyingGlass size={22} weight="regular" className="text-current" />
            </button>
            <Link
              href="/launch"
              className="font-heading inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full bg-gradient-to-r from-accent to-accent-muted px-2 text-[0.5625rem] font-semibold leading-tight tracking-wide text-fg shadow-sm transition-[filter] hover:brightness-110 sm:h-11 sm:px-5 sm:text-[0.8125rem]"
            >
              Launch tokens
            </Link>
            <ConnectControl />

            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Menu"
              aria-expanded={menuOpen}
              aria-controls="site-menu-slideout"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-team sm:h-11 sm:w-11"
            >
              <StaircaseMenuIcon className="text-current" />
            </button>
          </div>
        </header>
      </div>
    </>
  );
}
