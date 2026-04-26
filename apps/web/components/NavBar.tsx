"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Mission Control" },
  { href: "/custom-outreach", label: "Custom Outreach" },
  { href: "/leads", label: "Leads Operations" },
];

const MORE_NAV_ITEMS = [
  { href: "/upload", label: "Upload" },
  { href: "/followups", label: "Follow-ups" },
  { href: "/analytics", label: "Analytics" },
  { href: "/settings", label: "Settings" },
];

type NavBarProps = {
  authenticated?: boolean;
  email?: string | null;
};

export function NavBar({ authenticated = false, email = null }: NavBarProps) {
  const pathname = usePathname();
  const moreActive = MORE_NAV_ITEMS.some((item) => pathname.startsWith(item.href));
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="top-nav">
      <div className="nav-inner">
        <Link href="/" className="brand" aria-label="Linkedin Scraper home">
          <div className="brand-text">
            <span className="brand-name">LINKEDIN</span>
            <span className="brand-tagline">Scraper</span>
          </div>
        </Link>
        <button
          type="button"
          className="nav-burger"
          aria-expanded={mobileOpen}
          aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
          onClick={() => setMobileOpen((value) => !value)}
        >
          <span />
          <span />
          <span />
        </button>
        <div className={`nav-links${mobileOpen ? " nav-links--open" : ""}`}>
          {NAV_ITEMS.map((item) => {
            const isActive =
              (item.href === "/" && pathname === "/") || (item.href !== "/" && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-link${isActive ? " active" : ""}`}
                prefetch
                onClick={() => setMobileOpen(false)}
              >
                {item.label}
              </Link>
            );
          })}
          <details className="nav-more" open={moreActive}>
            <summary className={`nav-link nav-more__summary${moreActive ? " active" : ""}`}>More</summary>
            <div className="nav-more__panel" aria-label="Secondary navigation">
              {MORE_NAV_ITEMS.map((item) => {
                const isActive = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`nav-more__link${isActive ? " active" : ""}`}
                    prefetch
                    onClick={() => setMobileOpen(false)}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </details>
        </div>
        {authenticated ? (
          <div className="nav-user">
            <span className="nav-user-email">{(email ?? "").toUpperCase()}</span>
            <form action="/logout" method="post">
              <button type="submit" className="nav-signout">[SIGN OUT]</button>
            </form>
          </div>
        ) : (
          <Link href="/login" className="nav-link nav-signin">
            SIGN IN
          </Link>
        )}
      </div>
    </nav>
  );
}
