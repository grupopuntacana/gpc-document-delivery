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

// Current logged-in user (from the IAS token via PortalService.whoami).
export async function currentUser() {
  return odata('portal/whoami()');
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
  // Same-origin POST: auth is injected upstream — the approuter/app-front forwards the JWT in
  // prod, the Vite proxy forwards Basic mocked-auth in hybrid dev — so no `credentials`/token
  // handling is needed here. (For large PDFs this base64-in-JSON path holds ~3× the file in
  // memory; if this UI outgrows the demo, switch to a multipart `FormData` POST.)
  const res = await fetch('/odata/v4/ingest/uploadDocument', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      // Camera captures and most files carry their own MIME; fall back to a generic binary
      // type (not PDF) when the browser can't determine it.
      fileName: file.name || 'upload',
      contentType: file.type || 'application/octet-stream',
      contentBase64,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return res.json();
}
