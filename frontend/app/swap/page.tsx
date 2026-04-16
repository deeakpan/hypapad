import { SwapPanel } from "../../components/swap/swap-panel";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Swap",
  description: "Swap tokens on Hypapad. Trade graduated Hypa tokens against ETH or directly against each other using Uniswap V2 pools.",
  openGraph: {
    title: "Swap — Hypapad",
    description: "Swap tokens on Hypapad. Trade graduated Hypa tokens against ETH or directly against each other using Uniswap V2 pools.",
    url: "/swap",
  },
  twitter: {
    card: "summary",
    title: "Swap — Hypapad",
    description: "Swap tokens on Hypapad. Trade graduated Hypa tokens against ETH or directly against each other using Uniswap V2 pools.",
  },
};

export default function SwapPage() {
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center bg-transparent px-4 py-12 sm:py-16">
      <div className="w-full max-w-[480px]">
        <h1 className="mb-6 font-heading text-2xl font-bold tracking-tight text-fg sm:text-3xl">
          Swap
        </h1>
        <SwapPanel />
      </div>
    </main>
  );
}
