import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Custom-field handling for the contacts CSV import, mirroring
 * `resolve-import-tags.ts`: names in the file are matched against the
 * account's `custom_fields` catalogue case-insensitively, missing
 * definitions are created for admin+ callers, and the per-contact values
 * land in `contact_custom_values`.
 *
 * Columns reach here as `cf:<name>` headers parsed by
 * `parse-contact-csv.ts` — see `CustomFieldColumn` there.
 */

const DEFAULT_FIELD_TYPE = 'text';

export interface ResolveImportCustomFieldsResult {
  /** Lowercase field name → custom_fields.id. */
  fieldIdByKey: Map<string, string>;
  /** Column labels that could not be matched and were not created. */
  skippedLabels: string[];
}

/**
 * Resolve `cf:` column names to custom field ids. Existing account fields
 * are matched case-insensitively on `field_name`. Missing ones are created
 * as free-text fields when `canCreateFields` is true (admin+, which is
 * also what the `custom_fields` RLS insert policy requires); otherwise
 * they are reported in `skippedLabels` and their values are dropped.
 */
export async function resolveImportCustomFieldIds(
  supabase: SupabaseClient,
  params: {
    accountId: string;
    userId: string;
    /** Column labels in the author's original casing. */
    fieldLabels: string[];
    canCreateFields: boolean;
  }
): Promise<ResolveImportCustomFieldsResult> {
  const { accountId, userId, fieldLabels, canCreateFields } = params;

  const uniqueLabels: string[] = [];
  const seen = new Set<string>();
  for (const raw of fieldLabels) {
    const label = raw.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueLabels.push(label);
  }

  if (uniqueLabels.length === 0) {
    return { fieldIdByKey: new Map(), skippedLabels: [] };
  }

  const { data: existing, error: fetchError } = await supabase
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', accountId);

  if (fetchError) throw fetchError;

  const fieldIdByKey = new Map<string, string>();
  for (const field of existing ?? []) {
    const key = field.field_name.trim().toLowerCase();
    if (!fieldIdByKey.has(key)) fieldIdByKey.set(key, field.id);
  }

  const skippedLabels: string[] = [];
  const toCreate: string[] = [];

  for (const label of uniqueLabels) {
    if (fieldIdByKey.has(label.toLowerCase())) continue;
    if (canCreateFields) toCreate.push(label);
    else skippedLabels.push(label);
  }

  if (toCreate.length > 0) {
    const { data: created, error: createError } = await supabase
      .from('custom_fields')
      .insert(
        toCreate.map((field_name) => ({
          user_id: userId,
          account_id: accountId,
          field_name,
          field_type: DEFAULT_FIELD_TYPE,
        }))
      )
      .select('id, field_name');

    if (createError) throw createError;

    for (const field of created ?? []) {
      fieldIdByKey.set(field.field_name.trim().toLowerCase(), field.id);
    }
  }

  return { fieldIdByKey, skippedLabels };
}

export interface ContactCustomValueAssignment {
  contactId: string;
  /** Lowercase field name → cell value, as parsed from the row. */
  customValues: Record<string, string>;
}

/**
 * Write `contact_custom_values` rows for imported contacts.
 *
 * Values for columns whose field could not be resolved are skipped.
 * Upserts on the `(contact_id, custom_field_id)` unique constraint from
 * migration 001, so re-running an import updates rather than duplicating.
 *
 * Returns the number of values written.
 */
export async function assignImportedCustomValues(
  supabase: SupabaseClient,
  assignments: ContactCustomValueAssignment[],
  fieldIdByKey: Map<string, string>
): Promise<number> {
  const rows: { contact_id: string; custom_field_id: string; value: string }[] =
    [];

  for (const { contactId, customValues } of assignments) {
    for (const [key, value] of Object.entries(customValues)) {
      const customFieldId = fieldIdByKey.get(key);
      if (!customFieldId || !value) continue;
      rows.push({
        contact_id: contactId,
        custom_field_id: customFieldId,
        value,
      });
    }
  }

  if (rows.length === 0) return 0;

  const chunkSize = 100;
  let assigned = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('contact_custom_values')
      .upsert(chunk, { onConflict: 'contact_id,custom_field_id' });
    if (error) throw error;
    assigned += chunk.length;
  }

  return assigned;
}
