import { CreatorRevenuePanel } from "../../components/creator-revenue/creator-revenue-panel";

export const metadata = { title: "Creator Revenue — Hypapad" };

export default function CreatorRevenuePage() {
  return (
    <main className="min-h-screen bg-transparent pb-20">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-team sm:text-3xl">
          Creator Revenue
        </h1>
        <div className="mt-8">
          <CreatorRevenuePanel />
        </div>
      </div>
    </main>
  );
}

