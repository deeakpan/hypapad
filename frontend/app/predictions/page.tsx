import type { Metadata } from "next";
import { AllPredictionsPanel } from "../../components/predictions/all-predictions-panel";

export const metadata: Metadata = {
  title: "Predictions",
  description: "Browse and stake on prediction markets for Hypa tokens. Pick outcomes, earn rewards when you're right.",
  openGraph: {
    title: "Predictions — Hypapad",
    description: "Browse and stake on prediction markets for Hypa tokens. Pick outcomes, earn rewards when you're right.",
    url: "/predictions",
  },
  twitter: {
    card: "summary",
    title: "Predictions — Hypapad",
    description: "Browse and stake on prediction markets for Hypa tokens. Pick outcomes, earn rewards when you're right.",
  },
};

export default function PredictionsPage() {
  return (
    <main className="min-h-screen bg-transparent pb-20">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-team sm:text-3xl">
          Predictions
        </h1>
        <div className="mt-8">
          <AllPredictionsPanel />
        </div>
      </div>
    </main>
  );
}
