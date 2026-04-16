"use client";

import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import type { AppKitNetwork } from "@reown/appkit/networks";
import { base, baseSepolia } from "@reown/appkit/networks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cookieToInitialState,
  WagmiProvider,
  createStorage,
  cookieStorage,
  type Config,
} from "wagmi";

import { AppKitModalCompactHeights } from "./appkit-modal-compact";

/** Reown Cloud project id — override with NEXT_PUBLIC_PROJECT_ID in production. */
const projectId =
  process.env.NEXT_PUBLIC_PROJECT_ID ??
  "b56e18d47c72ab683b10814fe9495694";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const networks = [baseSepolia, base] as [
  AppKitNetwork,
  ...AppKitNetwork[],
];

export const wagmiAdapter = new WagmiAdapter({
  networks,
  projectId,
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
});

const queryClient = new QueryClient();

createAppKit({
  adapters: [wagmiAdapter],
  projectId,
  networks,
  defaultNetwork: baseSepolia,
  themeMode: "dark",
  metadata: {
    name: "Hypapad",
    description: "Prediction markets and token launch terminal",
    url: siteUrl,
    icons: [`${siteUrl.replace(/\/$/, "")}/logo.png`],
  },
  themeVariables: {
    "--w3m-accent": "#3d8b6e",
    "--w3m-border-radius-master": "9999px",
  },
});

export function Web3Providers({
  children,
  cookies,
}: {
  children: React.ReactNode;
  cookies: string | null;
}) {
  const initialState = cookieToInitialState(
    wagmiAdapter.wagmiConfig as Config,
    cookies ?? undefined,
  );

  return (
    <WagmiProvider
      config={wagmiAdapter.wagmiConfig}
      initialState={initialState}
    >
      <QueryClientProvider client={queryClient}>
        <AppKitModalCompactHeights />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
