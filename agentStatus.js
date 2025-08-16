// agentStatus.js
// Fetch Agents Status & Activity report for a tenant with pagination support.
// Supports loading 500 records at a time with next/previous navigation.
//
// Usage examples:
//   node -r dotenv/config agentStatus.js mc_int 2025-07-02T08:00:00Z 2025-07-02T12:00:00Z
//   node -r dotenv/config agentStatus.js mc_int 2025-07-02T08:00:00Z 2025-07-02T12:00:00Z report.csv
//
// The script automatically handles pagination, retries (exp backoff),
// and self-signed certificates (inherits httpsAgent from tokenService).

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { getPortalToken, httpsAgent } from './tokenService.js';

const MAX_RETRIES = 3;

/**
 * Convert an array of plain objects to a CSV string.
 * Very small helper to avoid a new dependency.
 */
function toCsv(records, delimiter = ',') {
  if (!records.length) return '';
  const header = Object.keys(records[0]).join(delimiter);
  const rows = records.map(r =>
    Object.values(r)
      .map(v => {
        if (v == null) return '';
        const str = String(v);
        return str.includes(delimiter) || str.includes('\n') || str.includes('"')
          ? `"${str.replace(/"/g, '""')}"` // escape quotes per RFC4180
          : str;
      })
      .join(delimiter)
  );
  return [header, ...rows].join('\n');
}

/**
 * Fetch agent status report with pagination support.
 * Returns 500 records at a time with next token for pagination.
 * @param {string} acct                         – tenant / account id.
 * @param {object} opts                         – query options.
 * @param {number} opts.startDate               – unix ms start of range.
 * @param {number} opts.endDate                 – unix ms end of range.
 * @param {string} [opts.name]                  – filter by agent name.
 * @param {string} [opts.extension]             – filter by extension.
 * @param {string} [opts.start_key]             – pagination token from previous request.
 * @param {number} [opts.maxRows]               – max records to return (default 500).
 * @returns {Promise<{rows: object[], next: string|null}>} – paginated result with next token.
 */
export async function fetchAgentStatus(
  acct,
  { startDate, endDate, name, extension, start_key, maxRows = 500 } = {}
) {
  // Use env-configurable endpoint; fall back to the common REST path.
  const url = `${process.env.BASE_URL}${process.env.AGENT_STATUS_ENDPOINT || '/api/v2/reports/callcenter/agents/stats'}`;
  const records = [];
  let startKey = start_key;
  let nextStartKey = null;
  const limit = Math.min(maxRows, 500); // Cap at 500 per request

  retry: for (let attempt = 0, delay = 1_000; attempt < MAX_RETRIES; attempt++, delay *= 2) {
    try {
      while (true) {
        const params = {
          startDate: Math.floor(startDate / 1000),
          endDate: Math.floor(endDate / 1000),
          ...(name && { name }),
          ...(extension && { extension }),
          ...(startKey && { start_key: startKey })
        };

        // Obtain JWT once and log the first 40 chars for debugging
        const token = await getPortalToken(acct);
        console.log('REQ', url, params, {
          'X-Account-ID': process.env.ACCOUNT_ID_HEADER ?? acct,
          'X-User-Agent': 'portal',
          Authorization: `Bearer ${token ? token.slice(0,40) + '…' : 'undefined'}`
        });

        const { data } = await axios.get(url, {
          params,
          headers: {
            'X-Account-ID': process.env.ACCOUNT_ID_HEADER ?? acct,
            'X-User-Agent': 'portal',
            Authorization: `Bearer ${token}`
          },
          httpsAgent
        });

        // Always capture paging token; undefined → null to signal end of list
        nextStartKey = data.next_start_key ?? null;

        let chunk;
        const ensureExt = r => ({
          extension: r.extension ?? r.ext ?? r.userId ?? r.user_id ?? r.id ?? '',
          ...r
        });

        if (Array.isArray(data.data)) {
          chunk = data.data.map(ensureExt);
        } else if (data && typeof data === 'object') {
          // Newer portal returns an object keyed by extension/userId
          // Preserve the key (extension) by merging it into each record
          chunk = Object.entries(data).map(([ext, info]) => ensureExt({ extension: ext, ...info }));
        } else {
          console.error('Unexpected API payload; dumping full response:', JSON.stringify(data, null, 2));
          throw new Error('Unrecognised API response format');
        }

        const remaining = limit - records.length;

        // Push at most `remaining` records so we never exceed requested limit
        if (remaining > 0) {
          records.push(...chunk.slice(0, remaining));
        }

        // Break early once we have some rows so caller can respond quickly
        if (records.length > 0) {
          break;
        }

        // If we still didn't accumulate anything and there is another page,
        // continue looping; otherwise exit.
        if (nextStartKey === null) {
          break;
        }

        startKey = nextStartKey;
      }
      break retry; // success
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      console.warn(`Request failed (${err.message}); retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  return { rows: records, next: nextStartKey };
}

/**
 * Legacy function for backward compatibility - fetches all records.
 * @param {string} acct                         – tenant / account id.
 * @param {object} opts                         – query options.
 * @returns {Promise<object[]>}                 – all records.
 */
export async function fetchAllAgentStatus(acct, opts = {}) {
  const allRecords = [];
  let startKey = null;

  while (true) {
    const result = await fetchAgentStatus(acct, { ...opts, start_key: startKey, maxRows: 500 });
    allRecords.push(...result.rows);
    
    if (!result.next) break;
    startKey = result.next;
  }

  return allRecords;
}

async function cli() {
  const [,, acct, startIso, endIso, outputFile] = process.argv;
  if (!acct || !startIso || !endIso) {
    console.error(`Usage: node -r dotenv/config agentStatus.js <accountId> <startISO> <endISO> [outputFile.{csv|json}]`);
    process.exit(1);
  }

  const startDate = Date.parse(startIso);
  const endDate   = Date.parse(endIso);
  if (Number.isNaN(startDate) || Number.isNaN(endDate)) {
    console.error('Invalid ISO date/time strings.');
    process.exit(1);
  }

  // Use the legacy function for CLI to maintain backward compatibility
  const data = await fetchAllAgentStatus(acct, { startDate, endDate });

  if (outputFile) {
    await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
    if (outputFile.endsWith('.csv')) {
      await fs.promises.writeFile(outputFile, toCsv(data));
    } else {
      await fs.promises.writeFile(outputFile, JSON.stringify(data, null, 2));
    }
    console.log(`Saved ${data.length} records to ${outputFile}`);
  } else {
    console.table(data);
  }
}

// Execute when run directly
if (import.meta.url === process.argv[1] || import.meta.url === `file://${process.argv[1]}`) {
  cli().catch(err => {
    console.error(err.response?.data || err.stack || err.message);
    process.exit(1);
  });
}
