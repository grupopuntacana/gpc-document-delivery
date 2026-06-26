'use strict';

const crypto = require('crypto');
const cds = require('@sap/cds');

const opentext = require('./lib/opentext');
const token = require('./lib/token');

const LOG = cds.log('ingest');

// Where uploads land. Defaults to the portal folder so an uploaded document shows up in
// the same listing (acceptance criterion: portal refresh shows the new doc). A dedicated
// ingest folder can be set without code change; doc-type → folder routing is deferred.
const FOLDER_ID = Number(
  process.env.OPENTEXT_INGEST_FOLDER_ID || process.env.OPENTEXT_FOLDER_ID || 2000,
);

// Match the portal's short-lived token (demo used 7 days).
const TOKEN_TTL_DAYS = Number(process.env.PORTAL_TOKEN_TTL_DAYS || 7);

/**
 * Django-style dedup, mirroring demo/server.py: keep the original filename; on a collision
 * append an 8-hex-char UUID suffix before the extension ('invoice.pdf' → 'invoice_a3f2b1c8.pdf').
 * One-shot, no retry loop.
 */
async function uniqueName(folderId, fileName) {
  const existing = new Set(await opentext.listFolderChildNames(folderId));
  if (!existing.has(fileName)) return fileName;
  const dot = fileName.lastIndexOf('.');
  const root = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const renamed = `${root}_${suffix}${ext}`;
  LOG.info(`filename conflict: ${fileName} -> ${renamed}`);
  return renamed;
}

module.exports = class IngestService extends cds.ApplicationService {
  init() {
    this.on('uploadDocument', async (req) => {
      const { fileName, contentType, contentBase64 } = req.data;
      if (!fileName) return req.reject(400, 'fileName is required');
      if (!contentBase64) return req.reject(400, 'contentBase64 is required');

      const buffer = Buffer.from(contentBase64, 'base64');
      if (buffer.length === 0) return req.reject(400, 'empty or invalid base64 content');

      try {
        const name = await uniqueName(FOLDER_ID, fileName);
        const nodeId = await opentext.uploadDocument(
          FOLDER_ID,
          buffer,
          name,
          contentType || 'application/pdf',
        );
        const tok = await token.makeToken(nodeId, { ttlDays: TOKEN_TTL_DAYS });
        LOG.info(`uploaded "${fileName}" as "${name}" -> node ${nodeId} (${buffer.length} bytes)`);
        return { nodeId, name, token: tok };
      } catch (err) {
        LOG.error('upload failed:', err.message);
        return req.reject(502, `OpenText upload failed: ${err.message}`);
      }
    });

    return super.init();
  }
};
