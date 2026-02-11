import "./globals.css";
import type { Metadata } from "next";
import { NavBar } from "../components/NavBar";

export const metadata: Metadata = {
  title: "Linkedin Scraper",
  description: "Human-in-the-loop outreach workflow for LinkedIn",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>
        <NavBar />
        <main>{children}</main>
      </body>
    </html>
  );
}
