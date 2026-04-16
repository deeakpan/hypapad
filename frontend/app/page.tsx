import type { Metadata } from "next";
import { MarketsTokenGrid } from "../components/home/markets-token-grid";
import { LaunchGradientBody } from "../components/launch/launch-gradient-body";

export const metadata: Metadata = {
  title: "Hypapad — Launch, Trade & Predict",
  description: "Launch Hypa tokens on a bonding curve, trade after graduation on Uniswap V2 pools, and stake on prediction markets — all from one terminal.",
  openGraph: {
    title: "Hypapad — Launch, Trade & Predict",
    description: "Launch Hypa tokens on a bonding curve, trade after graduation on Uniswap V2 pools, and stake on prediction markets — all from one terminal.",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Hypapad — Launch, Trade & Predict",
    description: "Launch Hypa tokens on a bonding curve, trade after graduation on Uniswap V2 pools, and stake on prediction markets — all from one terminal.",
  },
};

export default function Home() {
  return (
    <>
      <LaunchGradientBody />
      <main className="flex min-h-0 flex-1 flex-col bg-transparent px-5 py-10 sm:px-8">
      <div className="mx-auto w-full max-w-6xl">
        <h1 className="font-heading text-3xl font-bold tracking-tight text-fg sm:text-4xl">
          Tokens
        </h1>
        <MarketsTokenGrid />
      </div>
    </main>
    </>
  );
}
