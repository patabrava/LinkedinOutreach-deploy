import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mission Control | LinkedIn Outreach",
  description: "Human-in-the-loop outreach workflow for LinkedIn",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
