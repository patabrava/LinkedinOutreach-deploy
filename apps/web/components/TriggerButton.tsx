"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerButtonProps = {
  action: (formData?: FormData) => void | Promise<void>;
  label: string;
  pendingLabel: string;
  successMessage: string;
  variant?: "primary" | "secondary" | "accent" | "warn";
  className?: string;
};

type SubmitButtonProps = {
  label: string;
  pendingLabel: string;
  btnClass: string;
  onPendingChange: (pending: boolean) => void;
};

// ---------------------------------------------------------------------------
// SubmitButton — must be a child of <form> so useFormStatus() works
// ---------------------------------------------------------------------------

function SubmitButton({ label, pendingLabel, btnClass, onPendingChange }: SubmitButtonProps) {
  const { pending } = useFormStatus();
  const prevPendingRef = useRef(false);

  useEffect(() => {
    if (prevPendingRef.current !== pending) {
      onPendingChange(pending);
      prevPendingRef.current = pending;
    }
  });

  return (
    <button type="submit" disabled={pending} className={btnClass}>
      {pending ? pendingLabel : label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// TriggerButton — public component
// ---------------------------------------------------------------------------

export function TriggerButton({
  action,
  label,
  pendingLabel,
  successMessage,
  variant = "primary",
  className,
}: TriggerButtonProps) {
  const [announcement, setAnnouncement] = useState<string>("");
  const wasPendingRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const btnClass = [
    "btn",
    variant !== "primary" ? variant : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  const handlePendingChange = (pending: boolean) => {
    const wasPending = wasPendingRef.current;
    wasPendingRef.current = pending;

    if (wasPending && !pending) {
      // Transition: pending → idle — announce success
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setAnnouncement(successMessage);
      timeoutRef.current = setTimeout(() => setAnnouncement(""), 5000);
    }
  };

  return (
    <form action={action} style={{ display: "inline-flex", alignItems: "center" }}>
      <SubmitButton
        label={label}
        pendingLabel={pendingLabel}
        btnClass={btnClass}
        onPendingChange={handlePendingChange}
      />
      {/* Always render the aria-live region so the browser registers it before announcements */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={
          announcement
            ? {
                marginLeft: 12,
                display: "inline-block",
                fontFamily: "monospace",
                fontSize: 11,
                textTransform: "uppercase",
                color: "var(--muted)",
              }
            : { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0,0,0,0)" }
        }
      >
        {announcement ? `→ ${announcement}` : ""}
      </span>
    </form>
  );
}
