export const CANONICAL_SEQUENCE_PLACEHOLDERS = [
  "{{first_name}}",
  "{{last_name}}",
  "{{full_name}}",
  "{{company_name}}",
] as const;

export type SequenceMessageField = "first_message" | "second_message" | "third_message";

export type SequenceFieldValidationError = {
  field: SequenceMessageField;
  invalidTokens: string[];
  allowedTokens: readonly string[];
};

export type SequencePlaceholderValidationResult = {
  isValid: boolean;
  errors: SequenceFieldValidationError[];
};

export type SequencePlaceholderValidationByFieldResult = {
  isValid: boolean;
  errors: Array<{
    fieldKey: SequenceMessageField;
    invalidTokens: string[];
    allowedTokens: readonly string[];
  }>;
  allowedTokens: readonly string[];
};

const DOUBLE_CURLY_TOKEN_REGEX = /\{\{[^{}\n]+\}\}/g;
const SINGLE_CURLY_TOKEN_REGEX = /\{[^{}\n]+\}/g;
const BRACKET_TOKEN_REGEX = /\[[^\[\]\n]+\]/g;

function dedupeOrdered(tokens: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token);
      ordered.push(token);
    }
  }
  return ordered;
}

export function detectPlaceholderTokens(message: string): string[] {
  if (!message) return [];

  const collected: string[] = [];
  const doubleCurly = message.match(DOUBLE_CURLY_TOKEN_REGEX) || [];
  collected.push(...doubleCurly);

  const maskedDoubleCurly = message.replace(DOUBLE_CURLY_TOKEN_REGEX, " ");
  const singleCurly = maskedDoubleCurly.match(SINGLE_CURLY_TOKEN_REGEX) || [];
  const bracketTokens = message.match(BRACKET_TOKEN_REGEX) || [];

  collected.push(...singleCurly, ...bracketTokens);
  return dedupeOrdered(collected);
}

export function findInvalidPlaceholderTokens(message: string): string[] {
  const tokens = detectPlaceholderTokens(message);
  return tokens.filter((token) => !CANONICAL_SEQUENCE_PLACEHOLDERS.includes(token as (typeof CANONICAL_SEQUENCE_PLACEHOLDERS)[number]));
}

export function validateSequencePlaceholderFields(fields: Record<SequenceMessageField, string>): SequencePlaceholderValidationResult {
  const errors: SequenceFieldValidationError[] = [];

  (Object.entries(fields) as Array<[SequenceMessageField, string]>).forEach(([field, value]) => {
    const invalidTokens = findInvalidPlaceholderTokens(value || "");
    if (invalidTokens.length) {
      errors.push({
        field,
        invalidTokens,
        allowedTokens: CANONICAL_SEQUENCE_PLACEHOLDERS,
      });
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export function validateSequencePlaceholdersByField(
  fields: Record<SequenceMessageField, string>
): SequencePlaceholderValidationByFieldResult {
  const result = validateSequencePlaceholderFields(fields);
  return {
    isValid: result.isValid,
    errors: result.errors.map((entry) => ({
      fieldKey: entry.field,
      invalidTokens: entry.invalidTokens,
      allowedTokens: entry.allowedTokens,
    })),
    allowedTokens: CANONICAL_SEQUENCE_PLACEHOLDERS,
  };
}

export function validateSequencePlaceholders(message: string): { unknownTokens: string[] } {
  return { unknownTokens: findInvalidPlaceholderTokens(message) };
}

export function findUnknownSequencePlaceholders(message: string): string[] {
  return findInvalidPlaceholderTokens(message);
}

export function buildUnknownPlaceholderMessage(invalidTokens: string[]): string {
  const tokenList = dedupeOrdered(invalidTokens).map((token) => `"${token}"`).join(", ");
  return `Unknown placeholder ${tokenList}. Allowed placeholders: ${CANONICAL_SEQUENCE_PLACEHOLDERS.join(", ")}.`;
}
