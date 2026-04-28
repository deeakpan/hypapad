"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Address, formatUnits, maxUint256, parseEther, zeroAddress } from "viem";
import { getPublicClient } from "@wagmi/core";
import { waitForTransactionReceipt } from "viem/actions";
import {
  useAccount,
  useBalance,
  useConfig,
  useReadContract,
  useWriteContract,
} from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowsDownUp, CaretDown, Check, Copy, GearSix, MagnifyingGlass, X } from "@phosphor-icons/react";
import { deployments, TOKEN_FACTORY_ADDRESS } from "../../lib/deployments";
import type { GraduatedSwapToken } from "../../lib/swap-graduated-tokens";
import { uniswapV2RouterAbi } from "../../lib/abis/uniswap-v2-router";
import { erc20BalanceAllowanceAbi } from "../../lib/abis/erc20-trade";
import { fetchHypaTokenMetadata } from "../../lib/ipfs";

const ROUTER_ADDRESS  = deployments.contracts.UniswapV2Router02 as Address;
const FACTORY_ADDRESS = deployments.contracts.UniswapV2Factory as Address;
const WETH_ADDRESS    = deployments.contracts.WETH9 as Address;
const CHAIN_ID        = deployments.chainId;
const REF_AMOUNT_IN   = parseEther("0.001");

