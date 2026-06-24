// Minimal CAP/OData client for the portal SPA.
// In production the approuter/app-front forwards auth to the srv-api destination;
// in local dev, vite proxies /odata to the CAP server (see vite.config.js).

async function odata(path) {
  const res = await fetch(`/odata/v4/${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return res.json();
}

// Live document listing from OpenText (unbound function -> { value: [...] }).
export async function listDocuments() {
  const body = await odata('portal/documents()');
  return body.value || [];
}

// Stable customer-facing URL for a document token.
export function invoiceUrl(token) {
  return `/invoice/${token}`;
}
