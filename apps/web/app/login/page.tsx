import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string };
}) {
  const nextPath = searchParams?.next || "/";

  return (
    <div className="page">
      <LoginForm nextPath={nextPath} />
    </div>
  );
}
