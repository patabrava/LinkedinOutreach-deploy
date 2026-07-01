import "./globals.css";
import type { Metadata } from "next";
import { headers } from "next/headers";

import { NavBar } from "../components/NavBar";
import { getServerSession } from "../lib/auth";

export const metadata: Metadata = {
  title: "Linkedin Scraper",
  description: "Batch-based LinkedIn outreach workflow with clear intent, progress, and post-acceptance messaging.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  const host = headers().get("host")?.split(":")[0]?.toLowerCase() || "";
  const isReportHost = host === "report.deguraleads.de";

  return (
    <html lang={isReportHost ? "de" : "en"}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>
        <a className="skip-link" href="#main">
          {isReportHost ? "Direkt zum Inhalt" : "Skip to content"}
        </a>
        {isReportHost ? null : <NavBar authenticated={Boolean(session)} email={session?.user.email ?? null} />}
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
