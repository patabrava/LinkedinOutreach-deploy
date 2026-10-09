import { redirect } from "next/navigation";

export default function LegacyDeguraPerformanceRedirect() {
  redirect("/analytics/regular?days=30");
}
