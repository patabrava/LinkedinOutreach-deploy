export type LinkedinAccountIdentity = {
  label: string;
  email: string;
  display_name: string;
  browser_slot: 1 | 2;
};

export function formatLinkedinAccountIdentity(account: LinkedinAccountIdentity): string {
  const name = account.display_name.trim() || account.label.trim() || account.email.trim() || "LINKEDIN ACCOUNT";
  return `${name} · Browser ${account.browser_slot}`;
}
