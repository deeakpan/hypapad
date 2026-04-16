import type { Metadata } from "next";
import { LaunchForm } from "../../components/launch/launch-form";

export const metadata: Metadata = {
  title: "Launch Token",
  description: "Launch your own token on Hypapad. Deploy on a bonding curve, graduate to a Uniswap V2 pool, and let the market decide.",
  openGraph: {
    title: "Launch Token — Hypapad",
    description: "Launch your own token on Hypapad. Deploy on a bonding curve, graduate to a Uniswap V2 pool, and let the market decide.",
    url: "/launch",
  },
  twitter: {
    card: "summary",
    title: "Launch Token — Hypapad",
    description: "Launch your own token on Hypapad. Deploy on a bonding curve, graduate to a Uniswap V2 pool, and let the market decide.",
  },
};

export default function LaunchPage() {
  return (
    <main className="min-h-screen bg-transparent pb-20">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-team sm:text-3xl">
          Launch token
        </h1>
        <div className="mt-10">
          <LaunchForm />
        </div>
      </div>
    </main>
  );
}
