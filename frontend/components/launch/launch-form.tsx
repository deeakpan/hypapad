"use client";

import { formatEther, parseEther } from "viem";
import { useEffect, useMemo, useRef, useState } from "react";
import { deployments } from "../../lib/deployments";
import {
  GRADUATION_ETH_TARGET_WEI_FALLBACK,
  LAUNCH_FEE_WEI_FALLBACK,
  PREDICTION_MARKET_ADDRESS,
  TOKEN_FACTORY_ADDRESS,
  tokenFactoryAbi,
} from "../../lib/token-factory";
import { useAccount, useReadContract, useWriteContract } from "wagmi";

const VESTING_MONTHS = [1, 2, 3, 4, 5, 6] as const;

const NAME_MAX_LEN = 120;

function formatEthReadable(wei: bigint, maxDecimals = 6): string {
  const s = formatEther(wei);
  const [i, f = ""] = s.split(".");
  if (!f) return i;
  const trimmed = f.replace(/0+$/, "");
  if (!trimmed) return i;
  return `${i}.${trimmed.slice(0, maxDecimals)}`;
}

/** Plain USD amount (no currency symbol) for monospace alignment with a separate `$`. */
function formatUsdAmount(n: number, minFrac = 3, maxFrac = 8): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: minFrac,
    maximumFractionDigits: maxFrac,
    useGrouping: false,
  });
}

function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={`inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-90 ${className ?? ""}`}
      aria-hidden
    />
  );
}

function popcountLow4(mask: number): number {
  let c = 0;
  const m = mask & 15;
  for (let i = 0; i < 4; i++) if (m & (1 << i)) c++;
  return c;
}

function multToX10(multStr: string): bigint {
  const n = Number(multStr);
  if (!Number.isFinite(n) || n < 2) throw new Error("Multiplier must be at least 2×.");
  return BigInt(Math.round(n * 10));
}

function inputFieldClass() {
  return "w-full rounded-xl border border-border bg-canvas px-3 py-2 text-[0.9375rem] text-fg outline-none focus:border-accent";
}

const TICKER_MAX_LEN = 6;

/** Uppercase A–Z / 0–9 only, max length; strips $ and other characters. */
function sanitizeTicker(raw: string): string {
  return raw
    .replace(/\$/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, TICKER_MAX_LEN);
}

