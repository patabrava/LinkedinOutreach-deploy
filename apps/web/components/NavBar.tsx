"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { supabaseBrowserClient } from "../lib/supabaseClient";


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
  const router = useRouter();

  const handleSignOut = async () => {
    const supabase = supabaseBrowserClient();
    if (supabase) {
      await supabase.auth.signOut();
    }
    router.replace("/login");
    router.refresh();
  };

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

          {authenticated ? (
            <button type="button" className="nav-link nav-button" onClick={handleSignOut}>
              <div className="nav-label">Log out</div>
              <div className="nav-hint">{email || "Supabase session"}</div>
            </button>
          ) : (
            <Link href="/login" className={`nav-link${pathname === "/login" ? " active" : ""}`} prefetch>
              <div className="nav-label">Log in</div>
              <div className="nav-hint">Supabase auth</div>
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
