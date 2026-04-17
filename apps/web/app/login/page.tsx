import { LoginForm } from "./LoginForm";
import { getAuthConfigStatus } from "../../lib/authConfig";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = { title: "SIGN IN // LINKEDIN OUTREACH" };

export default function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string; e?: string };
}) {
  const nextPath = searchParams?.next || "/";
  const queryError = searchParams?.e ?? null;
  const devBypass = process.env.NODE_ENV !== "production";
  const devBypassEmail = process.env.DEV_BYPASS_EMAIL ?? "caposk817@gmail.com";
  const authConfigured = getAuthConfigStatus().configured;

  return (
    <section className="login-page">
      <h1 className="page-title">SIGN IN</h1>
      {!authConfigured ? (
        <div className="login-banner">
          AUTH GATE NOT CONFIGURED. ADD THE SUPABASE PUBLIC URL AND PUBLIC KEY ENV VARS ON HOSTINGER,
          THEN REDEPLOY.
        </div>
      ) : null}
      <LoginForm nextPath={nextPath} queryError={queryError} authConfigured={authConfigured} />
      {devBypass ? (
        <form action="/api/dev/signin" method="post" className="dev-bypass">
          <input type="hidden" name="next" value={nextPath} />
          <label htmlFor="dev-bypass-email" className="dev-bypass-label">
            DEV BYPASS // NOT PRODUCTION
          </label>
          <input
            id="dev-bypass-email"
            name="email"
            type="email"
            defaultValue={devBypassEmail}
            required
            className="login-input"
          />
          <button type="submit" className="btn">
            SKIP MAGIC LINK →
          </button>
        </form>
      ) : null}
    </section>
  );
}
