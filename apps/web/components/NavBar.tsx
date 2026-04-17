"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Mission Control" },
  { href: "/leads", label: "Leads" },
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
                {item.label}
              </Link>
            );
          })}
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