const factoryAbi = [
  {
    inputs: [
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" },
    ],
    name: "getPair",
    outputs: [{ internalType: "address", name: "pair", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const pairAbi = [
  {
    inputs: [],
    name: "getReserves",
    outputs: [
      { internalType: "uint112", name: "reserve0", type: "uint112" },
      { internalType: "uint112", name: "reserve1", type: "uint112" },
      { internalType: "uint32",  name: "blockTimestampLast", type: "uint32" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token0",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

type GradToken = GraduatedSwapToken;
type SwapToken  = GradToken | "eth";
type PanelMode  = "swap" | "pool";
type PoolPickerSlot = "a" | "b";

function minOut(amount: bigint, bps: bigint): bigint {
  return (amount * (BigInt(10000) - bps)) / BigInt(10000);
}

function clampSlippagePct(n: number): number {
  return Math.max(0.1, Math.min(50, n));
}

function clampDeadlineMinsInt(n: number): number {
  return Math.max(1, Math.min(60, Math.round(n)));
}

function fmt(wei: bigint, decimals = 18, maxFrac = 6): string {
  const s = formatUnits(wei, decimals);
  const [i, f = ""] = s.split(".");
  const t = f.replace(/0+$/, "").slice(0, maxFrac);
  return t ? `${i}.${t}` : i;
}

function withIntCommas(numericString: string): string {
  const parts = numericString.split(".");
  const intRaw = parts[0] ?? "";
  const sign = intRaw.startsWith("-") ? "-" : "";
  const digits = sign ? intRaw.slice(1) : intRaw;
  if (!digits) return numericString;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = parts[1];
  return frac !== undefined ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

function formatUnitsCompact(
  wei: bigint,
  decimals = 18,
  sigFracDigits = 6,
  maxFracWhenIntNonZero = 8,
): string {
  const s = formatUnits(wei, decimals);
  const neg = s.startsWith("-");
  const abs = neg ? s.slice(1) : s;
  const [intPart, frac = ""] = abs.split(".");

  if (intPart !== "0") {
    const t = frac.replace(/0+$/, "").slice(0, maxFracWhenIntNonZero).replace(/0+$/, "");
    const out = t ? `${intPart}.${t}` : intPart;
    return neg ? `-${out}` : out;
  }

  const m = frac.match(/^(0*)([1-9]\d*)$/);
  if (!m) return neg ? "-0" : "0";
  const zeros = m[1];
  const rest = m[2];
  const sig = rest.slice(0, sigFracDigits).replace(/0+$/, "");
  const fracOut = `${zeros}${sig}`;
  const out = `0.${fracOut}`;
  return neg ? `-${out}` : out;
}

function clampWeiInputToMax(raw: string, maxWei?: bigint): string {
  if (maxWei === undefined) return raw;
  try {
    const w = parseEther(raw);
    if (w > maxWei) return fmt(maxWei);
  } catch {
    // keep user input while still typing partial values
  }
  return raw;
}

function tokenSymbol(t: SwapToken): string {
  return t === "eth" ? "ETH" : t.symbol;
}

function tokenAddr(t: SwapToken): Address {
  return t === "eth" ? WETH_ADDRESS : t.token;
}

// ── Token logo ────────────────────────────────────────────────────────────────

function TokenLogo({ tokenURI, symbol, size = 28 }: { tokenURI?: string; symbol: string; size?: number }) {
  const { data: meta } = useQuery({
    queryKey: ["meta", tokenURI],
    queryFn: () => fetchHypaTokenMetadata(tokenURI!),
    enabled: Boolean(tokenURI),
    staleTime: Infinity,
  });
  const img = meta?.imageCandidates?.[0];
  const dim = `${size}px`;
  return (
    <div className="shrink-0 overflow-hidden rounded-full border border-border bg-canvas" style={{ width: dim, height: dim }}>
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={img} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-hover to-canvas text-[0.55rem] font-bold text-accent">
          {symbol.slice(0, 2).toUpperCase()}
        </div>
      )}
    </div>
  );
}

function EthLogo({ size = 28 }: { size?: number }) {
  const dim = `${size}px`;
  return (
    <div className="shrink-0 overflow-hidden rounded-full border border-border bg-canvas" style={{ width: dim, height: dim }}>
      <Image src="/eth.webp" alt="ETH" width={size} height={size} className="h-full w-full object-cover" />
    </div>
  );
}

// ── Token picker modal (swap — shows ETH + all grad tokens, excludes one side) ──

function SwapTokenPicker({
  options,
  onSelect,
  onClose,
}: {
  options: SwapToken[];
  onSelect: (t: SwapToken) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [copiedAddr, setCopiedAddr] = useState<Address | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const copiedClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => () => {
    if (copiedClearRef.current) clearTimeout(copiedClearRef.current);
  }, []);

  const filtered = useMemo(() => {
    const lq = q.toLowerCase();
    return lq
      ? options.filter((t) => {
          if (t === "eth") return "weth eth".includes(lq);
          return (
            t.symbol.toLowerCase().includes(lq) ||
            t.name.toLowerCase().includes(lq) ||
            t.token.toLowerCase().includes(lq)
          );
        })
      : options;
  }, [options, q]);

  const copyContract = useCallback((addr: Address) => {
    void navigator.clipboard.writeText(addr).then(() => {
      if (copiedClearRef.current) clearTimeout(copiedClearRef.current);
      setCopiedAddr(addr);
      copiedClearRef.current = setTimeout(() => setCopiedAddr(null), 1600);
    });
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" className="w-full max-w-sm rounded-2xl border border-border bg-surface-elevated shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="font-heading text-[0.9375rem] font-semibold text-fg">Select token</span>
          <button type="button" onClick={onClose} className="rounded-full p-1 text-muted hover:bg-surface-hover hover:text-fg"><X size={18} /></button>
        </div>
        <div className="relative border-b border-border px-3 py-2.5">
          <MagnifyingGlass size={16} className="absolute left-5 top-1/2 -translate-y-1/2 text-muted" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or address…" className="w-full rounded-lg bg-canvas py-2 pl-7 pr-3 text-[0.8125rem] text-fg outline-none placeholder:text-muted focus:ring-1 focus:ring-accent/40" />
        </div>
        <ul className="max-h-72 overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center text-[0.8125rem] text-muted">No tokens found</li>
          ) : filtered.map((t) => {
            if (t === "eth") {
              return (
                <li key="eth" className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover">
                  <button type="button" onClick={() => { onSelect(t); onClose(); }} className="flex items-center gap-3 w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/50">
                    <EthLogo size={36} />
                    <div>
                      <p className="text-[0.875rem] font-semibold text-fg">ETH</p>
                      <p className="text-[0.72rem] text-muted">Wrapped Ether (WETH)</p>
                    </div>
                  </button>
                </li>
              );
            }
            return (
              <li key={t.token} className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover">
                <button type="button" onClick={() => { onSelect(t); onClose(); }} className="shrink-0 rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-accent/50" aria-label={`Select ${t.symbol}`}>
                  <TokenLogo tokenURI={t.tokenURI} symbol={t.symbol} size={36} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => { onSelect(t); onClose(); }} className="min-w-0 truncate text-left text-[0.875rem] font-semibold text-fg outline-none hover:text-fg focus-visible:ring-1 focus-visible:ring-accent/50">
                      {t.symbol}
                    </button>
                    <button
                      type="button"
                      onClick={() => copyContract(t.token)}
                      className="shrink-0 rounded-md p-0.5 text-muted opacity-100 transition-[opacity,colors] hover:bg-canvas/80 hover:text-accent focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-accent/50 sm:pointer-events-none sm:opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100"
                      aria-label={`Copy ${t.symbol} contract address`}
                      title="Copy contract address"
                    >
                      {copiedAddr === t.token ? (
                        <Check size={16} weight="bold" className="text-accent" aria-hidden />
                      ) : (
                        <Copy size={16} weight="bold" aria-hidden />
                      )}
                    </button>
                  </div>
                  <button type="button" onClick={() => { onSelect(t); onClose(); }} className="mt-0.5 block w-full truncate text-left text-[0.72rem] text-muted outline-none hover:text-team focus-visible:ring-1 focus-visible:ring-accent/50">
                    {t.name}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function PoolTokenPicker({
  options,
  onSelect,
  onClose,
}: {
  options: SwapToken[];
  onSelect: (t: SwapToken) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const lq = q.toLowerCase();
    return lq
      ? options.filter((t) => {
          if (t === "eth") return "weth eth".includes(lq);
          return (
            t.symbol.toLowerCase().includes(lq) ||
            t.name.toLowerCase().includes(lq) ||
            t.token.toLowerCase().includes(lq)
          );
        })
      : options;
  }, [options, q]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-surface-elevated shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="font-heading text-[0.9375rem] font-semibold text-fg">Select pool token</span>
          <button type="button" onClick={onClose} className="rounded-full p-1 text-muted hover:bg-surface-hover hover:text-fg"><X size={18} /></button>
        </div>
        <div className="relative border-b border-border px-3 py-2.5">
          <MagnifyingGlass size={16} className="absolute left-5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search token..."
            className="w-full rounded-lg bg-canvas py-2 pl-7 pr-3 text-[0.8125rem] text-fg outline-none placeholder:text-muted focus:ring-1 focus:ring-accent/40"
          />
        </div>
        <ul className="max-h-72 overflow-y-auto py-2">
          {filtered.map((t) => (
            <li key={t === "eth" ? "eth" : t.token}>
              <button
                type="button"
                onClick={() => { onSelect(t); onClose(); }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover"
              >
                {t === "eth" ? <EthLogo size={36} /> : <TokenLogo tokenURI={t.tokenURI} symbol={t.symbol} size={36} />}
                <div>
                  <p className="text-[0.875rem] font-semibold text-fg">{t === "eth" ? "ETH" : t.symbol}</p>
                  <p className="text-[0.72rem] text-muted">{t === "eth" ? "Wrapped Ether" : t.name}</p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── Token selector button ─────────────────────────────────────────────────────

function TokenSelector({ token, onOpen }: { token: SwapToken | null; onOpen: () => void }) {
  if (token === "eth") {
    return (
      <button type="button" onClick={onOpen} className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-surface-hover px-2.5 py-1.5 transition-colors hover:border-accent/50 hover:bg-surface">
        <EthLogo size={22} />
        <span className="font-heading text-[0.875rem] font-semibold text-fg">ETH</span>
        <CaretDown size={14} className="text-muted" />
      </button>
    );
  }
  if (!token) {
    return (
      <button type="button" onClick={onOpen} className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 font-heading text-[0.875rem] font-semibold text-fg shadow-sm hover:brightness-110 transition-[filter]">
        Select token <CaretDown size={14} />
      </button>
    );
  }
  return (
    <button type="button" onClick={onOpen} className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-surface-hover px-2.5 py-1.5 transition-colors hover:border-accent/50 hover:bg-surface">
      <TokenLogo tokenURI={token.tokenURI} symbol={token.symbol} size={22} />
      <span className="font-heading text-[0.875rem] font-semibold text-fg">{token.symbol}</span>
      <CaretDown size={14} className="text-muted" />
    </button>
  );
}

// ── Token input box ───────────────────────────────────────────────────────────

function TokenInputBox({ label, value, onChange, readonly, token, balance, onMax, onOpenPicker, footer }: {
  label: string; value: string; onChange?: (v: string) => void; readonly?: boolean;
  token: SwapToken | null; balance?: string; onMax?: () => void; onOpenPicker: () => void;
  footer?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface-elevated px-4 py-3.5 space-y-2">
      <div className="flex items-center justify-between text-[0.72rem] text-muted">
        <span>{label}</span>
        {balance !== undefined ? (
          <button type="button" onClick={onMax} className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[0.65rem] text-team hover:border-accent hover:text-accent transition-colors">
            MAX {balance}
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <input
          value={value}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          readOnly={readonly}
          inputMode="decimal"
          placeholder="0"
          className={`min-w-0 flex-1 bg-transparent font-mono text-2xl font-semibold text-fg outline-none placeholder:text-muted/40 ${readonly ? "cursor-default" : ""}`}
        />
        <TokenSelector token={token} onOpen={onOpenPicker} />
      </div>
      {footer ? <div className="pt-0.5 text-[0.72rem] leading-snug">{footer}</div> : null}
    </div>
  );
}

// ── Settings dropdown ─────────────────────────────────────────────────────────

const settingsFieldInput =
  "min-w-0 flex-1 border-0 bg-transparent text-right font-mono text-[0.8rem] text-fg outline-none ring-0 focus:ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

function SettingsModal({
  slippagePct, setSlippagePct,
  deadlineMins, setDeadlineMins,
  open, onClose,
}: {
  slippagePct: number; setSlippagePct: (v: number) => void;
  deadlineMins: number; setDeadlineMins: (v: number) => void;
  open: boolean; onClose: () => void;
}) {
  const [slipDraft, setSlipDraft] = useState("");
  const [deadlineDraft, setDeadlineDraft] = useState("");
  const finalizeRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    if (!open) return;
    setSlipDraft(String(slippagePct));
    setDeadlineDraft(String(deadlineMins));
  }, [open, slippagePct, deadlineMins]);

  const commitSlippageDraft = () => {
    const t = slipDraft.trim();
    if (t === "" || Number.isNaN(Number(t))) { setSlipDraft(String(slippagePct)); return; }
    const n = clampSlippagePct(Number(t));
    setSlippagePct(n);
    setSlipDraft(String(n));
  };

  const commitDeadlineDraft = () => {
    const t = deadlineDraft.trim();
    if (t === "" || Number.isNaN(Number(t))) { setDeadlineDraft(String(deadlineMins)); return; }
    const n = clampDeadlineMinsInt(Number(t));
    setDeadlineMins(n);
    setDeadlineDraft(String(n));
  };

  finalizeRef.current = () => { commitSlippageDraft(); commitDeadlineDraft(); onClose(); };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") finalizeRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const layer = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) finalizeRef.current(); }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="swap-settings-title" className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-surface-elevated shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span id="swap-settings-title" className="font-heading text-[0.9375rem] font-semibold text-fg">Swap settings</span>
          <button type="button" onClick={() => finalizeRef.current()} className="rounded-full p-1 text-muted transition-colors hover:bg-surface-hover hover:text-fg"><X size={18} /></button>
        </div>
        <div className="space-y-4 px-4 py-4">
          <div>
            <p className="mb-2 text-[0.68rem] font-semibold uppercase tracking-widest text-muted">Slippage tolerance</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {[0.1, 0.5, 1.0].map((v) => (
                <button key={v} type="button" onClick={() => setSlippagePct(v)} className={`rounded-lg px-2.5 py-1 font-mono text-[0.8rem] transition-colors ${slippagePct === v ? "bg-accent text-fg shadow-sm" : "text-muted hover:bg-surface-hover hover:text-fg"}`}>
                  {v}%
                </button>
              ))}
              <div className="flex min-w-[5.5rem] flex-1 items-center gap-0.5 rounded-lg border border-border bg-canvas px-2 py-1.5 focus-within:border-accent/60 focus-within:ring-1 focus-within:ring-accent/30">
                <input type="text" inputMode="decimal" autoComplete="off" value={slipDraft} onChange={(e) => setSlipDraft(e.target.value)} onBlur={commitSlippageDraft} className={settingsFieldInput} />
                <span className="shrink-0 text-[0.7rem] text-muted">%</span>
              </div>
            </div>
            {slippagePct > 5 ? <p className="mt-1.5 text-[0.7rem] text-amber-400">High slippage — you may get a worse price.</p> : null}
          </div>
          <div className="h-px bg-border" />
          <div>
            <p className="mb-2 text-[0.68rem] font-semibold uppercase tracking-widest text-muted">Transaction deadline</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {[5, 10, 20].map((v) => (
                <button key={v} type="button" onClick={() => setDeadlineMins(v)} className={`rounded-lg px-2.5 py-1 font-mono text-[0.8rem] transition-colors ${deadlineMins === v ? "bg-accent text-fg shadow-sm" : "text-muted hover:bg-surface-hover hover:text-fg"}`}>
                  {v}m
                </button>
              ))}
              <div className="flex min-w-[5.5rem] flex-1 items-center gap-0.5 rounded-lg border border-border bg-canvas px-2 py-1.5 focus-within:border-accent/60 focus-within:ring-1 focus-within:ring-accent/30">
                <input type="text" inputMode="numeric" autoComplete="off" value={deadlineDraft} onChange={(e) => setDeadlineDraft(e.target.value)} onBlur={commitDeadlineDraft} className={settingsFieldInput} />
                <span className="shrink-0 text-[0.7rem] text-muted">min</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(layer, document.body);
}

// ── Main swap panel ───────────────────────────────────────────────────────────

export function SwapPanel({
  initialTokenAddress,
  compact = false,
}: {
  initialTokenAddress?: Address;
  compact?: boolean;
} = {}) {
  const config   = useConfig();
  const qc       = useQueryClient();
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();

  // ── Swap state ─────────────────────────────────────────────────────────────
  const [tokenIn,  setTokenIn]  = useState<SwapToken>("eth");
  const [tokenOut, setTokenOut] = useState<SwapToken | null>(null);
  const [amount, setAmount]     = useState("");
  const [rotated, setRotated]   = useState(false);
  const [pickerFor, setPickerFor] = useState<"in" | "out" | null>(null);
  const [busy, setBusy]           = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [slippagePct, setSlippagePct] = useState(0.5);
  const [deadlineMins, setDeadlineMins] = useState(5);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── Pool state ─────────────────────────────────────────────────────────────
  const [panelMode, setPanelMode]       = useState<PanelMode>("swap");
  const [poolTokenA, setPoolTokenA]     = useState<SwapToken>("eth");
  const [poolTokenB, setPoolTokenB]     = useState<SwapToken | null>(null);
  const [poolPickerFor, setPoolPickerFor] = useState<PoolPickerSlot | null>(null);
  const [poolAmountA, setPoolAmountA]   = useState("");
  const [poolAmountB, setPoolAmountB]   = useState("");
  const [poolBusy, setPoolBusy]         = useState(false);
  const [poolError, setPoolError]       = useState<string | null>(null);
  const [poolSuccess, setPoolSuccess]   = useState<string | null>(null);

  // ── Graduated token list ───────────────────────────────────────────────────
  const { data: tokenList } = useQuery({
    queryKey: ["swap-token-list", CHAIN_ID, TOKEN_FACTORY_ADDRESS],
    queryFn: async () => {
      const res = await fetch("/api/swap-graduated-tokens");
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to load graduated tokens");
      }
      const body = (await res.json()) as { tokens: GraduatedSwapToken[] };
      return body.tokens;
    },
    staleTime: 4 * 60 * 1000,
  });
  const gradTokens: GradToken[] = tokenList ?? [];

  // Set initial token once when list loads
  const initialSet = useRef(false);
  useEffect(() => {
    if (!initialTokenAddress || gradTokens.length === 0 || initialSet.current) return;
    const match = gradTokens.find(t => t.token.toLowerCase() === initialTokenAddress.toLowerCase());
    if (match) {
      setTokenOut(match);
      setPoolTokenB(match);
      initialSet.current = true;
    }
  }, [initialTokenAddress, gradTokens]);

  useEffect(() => {
    const readHash = () => setPanelMode(window.location.hash.toLowerCase() === "#pool" ? "pool" : "swap");
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);

  const switchPanelMode = useCallback((next: PanelMode) => {
    setPanelMode(next);
    if (typeof window === "undefined") return;
    if (next === "pool") window.history.replaceState(null, "", "#pool");
    else window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  // ── Derived swap flags ─────────────────────────────────────────────────────
  const isEthIn       = tokenIn === "eth";
  const isEthOut      = tokenOut === "eth";
  const isTokenToToken = !isEthIn && tokenOut !== null && !isEthOut;
  const tokenInGrad:  GradToken | null = isEthIn  ? null : (tokenIn  as GradToken);
  const tokenOutGrad: GradToken | null = (tokenOut === null || isEthOut) ? null : (tokenOut as GradToken);

  // ── Balances ───────────────────────────────────────────────────────────────
  const { data: ethBal } = useBalance({ address, chainId: CHAIN_ID, query: { enabled: isConnected } });
  const { data: tokenInBalRaw } = useReadContract({
    address: tokenInGrad?.token,
    abi: erc20BalanceAllowanceAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: isConnected && Boolean(tokenInGrad) && Boolean(address) },
  });
  const { data: tokenOutBalRaw } = useReadContract({
    address: tokenOutGrad?.token,
    abi: erc20BalanceAllowanceAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: isConnected && Boolean(tokenOutGrad) && Boolean(address) },
  });
  const { data: tokenInAllowanceRaw } = useReadContract({
    address: tokenInGrad?.token,
    abi: erc20BalanceAllowanceAbi,
    functionName: "allowance",
    args: address ? [address, ROUTER_ADDRESS] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: isConnected && Boolean(tokenInGrad) && Boolean(address) },
  });

  const ethBalance    = ethBal?.value;
  const tokenInBal    = tokenInBalRaw  as bigint | undefined;
  const tokenOutBal   = tokenOutBalRaw as bigint | undefined;
  const allowance     = (tokenInAllowanceRaw as bigint | undefined) ?? BigInt(0);
  const slippageBps   = BigInt(Math.round(slippagePct * 100));

  const inBalance  = isEthIn  ? ethBalance  : tokenInBal;
  const outBalance = isEthOut ? ethBalance  : tokenOutBal;

  const inBalanceLabel = inBalance !== undefined
    ? `${withIntCommas(fmt(inBalance))} ${tokenSymbol(tokenIn)}`
    : undefined;
  const outBalanceLabel = outBalance !== undefined && tokenOut !== null
    ? `${withIntCommas(fmt(outBalance))} ${tokenSymbol(tokenOut)}`
    : undefined;

  // ── Direct pool check (token→token only) ──────────────────────────────────
  const { data: directPairAddr } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: factoryAbi,
    functionName: "getPair",
    args: isTokenToToken && tokenInGrad && tokenOutGrad
      ? [tokenInGrad.token, tokenOutGrad.token]
      : undefined,
    chainId: CHAIN_ID,
    query: { enabled: isTokenToToken, refetchInterval: 15000 },
  });
  const directPoolExists = Boolean(directPairAddr && directPairAddr !== zeroAddress);

  // ── Path computation ───────────────────────────────────────────────────────
  const path = useMemo<Address[] | null>(() => {
    if (!tokenOut) return null;
    const inAddr  = tokenAddr(tokenIn);
    const outAddr = tokenAddr(tokenOut);
    if (isTokenToToken) {
      return directPoolExists
        ? [inAddr, outAddr]
        : [inAddr, WETH_ADDRESS, outAddr];
    }
    return [inAddr, outAddr];
  }, [tokenIn, tokenOut, isTokenToToken, directPoolExists]);

  const viaWeth = isTokenToToken && !directPoolExists && tokenOut !== null;

  // ── Amount ─────────────────────────────────────────────────────────────────
  const amountWei = useMemo(() => {
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) return null;
    try { return parseEther(amount); } catch { return null; }
  }, [amount]);

  // ── Quote ──────────────────────────────────────────────────────────────────
  const { data: amountsOut, isError: quoteIsError } = useReadContract({
    address: ROUTER_ADDRESS, abi: uniswapV2RouterAbi, functionName: "getAmountsOut",
    args: amountWei !== null && path !== null ? [amountWei, path] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: amountWei !== null && path !== null, refetchInterval: 5000 },
  });
  const quoteOut = (amountsOut as bigint[] | undefined)?.[path ? path.length - 1 : 1] ?? null;

  // ── Reference quote for price impact ──────────────────────────────────────
  const { data: refAmountsOut } = useReadContract({
    address: ROUTER_ADDRESS, abi: uniswapV2RouterAbi, functionName: "getAmountsOut",
    args: path !== null ? [REF_AMOUNT_IN, path] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: path !== null, refetchInterval: 5000 },
  });
  const refOut = (refAmountsOut as bigint[] | undefined)?.[path ? path.length - 1 : 1] ?? null;

  const priceImpact = useMemo(() => {
    if (!amountWei || amountWei === BigInt(0) || !quoteOut || !refOut || refOut === BigInt(0)) return null;
    const midRate    = (refOut   * parseEther("1")) / REF_AMOUNT_IN;
    const actualRate = (quoteOut * parseEther("1")) / amountWei;
    if (midRate === BigInt(0)) return null;
    const impactBps  = ((midRate - actualRate) * BigInt(10000)) / midRate;
    return Number(impactBps) / 100;
  }, [amountWei, quoteOut, refOut]);

  // Quote reverts on-chain for no-pool / reserve exhausted; or price impact ≥ 80% means effectively unexecutable.
  const insufficientLiquidity =
    (quoteIsError && amountWei !== null && path !== null) ||
    (priceImpact !== null && priceImpact >= 80);

  const quoteDisplay = useMemo(
    () => (quoteOut !== null ? formatUnitsCompact(quoteOut) : ""),
    [quoteOut],
  );

  // ── ETH/USD price ──────────────────────────────────────────────────────────
  const { data: ethUsdData } = useQuery({
    queryKey: ["eth-usd"],
    queryFn: async () => {
      const res = await fetch("/api/eth-usd");
      if (!res.ok) return null;
      const body = (await res.json()) as { usd?: number };
      return typeof body.usd === "number" ? body.usd : null;
    },
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });
  const ethUsdPrice = ethUsdData ?? null;

  // For direct token→token pools, fetch the ETH value of the output separately.
  const needsOutEthQuery = isTokenToToken && directPoolExists && Boolean(tokenOutGrad) && quoteOut !== null;
  const { data: outEthAmountsData } = useReadContract({
    address: ROUTER_ADDRESS,
    abi: uniswapV2RouterAbi,
    functionName: "getAmountsOut",
    args: needsOutEthQuery && tokenOutGrad && quoteOut ? [quoteOut, [tokenOutGrad.token, WETH_ADDRESS]] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: needsOutEthQuery, refetchInterval: 5000 },
  });

  // ETH-equivalent of what the user receives (used for USD conversion).
  const outEthWei = useMemo<bigint | null>(() => {
    if (!quoteOut) return null;
    if (isEthOut) return quoteOut;                                                       // token→ETH: output is ETH
    if (isEthIn)  return (amountsOut as bigint[] | undefined)?.[0] ?? null;              // ETH→token: ETH input ≈ ETH value
    if (viaWeth)  return (amountsOut as bigint[] | undefined)?.[1] ?? null;              // token→WETH→token: WETH intermediate
    return (outEthAmountsData as bigint[] | undefined)?.[1] ?? null;                     // direct token→token: separate query
  }, [quoteOut, isEthOut, isEthIn, viaWeth, amountsOut, outEthAmountsData]);

  const quoteUsd = useMemo<string | null>(() => {
    if (!ethUsdPrice || !outEthWei) return null;
    const eth = Number(formatUnits(outEthWei, 18));
    const usd = eth * ethUsdPrice;
    if (!isFinite(usd) || usd < 0.0001) return null;
    if (usd >= 10000) return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    if (usd >= 1)     return `$${usd.toFixed(2)}`;
    return `$${usd.toFixed(4)}`;
  }, [ethUsdPrice, outEthWei]);

  // ── Balance check ──────────────────────────────────────────────────────────
  const exceedsBalance = useMemo(() => {
    if (!amountWei) return false;
    if (isEthIn) return ethBalance !== undefined && amountWei > ethBalance;
    return tokenInBal !== undefined && amountWei > tokenInBal;
  }, [amountWei, isEthIn, ethBalance, tokenInBal]);

  // ── Swap ───────────────────────────────────────────────────────────────────
  const onSwap = useCallback(async () => {
    if (!tokenOut || !amountWei || !address || !path) return;
    setError(null); setSuccessMsg(null); setBusy(true);
    try {
      const pc = getPublicClient(config, { chainId: CHAIN_ID });
      if (!pc) throw new Error("No public client");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineMins * 60);

      if (isEthIn) {
        const minTokens = quoteOut ? minOut(quoteOut, slippageBps) : BigInt(0);
        const hash = await writeContractAsync({
          address: ROUTER_ADDRESS, abi: uniswapV2RouterAbi,
          functionName: "swapExactETHForTokens",
          args: [minTokens, path, address, deadline],
          value: amountWei, chainId: CHAIN_ID,
        });
        await waitForTransactionReceipt(pc, { hash });
        setSuccessMsg(`Swapped ${amount} ETH → ${quoteOut ? formatUnitsCompact(quoteOut) : "?"} ${tokenSymbol(tokenOut)}`);

      } else if (isEthOut) {
        if (allowance < amountWei) {
          const ah = await writeContractAsync({
            address: (tokenIn as GradToken).token, abi: erc20BalanceAllowanceAbi,
            functionName: "approve", args: [ROUTER_ADDRESS, maxUint256], chainId: CHAIN_ID,
          });
          await waitForTransactionReceipt(pc, { hash: ah });
        }
        const minEth = quoteOut ? minOut(quoteOut, slippageBps) : BigInt(0);
        const hash = await writeContractAsync({
          address: ROUTER_ADDRESS, abi: uniswapV2RouterAbi,
          functionName: "swapExactTokensForETH",
          args: [amountWei, minEth, path, address, deadline],
          chainId: CHAIN_ID,
        });
        await waitForTransactionReceipt(pc, { hash });
        setSuccessMsg(`Swapped ${amount} ${tokenSymbol(tokenIn)} → ${quoteOut ? formatUnitsCompact(quoteOut) : "?"} ETH`);

      } else {
        // token → token
        if (allowance < amountWei) {
          const ah = await writeContractAsync({
            address: (tokenIn as GradToken).token, abi: erc20BalanceAllowanceAbi,
            functionName: "approve", args: [ROUTER_ADDRESS, maxUint256], chainId: CHAIN_ID,
          });
          await waitForTransactionReceipt(pc, { hash: ah });
        }
        const minTokens = quoteOut ? minOut(quoteOut, slippageBps) : BigInt(0);
        const hash = await writeContractAsync({
          address: ROUTER_ADDRESS, abi: uniswapV2RouterAbi,
          functionName: "swapExactTokensForTokens",
          args: [amountWei, minTokens, path, address, deadline],
          chainId: CHAIN_ID,
        });
        await waitForTransactionReceipt(pc, { hash });
        setSuccessMsg(`Swapped ${amount} ${tokenSymbol(tokenIn)} → ${quoteOut ? formatUnitsCompact(quoteOut) : "?"} ${tokenSymbol(tokenOut)}`);
      }

      setAmount("");
      await qc.invalidateQueries();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Swap failed";
      setError(msg.toLowerCase().includes("user rejected") || msg.toLowerCase().includes("user denied") ? "Transaction rejected." : "Swap failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }, [tokenIn, tokenOut, amountWei, address, path, isEthIn, isEthOut, quoteOut, allowance, amount, config, writeContractAsync, qc, deadlineMins, slippageBps]);

  const handleFlip = () => {
    setRotated(r => !r);
    const prevIn  = tokenIn;
    const prevOut = tokenOut;
    setTokenIn(prevOut ?? "eth");
    setTokenOut(prevIn);
    setAmount("");
    setError(null);
    setSuccessMsg(null);
  };

  const handlePickSwapToken = useCallback((slot: "in" | "out", t: SwapToken) => {
    if (slot === "in") {
      setTokenIn(t);
      // if same as tokenOut, clear tokenOut
      if (tokenOut !== null && tokenAddr(t) === tokenAddr(tokenOut)) setTokenOut(null);
    } else {
      setTokenOut(t);
      if (tokenAddr(t) === tokenAddr(tokenIn)) setTokenIn("eth");
    }
    setAmount("");
    setError(null);
    setSuccessMsg(null);
  }, [tokenIn, tokenOut]);

  // picker options — exclude the other side's selection
  const pickerOptionsIn = useMemo<SwapToken[]>(() => {
    const all: SwapToken[] = ["eth", ...gradTokens];
    if (!tokenOut) return all;
    const excl = tokenAddr(tokenOut);
    return all.filter(t => tokenAddr(t) !== excl);
  }, [gradTokens, tokenOut]);

  const pickerOptionsOut = useMemo<SwapToken[]>(() => {
    const all: SwapToken[] = ["eth", ...gradTokens];
    const excl = tokenAddr(tokenIn);
    return all.filter(t => tokenAddr(t) !== excl);
  }, [gradTokens, tokenIn]);

  const disabled = busy || !isConnected || !tokenOut || !amountWei || insufficientLiquidity || quoteOut === null || exceedsBalance;

  // ── Pool derived ───────────────────────────────────────────────────────────
  const poolIsTokenToken = poolTokenA !== "eth" && poolTokenB !== null && poolTokenB !== "eth";
  const poolHasTwoTokens = Boolean(poolTokenA && poolTokenB);

  const poolIsSameToken = (() => {
    if (!poolTokenB) return false;
    return tokenAddr(poolTokenA) === tokenAddr(poolTokenB);
  })();
  const poolInvalidPair = !poolHasTwoTokens || poolIsSameToken;

  const poolTokenAGrad: GradToken | null = poolTokenA !== "eth" ? (poolTokenA as GradToken) : null;
  const poolTokenBGrad: GradToken | null = poolTokenB !== null && poolTokenB !== "eth" ? (poolTokenB as GradToken) : null;

  // ── Pool balances/allowances (per slot) ────────────────────────────────────
  const { data: poolTokenABalRaw } = useReadContract({
    address: poolTokenAGrad?.token,
    abi: erc20BalanceAllowanceAbi, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId: CHAIN_ID,
    query: { enabled: isConnected && Boolean(poolTokenAGrad) && Boolean(address) },
  });
  const { data: poolTokenBBalRaw } = useReadContract({
    address: poolTokenBGrad?.token,
    abi: erc20BalanceAllowanceAbi, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId: CHAIN_ID,
    query: { enabled: isConnected && Boolean(poolTokenBGrad) && Boolean(address) },
  });
  const { data: poolTokenAAllowanceRaw } = useReadContract({
    address: poolTokenAGrad?.token,
    abi: erc20BalanceAllowanceAbi, functionName: "allowance",
    args: address ? [address, ROUTER_ADDRESS] : undefined, chainId: CHAIN_ID,
    query: { enabled: isConnected && Boolean(poolTokenAGrad) && Boolean(address) },
  });
  const { data: poolTokenBAllowanceRaw } = useReadContract({
    address: poolTokenBGrad?.token,
    abi: erc20BalanceAllowanceAbi, functionName: "allowance",
    args: address ? [address, ROUTER_ADDRESS] : undefined, chainId: CHAIN_ID,
    query: { enabled: isConnected && Boolean(poolTokenBGrad) && Boolean(address) },
  });

  const poolTokenABalance   = poolTokenABalRaw  as bigint | undefined;
  const poolTokenBBalance   = poolTokenBBalRaw  as bigint | undefined;
  const poolTokenAAllowance = (poolTokenAAllowanceRaw as bigint | undefined) ?? BigInt(0);
  const poolTokenBAllowance = (poolTokenBAllowanceRaw as bigint | undefined) ?? BigInt(0);

  // ── Pool amounts ───────────────────────────────────────────────────────────
  const poolAmountAWei = useMemo(() => {
    if (!poolAmountA || Number(poolAmountA) <= 0) return null;
    try { return parseEther(poolAmountA); } catch { return null; }
  }, [poolAmountA]);
  const poolAmountBWei = useMemo(() => {
    if (!poolAmountB || Number(poolAmountB) <= 0) return null;
    try { return parseEther(poolAmountB); } catch { return null; }
  }, [poolAmountB]);

  const poolExceedsA = useMemo(() => {
    if (poolAmountAWei === null) return false;
    if (poolTokenA === "eth") return ethBalance !== undefined && poolAmountAWei > ethBalance;
    return poolTokenABalance !== undefined && poolAmountAWei > poolTokenABalance;
  }, [poolAmountAWei, poolTokenA, ethBalance, poolTokenABalance]);

  const poolExceedsB = useMemo(() => {
    if (poolAmountBWei === null || !poolTokenB) return false;
    if (poolTokenB === "eth") return ethBalance !== undefined && poolAmountBWei > ethBalance;
    return poolTokenBBalance !== undefined && poolAmountBWei > poolTokenBBalance;
  }, [poolAmountBWei, poolTokenB, ethBalance, poolTokenBBalance]);

  const poolSideBalanceWei = useCallback(
    (slot: PoolPickerSlot): bigint | undefined => {
      const token = slot === "a" ? poolTokenA : poolTokenB;
      if (!token) return undefined;
      if (token === "eth") return ethBalance;
      return slot === "a" ? poolTokenABalance : poolTokenBBalance;
    },
    [ethBalance, poolTokenABalance, poolTokenBBalance, poolTokenA, poolTokenB],
  );

  const poolSideBalanceLabel = useCallback(
    (slot: PoolPickerSlot): string | undefined => {
      const token = slot === "a" ? poolTokenA : poolTokenB;
      if (!token) return undefined;
      const bal = poolSideBalanceWei(slot);
      if (bal === undefined) return undefined;
      return `${withIntCommas(fmt(bal))} ${tokenSymbol(token)}`;
    },
    [poolSideBalanceWei, poolTokenA, poolTokenB],
  );

  const setPoolAmountForSide = useCallback(
    (slot: PoolPickerSlot, raw: string) => {
      const max = poolSideBalanceWei(slot);
      const next = clampWeiInputToMax(raw, max);
      if (slot === "a") setPoolAmountA(next);
      else setPoolAmountB(next);
      setPoolError(null);
      setPoolSuccess(null);
    },
    [poolSideBalanceWei],
  );

  const fillPoolMax = useCallback(
    (slot: PoolPickerSlot) => {
      const max = poolSideBalanceWei(slot);
      if (max === undefined) return;
      if (slot === "a") setPoolAmountA(fmt(max));
      else setPoolAmountB(fmt(max));
      setPoolError(null);
      setPoolSuccess(null);
    },
    [poolSideBalanceWei],
  );

  const reversePoolPair = useCallback(() => {
    const a = poolTokenA;
    const b = poolTokenB;
    setPoolTokenA(b ?? "eth");
    setPoolTokenB(a);
    setPoolAmountA(poolAmountB);
    setPoolAmountB(poolAmountA);
    setPoolError(null);
    setPoolSuccess(null);
  }, [poolTokenA, poolTokenB, poolAmountA, poolAmountB]);

  const poolDisabled =
    poolBusy || !isConnected || poolInvalidPair ||
    poolAmountAWei === null || poolAmountBWei === null ||
    poolExceedsA || poolExceedsB;

  // ── Pool pair existence + reserves ────────────────────────────────────────
  const { data: poolPairAddress } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: factoryAbi,
    functionName: "getPair",
    args: !poolInvalidPair && poolTokenB ? [tokenAddr(poolTokenA), tokenAddr(poolTokenB)] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !poolInvalidPair && Boolean(poolTokenB), refetchInterval: 10000 },
  });
  const poolPairExists = Boolean(poolPairAddress && poolPairAddress !== zeroAddress);

  const { data: poolReservesRaw } = useReadContract({
    address: poolPairExists ? (poolPairAddress as Address) : undefined,
    abi: pairAbi,
    functionName: "getReserves",
    chainId: CHAIN_ID,
    query: { enabled: poolPairExists, refetchInterval: 10000 },
  });
  const { data: poolPairToken0Raw } = useReadContract({
    address: poolPairExists ? (poolPairAddress as Address) : undefined,
    abi: pairAbi,
    functionName: "token0",
    chainId: CHAIN_ID,
    query: { enabled: poolPairExists },
  });

  const poolReserves = useMemo(() => {
    if (!poolReservesRaw || !poolPairToken0Raw || !poolTokenB || !poolPairExists) return null;
    const [r0, r1] = poolReservesRaw as [bigint, bigint, number];
    const isAToken0 = tokenAddr(poolTokenA).toLowerCase() === (poolPairToken0Raw as Address).toLowerCase();
    return {
      reserveA: isAToken0 ? r0 : r1,
      reserveB: isAToken0 ? r1 : r0,
      symA: tokenSymbol(poolTokenA),
      symB: tokenSymbol(poolTokenB),
    };
  }, [poolReservesRaw, poolPairToken0Raw, poolTokenA, poolTokenB, poolPairExists]);

  // ── Pool options — exclude other slot ──────────────────────────────────────
  const poolOptionsA = useMemo<SwapToken[]>(() => {
    const all: SwapToken[] = ["eth", ...gradTokens];
    if (!poolTokenB) return all;
    const excl = tokenAddr(poolTokenB);
    return all.filter(t => tokenAddr(t) !== excl);
  }, [gradTokens, poolTokenB]);

  const poolOptionsB = useMemo<SwapToken[]>(() => {
    const all: SwapToken[] = ["eth", ...gradTokens];
    const excl = tokenAddr(poolTokenA);
    return all.filter(t => tokenAddr(t) !== excl);
  }, [gradTokens, poolTokenA]);

  // ── Add liquidity ──────────────────────────────────────────────────────────
  const onAddLiquidity = useCallback(async () => {
    if (!address || poolInvalidPair || poolAmountAWei === null || poolAmountBWei === null) return;
    setPoolError(null); setPoolSuccess(null); setPoolBusy(true);
    try {
      const pc = getPublicClient(config, { chainId: CHAIN_ID });
      if (!pc) throw new Error("No public client");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 60);

      if (poolIsTokenToken) {
        const tokenA = poolTokenA as GradToken;
        const tokenB = poolTokenB as GradToken;
        if (poolTokenAAllowance < poolAmountAWei) {
          const ah = await writeContractAsync({
            address: tokenA.token, abi: erc20BalanceAllowanceAbi,
            functionName: "approve", args: [ROUTER_ADDRESS, maxUint256], chainId: CHAIN_ID,
          });
          await waitForTransactionReceipt(pc, { hash: ah });
        }
        if (poolTokenBAllowance < poolAmountBWei) {
          const bh = await writeContractAsync({
            address: tokenB.token, abi: erc20BalanceAllowanceAbi,
            functionName: "approve", args: [ROUTER_ADDRESS, maxUint256], chainId: CHAIN_ID,
          });
          await waitForTransactionReceipt(pc, { hash: bh });
        }
        const hash = await writeContractAsync({
          address: ROUTER_ADDRESS, abi: uniswapV2RouterAbi,
          functionName: "addLiquidity",
          args: [tokenA.token, tokenB.token, poolAmountAWei, poolAmountBWei, BigInt(0), BigInt(0), address, deadline],
          chainId: CHAIN_ID,
        });
        await waitForTransactionReceipt(pc, { hash });
        setPoolSuccess(`${poolPairExists ? "Added liquidity" : "Created pair"} for ${tokenA.symbol}/${tokenB.symbol}.`);

      } else {
        // ETH + token
        const isAEth    = poolTokenA === "eth";
        const gradToken = isAEth ? (poolTokenB as GradToken) : (poolTokenA as GradToken);
        const tokenWei  = isAEth ? poolAmountBWei : poolAmountAWei;
        const ethWei    = isAEth ? poolAmountAWei : poolAmountBWei;
        const tokenAllowance = isAEth ? poolTokenBAllowance : poolTokenAAllowance;

        if (tokenAllowance < tokenWei) {
          const ah = await writeContractAsync({
            address: gradToken.token, abi: erc20BalanceAllowanceAbi,
            functionName: "approve", args: [ROUTER_ADDRESS, maxUint256], chainId: CHAIN_ID,
          });
          await waitForTransactionReceipt(pc, { hash: ah });
        }
        const hash = await writeContractAsync({
          address: ROUTER_ADDRESS, abi: uniswapV2RouterAbi,
          functionName: "addLiquidityETH",
          args: [gradToken.token, tokenWei, BigInt(0), BigInt(0), address, deadline],
          value: ethWei,
          chainId: CHAIN_ID,
        });
        await waitForTransactionReceipt(pc, { hash });
        setPoolSuccess(`${poolPairExists ? "Added liquidity" : "Created pair"} for ${gradToken.symbol}/ETH.`);
      }

      setPoolAmountA("");
      setPoolAmountB("");
      await qc.invalidateQueries();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Add liquidity failed";
      setPoolError(msg.toLowerCase().includes("user rejected") || msg.toLowerCase().includes("user denied")
        ? "Transaction rejected."
        : "Add liquidity failed. Please try again.");
    } finally {
      setPoolBusy(false);
    }
  }, [address, poolInvalidPair, poolAmountAWei, poolAmountBWei, poolIsTokenToken, poolTokenA, poolTokenB, poolTokenAAllowance, poolTokenBAllowance, writeContractAsync, config, qc]);

  // ── Price impact color ─────────────────────────────────────────────────────
  const impactColor =
    priceImpact === null ? ""
    : priceImpact >= 15  ? "text-red-400"
    : priceImpact >= 5   ? "text-amber-400"
    : priceImpact >= 2   ? "text-yellow-300"
    : "text-fg";

  return (
    <>
      {pickerFor === "in" ? (
        <SwapTokenPicker
          options={pickerOptionsIn}
          onSelect={(t) => handlePickSwapToken("in", t)}
          onClose={() => setPickerFor(null)}
        />
      ) : pickerFor === "out" ? (
        <SwapTokenPicker
          options={pickerOptionsOut}
          onSelect={(t) => handlePickSwapToken("out", t)}
          onClose={() => setPickerFor(null)}
        />
      ) : null}
      {poolPickerFor !== null ? (
        <PoolTokenPicker
          options={poolPickerFor === "a" ? poolOptionsA : poolOptionsB}
          onSelect={(token) => {
            if (poolPickerFor === "a") setPoolTokenA(token);
            else setPoolTokenB(token);
            setPoolError(null);
            setPoolSuccess(null);
          }}
          onClose={() => setPoolPickerFor(null)}
        />
      ) : null}

      {/* Header row */}
      <div className={`${compact ? "mb-2" : "mb-4"} flex items-center justify-between`}>
        {compact ? (
          <span />
        ) : (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => switchPanelMode("swap")} className={`rounded-md px-2 py-1 text-[0.72rem] transition-colors ${panelMode === "swap" ? "bg-surface-elevated text-fg" : "text-muted hover:text-fg"}`}>Swap</button>
            <button type="button" onClick={() => switchPanelMode("pool")} className={`rounded-md px-2 py-1 text-[0.72rem] transition-colors ${panelMode === "pool" ? "bg-surface-elevated text-fg" : "text-muted hover:text-fg"}`}>Pools</button>
          </div>
        )}
        <div className="relative">
          <button
            type="button"
            onClick={() => setSettingsOpen(v => !v)}
            className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[0.72rem] transition-colors ${settingsOpen ? "border-accent/50 bg-surface-elevated text-accent" : "border-border bg-surface-elevated text-team hover:border-accent/50 hover:text-accent"}`}
            aria-label="Swap settings"
          >
            <GearSix size={15} weight="bold" />
            <span className="font-mono">{slippagePct.toFixed(1)}%</span>
          </button>
          <SettingsModal
            slippagePct={slippagePct} setSlippagePct={setSlippagePct}
            deadlineMins={deadlineMins} setDeadlineMins={setDeadlineMins}
            open={settingsOpen} onClose={() => setSettingsOpen(false)}
          />
        </div>
      </div>

      {panelMode === "swap" ? (
        <div className={compact ? "space-y-1" : "space-y-1.5"}>
          <TokenInputBox
            label="You pay"
            value={amount}
            onChange={(v) => { setAmount(v); setError(null); setSuccessMsg(null); }}
            token={tokenIn}
            balance={isConnected ? inBalanceLabel : undefined}
            onMax={() => setAmount(inBalance !== undefined ? fmt(inBalance) : "")}
            onOpenPicker={() => setPickerFor("in")}
            footer={
              exceedsBalance && amountWei ? (
                <span className="text-red-400/95">Insufficient balance for this amount.</span>
              ) : null
            }
          />

          <div className="relative flex items-center justify-center">
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-border/60" />
            <button
              type="button"
              onClick={handleFlip}
              style={{ transform: `rotate(${rotated ? 180 : 0}deg)` }}
              className="relative z-10 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-elevated text-muted shadow-sm transition-[transform,color,background-color] duration-300 hover:border-accent/60 hover:bg-surface-hover hover:text-accent"
              aria-label="Flip swap direction"
            >
              <ArrowsDownUp size={17} weight="bold" />
            </button>
          </div>

          <TokenInputBox
            label="You receive (est.)"
            value={quoteDisplay}
            readonly
            token={tokenOut}
            balance={isConnected ? outBalanceLabel : undefined}
            onOpenPicker={() => setPickerFor("out")}
            footer={
              insufficientLiquidity
                ? <span className="text-red-400/95">Insufficient liquidity for this trade.</span>
                : quoteUsd ? <span className="text-muted">≈ {quoteUsd}</span> : undefined
            }
          />

          {/* Info row */}
          {quoteOut !== null && tokenOut !== null ? (
            <div className="mt-3 rounded-xl border border-border/60 bg-canvas/30 px-3 py-2 text-[0.72rem] text-muted space-y-1">
              <div className="flex justify-between">
                <span>Rate</span>
                <span className="font-mono text-fg">
                  {amountWei && amountWei > BigInt(0)
                    ? `1 ${tokenSymbol(tokenIn)} = ${withIntCommas(formatUnitsCompact((quoteOut * parseEther("1")) / amountWei))} ${tokenSymbol(tokenOut)}`
                    : "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Route</span>
                <span className="font-mono text-fg">
                  {isTokenToToken ? (
                    <>
                      {viaWeth ? "Via WETH" : "Direct"} · {tokenSymbol(tokenIn)} →{" "}
                      {viaWeth ? `WETH → ${tokenSymbol(tokenOut)}` : tokenSymbol(tokenOut)}
                    </>
                  ) : (
                    `${tokenSymbol(tokenIn)} → ${tokenSymbol(tokenOut)}`
                  )}
                </span>
              </div>
              {priceImpact !== null ? (
                <div className="flex justify-between">
                  <span>Price impact</span>
                  <span className={`font-mono font-medium ${impactColor}`}>
                    {priceImpact < 0.01 ? "< 0.01%" : `${priceImpact.toFixed(2)}%`}
                  </span>
                </div>
              ) : null}
              <div className="flex justify-between">
                <span>Min. received</span>
                <span className="font-mono text-fg">
                  {formatUnitsCompact(minOut(quoteOut, slippageBps))} {tokenSymbol(tokenOut)}
                </span>
              </div>
              {priceImpact !== null && priceImpact >= 15 ? (
                <p className="border-t border-border/40 pt-2 text-[0.68rem] leading-snug text-red-400/95">
                  Extremely high price impact ({priceImpact.toFixed(1)}%) — you may lose a large amount versus pool mid-price.
                </p>
              ) : priceImpact !== null && priceImpact >= 5 ? (
                <p className="border-t border-border/40 pt-2 text-[0.68rem] leading-snug text-amber-400/95">
                  High price impact ({priceImpact.toFixed(1)}%) — consider a smaller trade.
                </p>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p className="mt-3 rounded-xl border border-red-900/40 bg-red-950/25 px-3 py-2 text-[0.8rem] text-red-200">{error}</p>
          ) : null}
          {successMsg ? (
            <p className="mt-3 rounded-xl border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-[0.8rem] font-medium text-emerald-300">{successMsg}</p>
          ) : null}

          <button
            type="button"
            disabled={disabled}
            onClick={() => void onSwap()}
            className={`${compact ? "mt-3 py-3 text-[0.875rem]" : "mt-4 py-3.5 text-[0.9375rem]"} flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-accent to-accent-muted font-heading font-semibold text-fg shadow-sm transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {busy ? (
              <><span className="h-4 w-4 animate-spin rounded-full border-2 border-fg/30 border-t-fg" aria-hidden /><span>Confirm in wallet…</span></>
            ) : !isConnected ? "Connect wallet"
              : !tokenOut ? "Select a token"
              : exceedsBalance ? "Insufficient balance"
              : insufficientLiquidity ? "Insufficient liquidity"
              : !amountWei ? "Enter an amount"
              : "Swap"}
          </button>
        </div>
      ) : (
        <div className={compact ? "space-y-2" : "space-y-2.5"}>
          <div className="flex justify-end">
            <button type="button" onClick={reversePoolPair} className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[0.72rem] text-team transition-colors hover:border-accent/50 hover:text-fg">
              <ArrowsDownUp size={12} />
              Reverse pair
            </button>
          </div>
          <TokenInputBox
            label="Token A"
            value={poolAmountA}
            onChange={(v) => setPoolAmountForSide("a", v)}
            token={poolTokenA}
            balance={isConnected ? poolSideBalanceLabel("a") : undefined}
            onMax={() => fillPoolMax("a")}
            onOpenPicker={() => setPoolPickerFor("a")}
          />
          <TokenInputBox
            label="Token B"
            value={poolAmountB}
            onChange={(v) => setPoolAmountForSide("b", v)}
            token={poolTokenB}
            balance={isConnected ? poolSideBalanceLabel("b") : undefined}
            onMax={() => fillPoolMax("b")}
            onOpenPicker={() => setPoolPickerFor("b")}
          />
          {poolPairExists && poolReserves ? (
            <div className="rounded-xl border border-border/60 bg-canvas/30 px-3 py-2 text-[0.72rem] text-muted space-y-1">
              <p className="text-[0.68rem] font-semibold uppercase tracking-widest">Pool reserves</p>
              <div className="flex justify-between">
                <span>{poolReserves.symA}</span>
                <span className="font-mono text-fg">{withIntCommas(fmt(poolReserves.reserveA))}</span>
              </div>
              <div className="flex justify-between">
                <span>{poolReserves.symB}</span>
                <span className="font-mono text-fg">{withIntCommas(fmt(poolReserves.reserveB))}</span>
              </div>
            </div>
          ) : null}
          {poolInvalidPair ? (
            <p className="text-[0.72rem] text-amber-300">Choose two different tokens.</p>
          ) : null}
          {(poolExceedsA || poolExceedsB) ? (
            <p className="text-[0.72rem] text-red-300">Amount exceeds your available balance.</p>
          ) : null}
          {poolError ? (
            <p className="rounded-xl border border-red-900/40 bg-red-950/25 px-3 py-2 text-[0.8rem] text-red-200">{poolError}</p>
          ) : null}
          {poolSuccess ? (
            <p className="rounded-xl border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-[0.8rem] font-medium text-emerald-300">{poolSuccess}</p>
          ) : null}
          <button
            type="button"
            disabled={poolDisabled}
            onClick={() => void onAddLiquidity()}
            className={`${compact ? "mt-2 py-3 text-[0.875rem]" : "mt-3 py-3.5 text-[0.9375rem]"} flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-accent to-accent-muted font-heading font-semibold text-fg shadow-sm transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {poolBusy ? (
              <><span className="h-4 w-4 animate-spin rounded-full border-2 border-fg/30 border-t-fg" aria-hidden /><span>Confirm in wallet…</span></>
            ) : poolPairExists ? "Add Liquidity" : "Create Pair"}
          </button>
        </div>
      )}
    </>
  );
}
