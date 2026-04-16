import type { Metadata } from "next";
import { UserStakesPanel } from "../../components/stakes/user-stakes-panel";

export const metadata: Metadata = {
  title: "Your Stakes",
  description: "View your prediction market positions on Hypapad. Claim winnings from resolved markets or refund cancelled ones.",
  openGraph: {
    title: "Your Stakes — Hypapad",
    description: "View your prediction market positions on Hypapad. Claim winnings from resolved markets or refund cancelled ones.",
    url: "/stakes",
  },
  twitter: {
    card: "summary",
    title: "Your Stakes — Hypapad",
    description: "View your prediction market positions on Hypapad. Claim winnings from resolved markets or refund cancelled ones.",
  },
};

export default function StakesPage() {
  return (
    <main className="min-h-screen bg-transparent pb-20">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-team sm:text-3xl">Your stakes</h1>
        <p className="mt-2 max-w-2xl text-[0.85rem] leading-relaxed text-muted">
          Markets where you have a position. Resolved winners can claim; cancelled markets can refund.
        </p>
        <div className="mt-8">
          <UserStakesPanel />
        </div>
      </div>
    </main>
  );
}
