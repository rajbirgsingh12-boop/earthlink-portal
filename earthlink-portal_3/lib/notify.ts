// Tap-to-text helpers: build a prefilled SMS to a worker's saved number.
// No texting service or fees — the link opens the phone's own Messages app
// with everything typed, so sending is one tap.

// Accepts anything the user types ("(917) 555-0123", "917.555.0123") and
// returns a dialable +1XXXXXXXXXX, or "" when there aren't enough digits.
export const cleanPhone = (s: string): string => {
  const d = (s || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length > 11 ? `+${d}` : "";
};

// "?&body=" instead of "?body=" — the odd form is the one both iPhones and
// Android phones accept for a prefilled message.
export const smsHref = (phone: string, body: string): string =>
  `sms:${cleanPhone(phone)}?&body=${encodeURIComponent(body)}`;

export const prettyPhone = (s: string): string => {
  const p = cleanPhone(s);
  const m = p.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p || s;
};
