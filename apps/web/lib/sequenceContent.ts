export type SequenceVariantContent = {
  id: number;
  variant_key: number;
  connect_note: string;
  first_message: string;
  second_message: string;
  third_message: string;
  is_active?: boolean;
};

export type SequenceContentSource = {
  id: number;
  name: string;
  connect_note: string;
  first_message: string;
  second_message: string;
  third_message: string;
  followup_interval_days: number;
  variants?: SequenceVariantContent[];
};

export type SequenceEditorContent = {
  variantId: number | null;
  variantKey: number | null;
  name: string;
  connect_note: string;
  first_message: string;
  second_message: string;
  third_message: string;
  followup_interval_days: number;
};

const activeVariants = (sequence: SequenceContentSource): SequenceVariantContent[] =>
  (sequence.variants ?? [])
    .filter((variant) => variant.is_active !== false)
    .sort((left, right) => left.variant_key - right.variant_key);

export function getSequenceVariantOptions(sequence: SequenceContentSource) {
  return activeVariants(sequence).map((variant) => ({
    id: variant.id,
    variant_key: variant.variant_key,
  }));
}

export function getSequenceEditorContent(
  sequence: SequenceContentSource,
  variantKey?: number | null,
): SequenceEditorContent {
  const variants = activeVariants(sequence);
  const selectedVariant =
    variants.find((variant) => variant.variant_key === variantKey) ?? variants[0] ?? null;
  const source = selectedVariant ?? sequence;

  return {
    variantId: selectedVariant?.id ?? null,
    variantKey: selectedVariant?.variant_key ?? null,
    name: sequence.name,
    connect_note: source.connect_note,
    first_message: source.first_message,
    second_message: source.second_message,
    third_message: source.third_message,
    followup_interval_days: sequence.followup_interval_days,
  };
}
