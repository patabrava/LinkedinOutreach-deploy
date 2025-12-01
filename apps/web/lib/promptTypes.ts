/**
 * Prompt type definitions for draft generation:
 * 1 = Standard Outreach (default)
 * 2 = Vernetzung Thank-You (connection thank-you + challenges question)
 * 3 = Process Optimization (direct process optimization pitch)
 */
export type PromptType = 1 | 2 | 3;

export const PROMPT_TYPE_LABELS: Record<PromptType, string> = {
  1: "Standard Outreach",
  2: "Vernetzung Thank-You",
  3: "Process Optimization",
};
