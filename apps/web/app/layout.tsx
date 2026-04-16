import "./globals.css";
import type { Metadata } from "next";

import { NavBar } from "../components/NavBar";
import { getServerSession } from "../lib/auth";

export const metadata: Metadata = {
  title: "Linkedin Scraper",
  description: "Batch-based LinkedIn outreach workflow with clear intent, progress, and post-acceptance messaging.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <NavBar authenticated={Boolean(session)} email={session?.user.email ?? null} />
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
