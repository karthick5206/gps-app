const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Text for a selected value: its known label, else the value itself, except that a raw id is never shown. */
export function optionLabel(known: string | undefined, value: string, idFallback: string): string {
  return known ?? (UUID.test(value) ? idFallback : value);
}
