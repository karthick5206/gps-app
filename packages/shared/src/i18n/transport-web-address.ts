/**
 * Hindi and Tamil strings of the web address type-ahead (AddressSearchCombobox) and the booking point pickers
 * (v1.15.1). Own file so parallel work on hi.ts / ta.ts does not conflict; index.ts merges it (entries in hi.ts / ta.ts
 * win). Keys are the English source strings; keep {{placeholders}} unchanged.
 */
export const TRANSPORT_WEB_ADDRESS_HI: Record<string, string> = {
  'Too many address searches. Wait a moment and try again.': 'बहुत अधिक पता खोजें हुईं। थोड़ा रुककर फिर कोशिश करें।',
  '{{n}} address suggestions': '{{n}} पता सुझाव',
};

export const TRANSPORT_WEB_ADDRESS_TA: Record<string, string> = {
  'Too many address searches. Wait a moment and try again.': 'அதிகமான முகவரித் தேடல்கள். சிறிது நேரம் கழித்து மீண்டும் முயலவும்.',
  '{{n}} address suggestions': '{{n}} முகவரிப் பரிந்துரைகள்',
};
