'use strict';

const crypto = require('crypto');
const cds = require('@sap/cds');

const credstore = require('./lib/credstore');
const opentext = require('./lib/opentext');

const LOG = cds.log('selftest');

module.exports = class SelfTestService extends cds.ApplicationService {
  init() {
    this.on('checkSecret', async () => {
      const secret = await credstore.getSharedLinkSecret();
      let keyFingerprint = '';
      try {
        const pem = await credstore.getCloudFrontPrivateKey();
        keyFingerprint = crypto
          .createHash('sha256')
          .update(pem)
          .digest('hex')
          .slice(0, 12);
      } catch (err) {
        // Key is optional for this check — report secret status regardless.
        LOG.warn('CloudFront key unavailable:', err.message);
      }
      const source = credstore.isBound() ? 'credstore' : 'env';
      LOG.info(`checkSecret ok (source=${source}, secretLen=${secret.length})`);
      return {
        ok: secret.length > 0,
        source,
        secretLen: secret.length,
        keyFingerprint,
      };
    });

    this.on('pingOpenText', async (req) => {
      try {
        const result = await opentext.pingNode(2000);
        LOG.info(
          `pingOpenText ok=${result.ok} status=${result.status} ms=${result.ms}`,
        );
        return result;
      } catch (err) {
        LOG.error('pingOpenText failed:', err.message);
        return req.reject(502, `OpenText ping failed: ${err.message}`);
      }
    });

    return super.init();
  }
};
