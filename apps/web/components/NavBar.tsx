"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Mission Control", hint: "Drafts & approvals" },
  { href: "/leads", label: "Leads", hint: "Uploaded pipeline" },
  { href: "/followups", label: "Follow-ups", hint: "Replies & review" },
  { href: "/analytics", label: "Analytics", hint: "Performance metrics" },
  { href: "/upload", label: "Upload", hint: "CSV intake" },
  { href: "/settings", label: "Settings", hint: "LinkedIn credentials" },
];

export function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="top-nav">
      <div className="nav-inner">
        <Link href="/" className="brand" aria-label="Linkedin Scraper home">
          <div className="brand-text">
            <span className="brand-name">LINKEDIN</span>
            <span className="brand-tagline">Scraper</span>
          </div>
        </Link>
        <div className="nav-links">
          {NAV_ITEMS.map((item) => {
            const isActive =
              (item.href === "/" && pathname === "/") || (item.href !== "/" && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-link${isActive ? " active" : ""}`}
                prefetch
              >
                <div className="nav-label">{item.label}</div>
                <div className="nav-hint">{item.hint}</div>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
