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

// Read a File as a base64 string (strips the `data:...;base64,` prefix).
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

// Upload a document via the authenticated ingest action. Returns { nodeId, name, token }.
// The file rides as base64 in the JSON body (matches IngestService.uploadDocument).
export async function uploadDocument(file) {
  const contentBase64 = await fileToBase64(file);
  const res = await fetch('/odata/v4/ingest/uploadDocument', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || 'application/pdf',
      contentBase64,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return res.json();
}
