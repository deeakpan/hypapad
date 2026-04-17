import type { Metadata } from "next";
import { headers } from "next/headers";
import { Plus_Jakarta_Sans, Syne } from "next/font/google";
import { AppHeader } from "../components/app-header";
import { Web3Providers } from "../components/web3/providers";
import "./globals.css";

const syne = Syne({
  variable: "--font-syne",
  subsets: ["latin"],
  display: "swap",
});

const plusJakarta = Plus_Jakarta_Sans({
  variable: "--font-ui",
  subsets: ["latin"],
  display: "swap",
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

const APP_DESCRIPTION =
  "Hypapad is a prediction-market and token-launch terminal: launch Hypa tokens on a bonding curve, trade after graduation on Uniswap-style pools, and manage stakes and markets from one place.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: "Hypapad",
  title: {
    default: "Hypapad",
    template: "%s — Hypapad",
  },
  description: APP_DESCRIPTION,
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/",
    siteName: "Hypapad",
    title: "Hypapad",
    description: APP_DESCRIPTION,
    images: [{ url: "/hypapadlogo.png", alt: "Hypapad" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Hypapad",
    description: APP_DESCRIPTION,
    images: ["/hypapadlogo.png"],
  },
  icons: {
    apple: [{ url: "/hypapadlogo.png", sizes: "180x180", type: "image/png" }],
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookie = (await headers()).get("cookie");

  return (
    <html
      lang="en"
      className={`${syne.variable} ${plusJakarta.variable} h-full antialiased`}
    >
      <body className="flex min-h-dvh flex-col bg-canvas font-sans text-fg">
        <Web3Providers cookies={cookie}>
          <AppHeader />
          {children}
        </Web3Providers>
      </body>
    </html>
  );
}