export function LaunchForm() {
  const { address, isConnected } = useAccount();
  const { data: feeWei, isError: feeError } = useReadContract({
    address: TOKEN_FACTORY_ADDRESS,
    abi: tokenFactoryAbi,
    functionName: "launchFeeWei",
  });

  const { data: gradTargetWei, isError: gradTargetError } = useReadContract({
    address: TOKEN_FACTORY_ADDRESS,
    abi: tokenFactoryAbi,
    functionName: "graduationEthTarget",
  });

  const fee = useMemo(() => {
    if (feeWei !== undefined) return feeWei as bigint;
    return LAUNCH_FEE_WEI_FALLBACK;
  }, [feeWei]);

  const graduationEthWei = useMemo(() => {
    if (gradTargetWei !== undefined) return gradTargetWei as bigint;
    return GRADUATION_ETH_TARGET_WEI_FALLBACK;
  }, [gradTargetWei]);

  const [ethUsd, setEthUsd] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/eth-usd")
      .then((r) => r.json())
      .then((d: { usd?: number; error?: string }) => {
        if (!alive) return;
        if (typeof d.usd === "number" && Number.isFinite(d.usd)) setEthUsd(d.usd);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const graduationUsdApprox = useMemo(() => {
    if (ethUsd === null) return null;
    const eth = Number(formatEther(graduationEthWei));
    if (!Number.isFinite(eth)) return null;
    return eth * ethUsd;
  }, [ethUsd, graduationEthWei]);

  const { writeContractAsync, isPending: isTxPending } = useWriteContract();

  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [website, setWebsite] = useState("");

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [devAllocationPct, setDevAllocationPct] = useState(5);
  const [vestingMonths, setVestingMonths] = useState<(typeof VESTING_MONTHS)[number]>(6);

  const [launchMarketMask, setLaunchMarketMask] = useState(0);
  const [ethTargetEth, setEthTargetEth] = useState("1");
  const [ethTargetHours, setEthTargetHours] = useState("24");
  const [launchPriceMult, setLaunchPriceMult] = useState("2");
  const [launchPriceMultHours, setLaunchPriceMultHours] = useState("48");

  const [gradMarketMask, setGradMarketMask] = useState(0);
  const [gradMcapMult, setGradMcapMult] = useState("3");
  const [gradMcapMultDays, setGradMcapMultDays] = useState("7");
  const [gradPriceMult, setGradPriceMult] = useState("2");
  const [gradPriceMultDays, setGradPriceMultDays] = useState("7");
  const [gradMinLiqEth, setGradMinLiqEth] = useState("1");
  const [gradLiquidityDays, setGradLiquidityDays] = useState("30");

  const [showConfirm, setShowConfirm] = useState(false);
  const [slidePreview, setSlidePreview] = useState(false);
  const previewPanelRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyDetail, setBusyDetail] = useState<string | null>(null);

  useEffect(() => {
    if (!slidePreview) return;
    const el = previewPanelRef.current;
    if (!el) return;
    const run = () => {
      el.scrollTop = 0;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    run();
    const t = window.setTimeout(run, 520);
    return () => window.clearTimeout(t);
  }, [slidePreview]);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);

  useEffect(() => {
    if (!imageFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(imageFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  const tLabel = useMemo(() => {
    if (ticker.length > 0) return `$${ticker}`;
    return "$______";
  }, [ticker]);

  const launchPreviewLines = useMemo(() => {
    const lines: string[] = [];
    if (launchMarketMask & 1) {
      lines.push(`Will ${tLabel} graduate from the bonding curve to the pool within 24 hours?`);
    }
    if (launchMarketMask & 2) {
      lines.push(`Will ${tLabel} graduate from the bonding curve to the pool within 72 hours?`);
    }
    if (launchMarketMask & 4) {
      const eth = ethTargetEth.trim() || "…";
      const h = ethTargetHours.trim() || "…";
      lines.push(
        `Will ${tLabel} raise at least ${eth} ETH on its bonding curve within ${h} hours?`,
      );
    }
    if (launchMarketMask & 8) {
      const m = launchPriceMult.trim() || "…";
      const h = launchPriceMultHours.trim() || "…";
      lines.push(`Will ${tLabel} price on the curve reach at least ${m}× within ${h} hours?`);
    }
    return lines;
  }, [
    tLabel,
    launchMarketMask,
    ethTargetEth,
    ethTargetHours,
    launchPriceMult,
    launchPriceMultHours,
  ]);

  const gradPreviewLines = useMemo(() => {
    const lines: string[] = [];
    if (gradMarketMask & 1) {
      const m = gradMcapMult.trim() || "…";
      const d = gradMcapMultDays.trim() || "…";
      lines.push(
        `After migration, will ${tLabel} market cap reach at least ${m}× the graduation mcap within ${d} days?`,
      );
    }
    if (gradMarketMask & 2) {
      lines.push(
        `After migration, will ${tLabel} 7-day TWAP market cap stay inside the protocol target band?`,
      );
    }
    if (gradMarketMask & 4) {
      const m = gradPriceMult.trim() || "…";
      const d = gradPriceMultDays.trim() || "…";
      lines.push(
        `After migration, will ${tLabel} price reach at least ${m}× the graduation price within ${d} days?`,
      );
    }
    if (gradMarketMask & 8) {
      const x = gradMinLiqEth.trim() || "…";
      const d = gradLiquidityDays.trim() || "…";
      lines.push(
        `After migration, will ${tLabel} pool liquidity stay above ${x} ETH for at least ${d} days?`,
      );
    }
    return lines;
  }, [
    tLabel,
    gradMarketMask,
    gradMcapMult,
    gradMcapMultDays,
    gradPriceMult,
    gradPriceMultDays,
    gradMinLiqEth,
    gradLiquidityDays,
  ]);

  function setLaunchBit(bit: 0 | 1 | 2 | 3, on: boolean) {
    setError(null);
    const b = 1 << bit;
    if (on) {
      const next = launchMarketMask | b;
      if (popcountLow4(next) > 2) {
        setError("Pick at most 2 on-curve markets.");
        return;
      }
      setLaunchMarketMask(next);
    } else {
      setLaunchMarketMask(launchMarketMask & ~b);
    }
  }

  function setGradBit(bit: 0 | 1 | 2 | 3, on: boolean) {
    setError(null);
    const b = 1 << bit;
    if (on) {
      const next = gradMarketMask | b;
      if (popcountLow4(next) > 2) {
        setError("Pick at most 2 post-graduation markets.");
        return;
      }
      setGradMarketMask(next);
    } else {
      setGradMarketMask(gradMarketMask & ~b);
    }
  }

  function validate(): string | null {
    const nt = name.trim();
    if (!nt) return "Name is required.";
    if (nt.length > NAME_MAX_LEN) return `Name must be ${NAME_MAX_LEN} characters or fewer.`;
    if (!ticker.length) return "Ticker is required (1–6 letters or numbers).";
    if (!/^[A-Z0-9]{1,6}$/.test(ticker)) {
      return "Ticker must be letters and numbers only (A–Z, 0–9), max 6 characters.";
    }
    if (!imageFile) return "Choose a token image before launch.";
    if (launchMarketMask & 4) {
      try {
        const w = parseEther(ethTargetEth || "0");
        if (w <= BigInt(0)) return "ETH target must be greater than 0.";
      } catch {
        return "Invalid ETH target amount.";
      }
      const h = Number(ethTargetHours);
      if (!Number.isFinite(h) || h <= 0) return "ETH target hours must be greater than 0.";
    }
    if (launchMarketMask & 8) {
      try {
        const x10 = multToX10(launchPriceMult);
        if (x10 < BigInt(20)) return "On-curve price multiplier must be at least 2×.";
      } catch {
        return "Invalid on-curve price multiplier.";
      }
      const h = Number(launchPriceMultHours);
      if (!Number.isFinite(h) || h <= 0) return "Price multiplier hours must be greater than 0.";
    }
    if (gradMarketMask & 1) {
      try {
        const x10 = multToX10(gradMcapMult);
        if (x10 < BigInt(20)) return "Post-grad mcap multiplier must be at least 2×.";
      } catch {
        return "Invalid post-grad mcap multiplier.";
      }
      const d = Number(gradMcapMultDays);
      if (!Number.isFinite(d) || d <= 0) return "Post-grad mcap days must be greater than 0.";
    }
    if (gradMarketMask & 4) {
      try {
        const x10 = multToX10(gradPriceMult);
        if (x10 < BigInt(20)) return "Post-grad price multiplier must be at least 2×.";
      } catch {
        return "Invalid post-grad price multiplier.";
      }
      const d = Number(gradPriceMultDays);
      if (!Number.isFinite(d) || d <= 0) return "Post-grad price days must be greater than 0.";
    }
    if (gradMarketMask & 8) {
      try {
        const liq = parseEther(gradMinLiqEth || "0");
        if (liq <= BigInt(0)) return "Minimum liquidity must be greater than 0.";
      } catch {
        return "Invalid minimum liquidity (ETH).";
      }
      const d = Number(gradLiquidityDays);
      if (!Number.isFinite(d) || d <= 0) return "Liquidity window days must be greater than 0.";
    }
    return null;
  }

  function buildContractArgs() {
    const ethWei =
      launchMarketMask & 4 ? parseEther(ethTargetEth || "0") : BigInt(0);
    const ethHours =
      launchMarketMask & 4 ? BigInt(Math.max(0, Math.floor(Number(ethTargetHours)))) : BigInt(0);
    const launchPxX10 =
      launchMarketMask & 8 ? multToX10(launchPriceMult) : BigInt(0);
    const launchPxHours =
      launchMarketMask & 8
        ? BigInt(Math.max(0, Math.floor(Number(launchPriceMultHours))))
        : BigInt(0);

    const gradMcapX10 = gradMarketMask & 1 ? multToX10(gradMcapMult) : BigInt(0);
    const gradMcapDays =
      gradMarketMask & 1 ? BigInt(Math.max(0, Math.floor(Number(gradMcapMultDays)))) : BigInt(0);
    const gradPriceX10 = gradMarketMask & 4 ? multToX10(gradPriceMult) : BigInt(0);
    const gradPriceDays =
      gradMarketMask & 4 ? BigInt(Math.max(0, Math.floor(Number(gradPriceMultDays)))) : BigInt(0);
    const gradMinLiq =
      gradMarketMask & 8 ? parseEther(gradMinLiqEth || "0") : BigInt(0);
    const gradLiqDays =
      gradMarketMask & 8 ? BigInt(Math.max(0, Math.floor(Number(gradLiquidityDays)))) : BigInt(0);

    return {
      name: name.trim(),
      symbol: ticker,
      ipfsHash: "",
      devAllocationPct: BigInt(devAllocationPct),
      vestingMonths: BigInt(vestingMonths),
      launchMarketBitmask: launchMarketMask & 15,
      ethTarget: ethWei,
      ethTargetHours: ethHours,
      launchPriceMultX10: launchPxX10,
      launchPriceMultHours: launchPxHours,
      gradMarketBitmask: gradMarketMask & 15,
      gradMcapMultX10: gradMcapX10,
      gradMcapMultDays: gradMcapDays,
      gradPriceMultX10: gradPriceX10,
      gradPriceMultDays: gradPriceDays,
      gradMinLiquidity: gradMinLiq,
      gradLiquidityDays: gradLiqDays,
    };
  }

  function openConfirm() {
    if (txHash) {
      setError("This page already submitted a launch. Refresh the page if you need to launch another token.");
      return;
    }
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    setShowConfirm(true);
  }

  async function confirmLaunch() {
    if (txHash) return;
    setError(null);
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    if (!isConnected || !address) {
      setError("Connect your wallet first.");
      return;
    }
    if (!imageFile) {
      setError("Choose a token image.");
      return;
    }

    setBusy(true);
    try {
      setBusyDetail("Uploading image…");
      const fd = new FormData();
      fd.append("file", imageFile);
      const imgRes = await fetch("/api/lighthouse/image", { method: "POST", body: fd });
      const imgData = (await imgRes.json()) as { cid?: string; error?: string };
      if (!imgRes.ok || !imgData.cid) {
        throw new Error(imgData.error ?? "Image upload failed");
      }

      setBusyDetail("Publishing metadata…");
      const socials: Record<string, string> = {};
      if (twitter.trim()) socials.twitter = twitter.trim();
      if (telegram.trim()) socials.telegram = telegram.trim();
      if (website.trim()) socials.website = website.trim();

      const metaRes = await fetch("/api/lighthouse/metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          symbol: ticker,
          description: description.trim(),
          imageCid: imgData.cid,
          ...(Object.keys(socials).length ? { socials } : {}),
        }),
      });
      const metaData = (await metaRes.json()) as { cid?: string; error?: string };
      if (!metaRes.ok || !metaData.cid) {
        throw new Error(metaData.error ?? "Metadata upload failed");
      }

      setBusyDetail("Waiting for wallet signature…");
      const base = buildContractArgs();
      const hash = await writeContractAsync({
        address: TOKEN_FACTORY_ADDRESS,
        abi: tokenFactoryAbi,
        functionName: "launch",
        args: [
          {
            ...base,
            ipfsHash: metaData.cid.trim(),
          },
        ],
        value: fee,
      });
      setTxHash(hash);
      setShowConfirm(false);
      setSlidePreview(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Launch failed");
    } finally {
      setBusyDetail(null);
      setBusy(false);
    }
  }

  const launchAtMax = popcountLow4(launchMarketMask) >= 2;
  const gradAtMax = popcountLow4(gradMarketMask) >= 2;

  const card = "rounded-2xl border border-border bg-surface-elevated/90 p-6 shadow-sm backdrop-blur-sm";

  const graduationUsdPlain =
    graduationUsdApprox !== null ? formatUsdAmount(graduationUsdApprox) : null;

  const ethSpotUsdPlain =
    ethUsd !== null ? formatUsdAmount(ethUsd, 2, 6) : null;

  const launched = Boolean(txHash);
  const explorerTxUrl = txHash
    ? deployments.chainId === 84532
      ? `https://sepolia.basescan.org/tx/${txHash}`
      : deployments.chainId === 8453
        ? `https://basescan.org/tx/${txHash}`
        : deployments.chainId === 1
          ? `https://etherscan.io/tx/${txHash}`
          : null
    : null;

  return (
    <>
      {launched && txHash ? (
        <div className="mb-8 rounded-2xl border-2 border-emerald-600/60 bg-emerald-950/50 p-6 shadow-lg">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-lg text-emerald-300">
              ✓
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-heading text-xl font-semibold text-emerald-100">Launch submitted</h2>
              <p className="mt-2 text-[0.9375rem] leading-relaxed text-team">
                Your token is on the way. <strong className="text-fg">Do not run launch again</strong> from
                this page — you already sent the transaction below. To launch another token,{" "}
                <strong className="text-fg">refresh the page</strong> first.
              </p>
              <p className="mt-3 break-all font-mono text-[0.8125rem] text-accent">{txHash}</p>
              {explorerTxUrl ? (
                <a
                  href={explorerTxUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-block text-[0.875rem] font-semibold text-emerald-300 underline decoration-emerald-500/50 underline-offset-2 hover:text-emerald-200"
                >
                  View on block explorer →
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="relative w-full overflow-x-hidden">
        <div
          className={`flex w-[200%] will-change-transform transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            slidePreview ? "-translate-x-[50%]" : "translate-x-0"
          }`}
        >
          <div className="w-1/2 shrink-0 space-y-8 pr-2 sm:pr-4">
      {feeError ? (
        <p className="rounded-xl border border-border bg-surface px-3 py-2 text-[0.8125rem] text-muted">
          Could not read launch fee from chain; using fallback {formatEther(LAUNCH_FEE_WEI_FALLBACK)}{" "}
          ETH.
        </p>
      ) : null}

      <div className={`${card}`}>
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(260px,320px)] lg:items-start">
          <div className="space-y-8">
            <section className="space-y-4">
              <h2 className="font-heading text-lg font-semibold text-fg">Token details</h2>
              <div>
                <label className="mb-1 block text-[0.75rem] font-medium text-muted">Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, NAME_MAX_LEN))}
                  maxLength={NAME_MAX_LEN}
                  className={inputFieldClass()}
                  placeholder="My token"
                />
              </div>
              <div>
                <label className="mb-1 block text-[0.75rem] font-medium text-muted">Ticker</label>
                <div className="flex rounded-xl border border-border bg-canvas focus-within:border-accent">
                  <span className="flex shrink-0 items-center pl-3 text-[0.9375rem] text-muted">$</span>
                  <input
                    value={ticker}
                    onChange={(e) => {
                      setTicker(sanitizeTicker(e.target.value));
                      setError(null);
                    }}
                    maxLength={TICKER_MAX_LEN}
                    inputMode="text"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    className="min-w-0 flex-1 border-0 bg-transparent py-2 pr-3 font-mono text-[0.9375rem] uppercase tracking-wide text-fg outline-none"
                    placeholder="HYPA"
                  />
                </div>
                <p className="mt-1 text-[0.75rem] text-muted">
                  Max {TICKER_MAX_LEN} characters · letters and numbers only · always uppercase
                </p>
              </div>
              <div>
                <label className="mb-1 block text-[0.75rem] font-medium text-muted">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={4}
                  className={`${inputFieldClass()} resize-y`}
                  placeholder="What is this token?"
                />
              </div>
            </section>

            <section className="space-y-4">
              <h2 className="font-heading text-lg font-semibold text-fg">Socials (metadata)</h2>
              <p className="text-[0.8125rem] text-muted">
                Optional links are written into the IPFS JSON when you confirm launch.
              </p>
              <div>
                <label className="mb-1 block text-[0.75rem] font-medium text-muted">X / Twitter</label>
                <input
                  value={twitter}
                  onChange={(e) => setTwitter(e.target.value)}
                  className={inputFieldClass()}
                  placeholder="https://x.com/…"
                />
              </div>
              <div>
                <label className="mb-1 block text-[0.75rem] font-medium text-muted">Telegram</label>
                <input
                  value={telegram}
                  onChange={(e) => setTelegram(e.target.value)}
                  className={inputFieldClass()}
                  placeholder="https://t.me/…"
                />
              </div>
              <div>
                <label className="mb-1 block text-[0.75rem] font-medium text-muted">Website</label>
                <input
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  className={inputFieldClass()}
                  placeholder="https://…"
                />
              </div>
            </section>
          </div>

          <aside className="space-y-4 lg:sticky lg:top-24">
            <h2 className="font-heading text-lg font-semibold text-fg">Image</h2>
            <p className="text-[0.8125rem] text-muted">
              Upload is sent to IPFS only after you confirm launch in the next step.
            </p>
            <input
              type="file"
              accept="image/*"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                setImageFile(f ?? null);
                setError(null);
              }}
              className="w-full text-[0.8125rem] text-team file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-[0.8125rem] file:font-semibold file:text-fg"
            />
            <div className="overflow-hidden rounded-2xl border border-border bg-canvas">
              <div className="aspect-square w-full bg-black/40">
                {previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center p-6 text-center text-[0.8125rem] text-muted">
                    Preview after you choose a file
                  </div>
                )}
              </div>
              <div className="space-y-1 border-t border-border p-4">
                <p className="font-heading text-[0.9375rem] font-semibold text-fg">
                  {name.trim() || "Token name"}
                </p>
                <p className="text-[0.8125rem] text-accent">{ticker ? `$${ticker}` : "$______"}</p>
                <p className="line-clamp-3 text-[0.8125rem] leading-snug text-team">
                  {description.trim() || "Description preview"}
                </p>
              </div>
            </div>
          </aside>
        </div>
      </div>

      <div className={`${card} space-y-5`}>
        <h2 className="font-heading text-lg font-semibold text-fg">Tokenomics</h2>
        <div>
          <div className="mb-2 flex items-center justify-between text-[0.8125rem]">
            <span className="font-medium text-muted">Creator allocation</span>
            <span className="text-fg">{devAllocationPct}%</span>
          </div>
          <div className="max-w-[11rem]">
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              value={devAllocationPct}
              onChange={(e) => setDevAllocationPct(Number(e.target.value))}
              className="h-1.5 w-full cursor-pointer accent-emerald-500"
            />
          </div>
          <p className="mt-1 text-[0.75rem] text-muted">1%–5% (HypaToken curve)</p>
        </div>
        <div>
          <p className="mb-2 text-[0.8125rem] font-medium text-muted">Vesting</p>
          <div className="flex flex-wrap gap-2">
            {VESTING_MONTHS.map((m) => (
              <button
                key={m}
                type="button"
                disabled={busy}
                onClick={() => setVestingMonths(m)}
                className={`rounded-full px-4 py-2 text-[0.8125rem] font-semibold transition-colors ${
                  vestingMonths === m
                    ? "bg-accent text-fg"
                    : "border border-border bg-canvas text-team hover:border-accent/50"
                }`}
              >
                {m} {m === 1 ? "month" : "months"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={`${card} space-y-5`}>
        <div>
          <h2 className="font-heading text-lg font-semibold text-fg">Bonding-curve markets</h2>
          <p className="mt-1 max-w-3xl text-[0.875rem] leading-relaxed text-muted">
            Optional yes/no markets during the bonding-curve phase. Pick up to two; wording below uses
            your ticker from above.
          </p>
        </div>

        <div className="space-y-3">
          <div className="overflow-hidden rounded-xl border border-border/80 bg-black/25">
            <div className="flex gap-3 p-4">
              <input
                id="lm-24"
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-emerald-500"
                checked={(launchMarketMask & 1) !== 0}
                disabled={busy || (!(launchMarketMask & 1) && launchAtMax)}
                onChange={(e) => setLaunchBit(0, e.target.checked)}
              />
              <div className="min-w-0 flex-1">
                <label htmlFor="lm-24" className="cursor-pointer font-medium text-fg">
                  24-hour graduation
                </label>
                <p className="mt-1 text-[0.8125rem] leading-snug text-muted">
                  {`“Will ${tLabel} graduate to the pool within a day of launch?”`}
                </p>
              </div>
            </div>
            {(launchMarketMask & 1) !== 0 ? (
              <div className="border-t border-border/50 bg-emerald-950/20 px-4 py-3">
                <p className="text-[0.8125rem] leading-relaxed text-emerald-100/95">
                  <span className="font-semibold text-emerald-300">Preview · </span>
                  {launchPreviewLines.find((l) => l.includes("24 hours")) ??
                    `Will ${tLabel} graduate from the bonding curve to the pool within 24 hours?`}
                </p>
              </div>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-xl border border-border/80 bg-black/25">
            <div className="flex gap-3 p-4">
              <input
                id="lm-72"
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-emerald-500"
                checked={(launchMarketMask & 2) !== 0}
                disabled={busy || (!(launchMarketMask & 2) && launchAtMax)}
                onChange={(e) => setLaunchBit(1, e.target.checked)}
              />
              <div className="min-w-0 flex-1">
                <label htmlFor="lm-72" className="cursor-pointer font-medium text-fg">
                  72-hour graduation
                </label>
                <p className="mt-1 text-[0.8125rem] leading-snug text-muted">
                  Same idea, but you give the curve three days to graduate.
                </p>
              </div>
            </div>
            {(launchMarketMask & 2) !== 0 ? (
              <div className="border-t border-border/50 bg-emerald-950/20 px-4 py-3">
                <p className="text-[0.8125rem] leading-relaxed text-emerald-100/95">
                  <span className="font-semibold text-emerald-300">Preview · </span>
                  {launchPreviewLines.find((l) => l.includes("72 hours")) ??
                    `Will ${tLabel} graduate from the bonding curve to the pool within 72 hours?`}
                </p>
              </div>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-xl border border-border/80 bg-black/25">
            <div className="flex gap-3 p-4">
              <input
                id="lm-eth"
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-emerald-500"
                checked={(launchMarketMask & 4) !== 0}
                disabled={busy || (!(launchMarketMask & 4) && launchAtMax)}
                onChange={(e) => setLaunchBit(2, e.target.checked)}
              />
              <div className="min-w-0 flex-1">
                <label htmlFor="lm-eth" className="cursor-pointer font-medium text-fg">
                  ETH raised on a deadline
                </label>
                <p className="mt-1 text-[0.8125rem] leading-snug text-muted">
                  Turn on first, then set how much ETH should hit the curve and in how many hours.
                </p>
              </div>
            </div>
            {(launchMarketMask & 4) !== 0 ? (
              <>
                <div className="border-t border-border/50 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[0.875rem] text-fg">
                    <span className="text-muted">Raise at least</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={ethTargetEth}
                      onChange={(e) => setEthTargetEth(e.target.value)}
                      disabled={busy}
                      className="w-24 rounded-lg border border-border bg-canvas px-2 py-1.5 text-center text-[0.875rem] outline-none focus:border-accent"
                    />
                    <span className="text-muted">ETH within</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={ethTargetHours}
                      onChange={(e) => setEthTargetHours(e.target.value)}
                      disabled={busy}
                      className="w-20 rounded-lg border border-border bg-canvas px-2 py-1.5 text-center text-[0.875rem] outline-none focus:border-accent"
                    />
                    <span className="text-muted">hours</span>
                  </div>
                </div>
                <div className="border-t border-border/50 bg-emerald-950/20 px-4 py-3">
                  <p className="text-[0.8125rem] leading-relaxed text-emerald-100/95">
                    <span className="font-semibold text-emerald-300">Preview · </span>
                    {launchPreviewLines.find((l) => l.includes("raise at least")) ??
                      `Will ${tLabel} raise enough ETH on its bonding curve in time?`}
                  </p>
                </div>
              </>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-xl border border-border/80 bg-black/25">
            <div className="flex gap-3 p-4">
              <input
                id="lm-px"
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-emerald-500"
                checked={(launchMarketMask & 8) !== 0}
                disabled={busy || (!(launchMarketMask & 8) && launchAtMax)}
                onChange={(e) => setLaunchBit(3, e.target.checked)}
              />
              <div className="min-w-0 flex-1">
                <label htmlFor="lm-px" className="cursor-pointer font-medium text-fg">
                  Price multiple on a deadline
                </label>
                <p className="mt-1 text-[0.8125rem] leading-snug text-muted">
                  Minimum 2×. Set the multiple and the number of hours from launch.
                </p>
              </div>
            </div>
            {(launchMarketMask & 8) !== 0 ? (
              <>
                <div className="border-t border-border/50 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[0.875rem] text-fg">
                    <span className="text-muted">Reach at least</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={launchPriceMult}
                      onChange={(e) => setLaunchPriceMult(e.target.value)}
                      disabled={busy}
                      className="w-20 rounded-lg border border-border bg-canvas px-2 py-1.5 text-center text-[0.875rem] outline-none focus:border-accent"
                    />
                    <span className="text-muted">× in</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={launchPriceMultHours}
                      onChange={(e) => setLaunchPriceMultHours(e.target.value)}
                      disabled={busy}
                      className="w-20 rounded-lg border border-border bg-canvas px-2 py-1.5 text-center text-[0.875rem] outline-none focus:border-accent"
                    />
                    <span className="text-muted">hours</span>
                  </div>
                </div>
                <div className="border-t border-border/50 bg-emerald-950/20 px-4 py-3">
                  <p className="text-[0.8125rem] leading-relaxed text-emerald-100/95">
                    <span className="font-semibold text-emerald-300">Preview · </span>
                    {launchPreviewLines.find((l) => l.includes("reach at least")) ??
                      `Will ${tLabel} curve price hit your multiple in time?`}
                  </p>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className={`${card} space-y-5`}>
        <div>
          <h2 className="font-heading text-lg font-semibold text-fg">After the pool is live</h2>
          <p className="mt-1 max-w-3xl text-[0.875rem] leading-relaxed text-muted">
            Optional markets after migration to the pool. Pick up to two; they open at graduation with
            the numbers you set here. Copy uses your ticker.
          </p>
        </div>

        <div className="space-y-3">
          <div className="overflow-hidden rounded-xl border border-border/80 bg-black/25">
            <div className="flex gap-3 p-4">
              <input
                id="gm-mcap"
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-emerald-500"
                checked={(gradMarketMask & 1) !== 0}
                disabled={busy || (!(gradMarketMask & 1) && gradAtMax)}
                onChange={(e) => setGradBit(0, e.target.checked)}
              />
              <div className="min-w-0 flex-1">
                <label htmlFor="gm-mcap" className="cursor-pointer font-medium text-fg">
                  Market cap multiple
                </label>
                <p className="mt-1 text-[0.8125rem] leading-snug text-muted">
                  e.g. 3× graduation mcap within a number of days (minimum 2× on-chain).
                </p>
              </div>
            </div>
            {(gradMarketMask & 1) !== 0 ? (
              <>
                <div className="border-t border-border/50 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[0.875rem] text-fg">
                    <span className="text-muted">At least</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={gradMcapMult}
                      onChange={(e) => setGradMcapMult(e.target.value)}
                      disabled={busy}
                      className="w-20 rounded-lg border border-border bg-canvas px-2 py-1.5 text-center text-[0.875rem] outline-none focus:border-accent"
                    />
                    <span className="text-muted">× mcap within</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={gradMcapMultDays}
                      onChange={(e) => setGradMcapMultDays(e.target.value)}
                      disabled={busy}
                      className="w-20 rounded-lg border border-border bg-canvas px-2 py-1.5 text-center text-[0.875rem] outline-none focus:border-accent"
                    />
                    <span className="text-muted">days</span>
                  </div>
                </div>
                <div className="border-t border-border/50 bg-emerald-950/20 px-4 py-3">
                  <p className="text-[0.8125rem] leading-relaxed text-emerald-100/95">
                    <span className="font-semibold text-emerald-300">Preview · </span>
                    {gradPreviewLines.find((l) => l.includes("market cap")) ??
                      `After migration, will ${tLabel} mcap hit your target in time?`}
                  </p>
                </div>
              </>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-xl border border-border/80 bg-black/25">
            <div className="flex gap-3 p-4">
              <input
                id="gm-range"
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-emerald-500"
                checked={(gradMarketMask & 2) !== 0}
                disabled={busy || (!(gradMarketMask & 2) && gradAtMax)}
                onChange={(e) => setGradBit(1, e.target.checked)}
              />
              <div className="min-w-0 flex-1">
                <label htmlFor="gm-range" className="cursor-pointer font-medium text-fg">
                  Market-cap range (first week)
                </label>
                <p className="mt-1 text-[0.8125rem] leading-snug text-muted">
                  Uses a fixed 7-day window in the protocol — no extra fields.
                </p>
              </div>
            </div>
            {(gradMarketMask & 2) !== 0 ? (
              <div className="border-t border-border/50 bg-emerald-950/20 px-4 py-3">
                <p className="text-[0.8125rem] leading-relaxed text-emerald-100/95">
                  <span className="font-semibold text-emerald-300">Preview · </span>
                  {gradPreviewLines.find((l) => l.includes("TWAP")) ??
                    `After migration, will ${tLabel} 7-day TWAP market cap stay inside the protocol target band?`}
                </p>
              </div>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-xl border border-border/80 bg-black/25">
            <div className="flex gap-3 p-4">
              <input
                id="gm-px"
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-emerald-500"
                checked={(gradMarketMask & 4) !== 0}
                disabled={busy || (!(gradMarketMask & 4) && gradAtMax)}
                onChange={(e) => setGradBit(2, e.target.checked)}
              />
              <div className="min-w-0 flex-1">
                <label htmlFor="gm-px" className="cursor-pointer font-medium text-fg">
                  Price multiple after migration
                </label>
                <p className="mt-1 text-[0.8125rem] leading-snug text-muted">
                  Minimum 2× vs the graduation price, over the days you choose.
                </p>
              </div>
            </div>
            {(gradMarketMask & 4) !== 0 ? (
              <>
                <div className="border-t border-border/50 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[0.875rem] text-fg">
                    <span className="text-muted">At least</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={gradPriceMult}
                      onChange={(e) => setGradPriceMult(e.target.value)}
                      disabled={busy}
                      className="w-20 rounded-lg border border-border bg-canvas px-2 py-1.5 text-center text-[0.875rem] outline-none focus:border-accent"
                    />
                    <span className="text-muted">× price within</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={gradPriceMultDays}
                      onChange={(e) => setGradPriceMultDays(e.target.value)}
                      disabled={busy}
                      className="w-20 rounded-lg border border-border bg-canvas px-2 py-1.5 text-center text-[0.875rem] outline-none focus:border-accent"
                    />
                    <span className="text-muted">days</span>
                  </div>
                </div>
                <div className="border-t border-border/50 bg-emerald-950/20 px-4 py-3">
                  <p className="text-[0.8125rem] leading-relaxed text-emerald-100/95">
                    <span className="font-semibold text-emerald-300">Preview · </span>
                    {gradPreviewLines.find((l) => l.includes("graduation price")) ??
                      `After migration, will ${tLabel} price hit your multiple in time?`}
                  </p>
                </div>
              </>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-xl border border-border/80 bg-black/25">
            <div className="flex gap-3 p-4">
              <input
                id="gm-liq"
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-emerald-500"
                checked={(gradMarketMask & 8) !== 0}
                disabled={busy || (!(gradMarketMask & 8) && gradAtMax)}
                onChange={(e) => setGradBit(3, e.target.checked)}
              />
              <div className="min-w-0 flex-1">
                <label htmlFor="gm-liq" className="cursor-pointer font-medium text-fg">
                  Pool liquidity floor
                </label>
                <p className="mt-1 text-[0.8125rem] leading-snug text-muted">
                  {`“Will ${tLabel} pool liquidity stay at least this high in ETH for this many days?”`}
                </p>
              </div>
            </div>
            {(gradMarketMask & 8) !== 0 ? (
              <>
                <div className="border-t border-border/50 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[0.875rem] text-fg">
                    <span className="text-muted">At least</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={gradMinLiqEth}
                      onChange={(e) => setGradMinLiqEth(e.target.value)}
                      disabled={busy}
                      className="w-24 rounded-lg border border-border bg-canvas px-2 py-1.5 text-center text-[0.875rem] outline-none focus:border-accent"
                    />
                    <span className="text-muted">ETH for</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={gradLiquidityDays}
                      onChange={(e) => setGradLiquidityDays(e.target.value)}
                      disabled={busy}
                      className="w-20 rounded-lg border border-border bg-canvas px-2 py-1.5 text-center text-[0.875rem] outline-none focus:border-accent"
                    />
                    <span className="text-muted">days</span>
                  </div>
                </div>
                <div className="border-t border-border/50 bg-emerald-950/20 px-4 py-3">
                  <p className="text-[0.8125rem] leading-relaxed text-emerald-100/95">
                    <span className="font-semibold text-emerald-300">Preview · </span>
                    {gradPreviewLines.find((l) => l.includes("liquidity")) ??
                      `After migration, will ${tLabel} liquidity stay above your floor?`}
                  </p>
                </div>
              </>
            ) : null}
          </div>
        </div>

        {launchPreviewLines.length + gradPreviewLines.length > 0 ? (
          <div className="rounded-xl border border-emerald-900/40 bg-emerald-950/10 p-4">
            <p className="text-[0.75rem] font-semibold uppercase tracking-wide text-emerald-400/90">
              All questions together
            </p>
            <ul className="mt-2 list-inside list-disc space-y-1.5 text-[0.8125rem] leading-relaxed text-emerald-50/90">
              {[...launchPreviewLines, ...gradPreviewLines].map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-[0.8125rem] text-muted">
            No optional markets selected — you can still launch; traders only get the bonding curve
            until you add markets later from the protocol UI if supported.
          </p>
        )}
      </div>

      <div className={`${card} space-y-3 border-white/[0.06] bg-black/25`}>
        <h3 className="font-heading text-[0.9375rem] font-semibold text-fg">Bonding curve economics</h3>
        <ul className="space-y-3 text-[0.8125rem] leading-relaxed text-team">
          <li>
            <span className="font-medium text-fg">Every buy and sell on the curve</span> pays a{" "}
            <span className="text-fg">1%</span> fee: <span className="text-fg">0.2%</span> accrues to
            you as the launch creator (claim anytime from the curve), and{" "}
            <span className="text-fg">0.8%</span> goes to the protocol treasury.
          </li>
          <li>
            <span className="font-medium text-fg">When the curve graduates</span>,{" "}
            <span className="text-fg">2%</span> of the ETH reserve at that moment goes to the treasury, and{" "}
            <span className="text-fg">98%</span> is used with tokens to seed the Uniswap pool (graduation
            liquidity).
          </li>
        </ul>
      </div>

      <div className={`${card} space-y-4`}>
        <p className="text-[0.8125rem] text-muted">
          One-time launch fee: <strong className="text-fg">{formatEthReadable(fee)} ETH</strong> (must match
          what the factory expects).
        </p>
        <button
          type="button"
          disabled={busy || launched}
          onClick={() => {
            setError(null);
            setSlidePreview(true);
          }}
          className="w-full rounded-full border border-border bg-canvas py-3 text-[0.9375rem] font-semibold text-fg transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto sm:px-10"
        >
          Preview your launch
        </button>
        {feeError ? (
          <p className="text-[0.75rem] text-amber-200/90">
            Could not read fee from chain — using <code className="text-team">deployments.json</code> fallback.
          </p>
        ) : null}
      </div>
          </div>

          <div
            ref={previewPanelRef}
            className="w-1/2 shrink-0 space-y-6 border-l border-border/50 bg-black/40 px-4 py-6 sm:px-6 lg:min-h-[min(100vh,920px)] lg:overflow-y-auto"
          >
            <button
              type="button"
              onClick={() => {
                setSlidePreview(false);
                setError(null);
              }}
              className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-canvas/80 px-4 py-2 text-[0.8125rem] font-semibold text-team transition-colors hover:border-accent hover:text-fg"
            >
              ← Back to edit
            </button>

            <div>
              <h2 className="font-heading text-2xl font-semibold text-fg">Launch preview</h2>
              <p className="mt-1 text-[0.875rem] text-muted">
                {deployments.network} · chain {deployments.chainId}
              </p>
            </div>

            <div className="flex flex-wrap items-start gap-4">
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt=""
                  className="h-20 w-20 shrink-0 rounded-xl border border-border object-cover"
                />
              ) : (
                <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-dashed border-border text-[0.65rem] text-muted">
                  No image
                </div>
              )}
              <div className="min-w-0 flex-1 space-y-1 text-[0.875rem]">
                <p className="font-heading text-lg font-semibold text-fg">{name.trim() || "Untitled"}</p>
                <p className="font-mono text-accent">{ticker ? `$${ticker}` : "—"}</p>
                <p className="line-clamp-4 text-team">{description.trim() || "No description yet."}</p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-border/60 bg-canvas/40 p-4 text-[0.8125rem]">
                <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted">Your split</p>
                <p className="mt-2 text-team">
                  <span className="text-fg">{devAllocationPct}%</span> to you as creator · vesting{" "}
                  <span className="text-fg">{vestingMonths}</span> mo
                </p>
              </div>
              <div className="rounded-xl border border-border/60 bg-canvas/40 p-4 text-[0.8125rem]">
                <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted">Launch fee</p>
                <p className="mt-2 font-mono text-fg">{formatEthReadable(fee)} ETH</p>
              </div>
            </div>

            <section className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 p-5">
              <h3 className="font-heading text-lg font-semibold text-fg">When does it move to Uniswap?</h3>
              <p className="mt-2 text-[0.9375rem] leading-relaxed text-team">
                The bonding curve keeps going until{" "}
                <strong className="text-fg">{formatEthReadable(graduationEthWei)} ETH</strong> has been
                raised from buys (after the 1% trading fee on each trade). Then Hypapad automatically
                migrates: most of the ETH goes into the pool with your token, and the options you picked
                (vesting, post-grad markets) kick in.
              </p>
              {gradTargetError ? (
                <p className="mt-2 text-[0.8125rem] text-amber-200/95">
                  We couldn&apos;t read the live number from the network, so the ETH figure below comes from
                  your local <code className="text-team">deployments.json</code> copy.
                </p>
              ) : null}
              <div className="mt-4 grid gap-4 sm:grid-cols-2 sm:items-stretch">
                <div className="flex flex-col justify-start rounded-lg bg-black/35 px-4 py-3 text-left">
                  <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted">Raise target</p>
                  <p className="mt-1 font-heading text-2xl font-semibold tabular-nums leading-none text-fg">
                    {formatEthReadable(graduationEthWei)} ETH
                  </p>
                </div>
                <div className="flex flex-col justify-start rounded-lg bg-black/35 px-4 py-3 text-left">
                  <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted">USD</p>
                  {graduationUsdPlain ? (
                    <>
                      <p className="mt-1 flex items-baseline gap-0.5 font-mono text-[1.375rem] font-semibold leading-none tracking-normal text-emerald-200">
                        <span className="select-none text-emerald-400/90">$</span>
                        <span className="tabular-nums">{graduationUsdPlain}</span>
                      </p>
                      <p className="mt-3 text-[0.75rem] leading-snug text-muted">
                        1 ETH ≈{" "}
                        <span className="font-mono tabular-nums text-fg/90">
                          {ethSpotUsdPlain ? (
                            <>
                              $<span>{ethSpotUsdPlain}</span>
                            </>
                          ) : (
                            "…"
                          )}
                        </span>{" "}
                        <a
                          href="https://www.coingecko.com/en/coins/ethereum"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-emerald-300 underline underline-offset-2 hover:text-emerald-200"
                        >
                          CoinGecko
                        </a>
                        . Estimate only.
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-[0.8125rem] text-muted">Loading price…</p>
                  )}
                </div>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-[0.75rem] font-semibold uppercase tracking-wide text-muted">Optional markets</h3>
              {launchPreviewLines.length + gradPreviewLines.length > 0 ? (
                <ul className="list-inside list-disc space-y-1.5 text-[0.8125rem] leading-relaxed text-team">
                  {[...launchPreviewLines, ...gradPreviewLines].map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-[0.8125rem] text-muted">You didn&apos;t turn on any extra markets.</p>
              )}
            </section>

            <section className="space-y-2 border-t border-border/40 pt-4 text-[0.75rem] text-muted">
              <p>
                <span className="font-medium text-fg/90">Factory · </span>
                <code className="break-all text-team">{TOKEN_FACTORY_ADDRESS}</code>
              </p>
              <p>
                <span className="font-medium text-fg/90">Markets contract · </span>
                <code className="break-all text-team">{PREDICTION_MARKET_ADDRESS}</code>
              </p>
            </section>

            <div className="flex flex-col gap-3 border-t border-border/40 pt-6 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                disabled={!isConnected || busy || isTxPending || launched}
                onClick={() => void openConfirm()}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-accent to-accent-muted px-8 py-3 text-[0.9375rem] font-semibold text-fg shadow-sm transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy || isTxPending ? <Spinner /> : null}
                Continue to wallet
              </button>
              <button
                type="button"
                onClick={() => setSlidePreview(false)}
                className="rounded-full border border-border px-8 py-3 text-[0.9375rem] font-semibold text-team hover:bg-canvas"
              >
                Back to edit
              </button>
            </div>
          </div>
        </div>
      </div>

      {error ? (
        <p className="rounded-xl border border-red-900/50 bg-red-950/30 px-3 py-2 text-[0.8125rem] text-red-200">
          {error}
        </p>
      ) : null}

      {showConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface-elevated p-6 shadow-xl"
          >
            <h3 className="font-heading text-xl font-semibold text-fg">Confirm launch</h3>
            <p className="mt-2 text-[0.875rem] text-muted">
              Your image and metadata will be pinned, then the launch transaction submitted. Fee:{" "}
              {formatEther(fee)} ETH.
            </p>
            <ul className="mt-4 space-y-2 text-[0.8125rem] text-team">
              <li>
                <span className="font-medium text-fg">Token · </span>
                {name.trim()} ({ticker ? `$${ticker}` : "$______"})
              </li>
              <li>
                <span className="font-medium text-fg">Curve · </span>
                Creator {devAllocationPct}% · Vesting {vestingMonths} mo
              </li>
              <li>
                <span className="font-medium text-fg">Graduation · </span>
                After {formatEthReadable(graduationEthWei)} ETH has been raised on the curve
                {graduationUsdPlain
                  ? ` (about $${graduationUsdPlain} at today's ETH price)`
                  : ""}
                .
              </li>
              {launchPreviewLines.length + gradPreviewLines.length > 0 ? (
                <li className="!mt-3 space-y-1.5">
                  <span className="font-medium text-fg">Markets · </span>
                  <ul className="list-inside list-disc space-y-1 pl-0 text-[0.8125rem] text-team">
                    {[...launchPreviewLines, ...gradPreviewLines].map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </li>
              ) : (
                <li>
                  <span className="font-medium text-fg">Markets · </span>
                  None (bonding curve only until graduation)
                </li>
              )}
            </ul>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => setShowConfirm(false)}
                className="rounded-full border border-border px-5 py-2.5 text-[0.8125rem] font-semibold text-fg hover:bg-canvas"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || isTxPending || launched}
                onClick={() => void confirmLaunch()}
                className="inline-flex min-w-[11rem] items-center justify-center gap-2 rounded-full bg-gradient-to-r from-accent to-accent-muted px-5 py-2.5 text-[0.8125rem] font-semibold text-fg shadow-sm hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy || isTxPending ? <Spinner /> : null}
                {busy || isTxPending
                  ? busyDetail ?? (isTxPending ? "Confirm in wallet…" : "Working…")
                  : "Confirm & launch"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
