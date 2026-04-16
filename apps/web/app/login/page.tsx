import { LoginForm } from "./LoginForm";

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

  return (
    <section className="login-page">
      <h1 className="page-title">SIGN IN</h1>
      <LoginForm nextPath={nextPath} queryError={queryError} />
    </section>
  );
}
