// reportFetcher.js
// Generic report fetcher for call-center portal tables.
// Supports the following endpoints:
//   – /portal/reports/cdrs                         (CDRs)
//   – /portal/callcenter/reports/queues-calls      (Queue Calls)
//   – /portal/callcenter/reports/queues-outbound-calls (Queue Outbound Calls)
//   – /portal/callcenter/reports/campaigns-activity    (Campaigns Activity)
//
// Like agentStatus.js this module handles:
//   • Portal authentication via tokenService.getPortalToken
//   – Automatic pagination via next_start_key when provided
//   • Exponential-backoff retry logic (up to 3 attempts)
//   • Optional CSV serialization helper
//   • A minimal CLI for ad-hoc usage

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { getPortalToken, httpsAgent } from './tokenService.js';

const MAX_RETRIES = 3;

const ENDPOINTS = {
  // Raw CDRs
  cdrs: '/api/v2/reports/cdrs/all',

  // Queue-specific CDR summaries
  queueCalls: '/api/v2/reports/queues_cdrs',                 // inbound queues
  queueOutboundCalls: '/api/v2/reports/queues_outbound_cdrs', // outbound queues

  // Campaign dialer lead activity
  campaignsActivity: '/api/v2/reports/campaigns/leads/history'
};

/**
 * Convert an array of plain objects to a CSV string.
 * Borrowed from agentStatus.js to avoid new deps.
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
          ? `"${str.replace(/"/g, '""')}"` // RFC4180 escaping
          : str;
      })
      .join(delimiter)
  );
  return [header, ...rows].join('\n');
}

/**
 * Flatten CDR records for CSV export.
 * CDR data often contains nested objects and arrays that need to be flattened.
 */
function flattenCdrForCsv(records) {
  if (!records || !Array.isArray(records)) return [];
  
  return records.map(record => {
    const flattened = {};
    
    // Recursively flatten nested objects
    function flattenObject(obj, prefix = '') {
      for (const [key, value] of Object.entries(obj)) {
        const newKey = prefix ? `${prefix}_${key}` : key;
        
        if (value === null || value === undefined) {
          flattened[newKey] = '';
        } else if (Array.isArray(value)) {
          // For arrays, join with semicolon or take first element if objects
          if (value.length === 0) {
            flattened[newKey] = '';
          } else if (typeof value[0] === 'object' && value[0] !== null) {
            // If array contains objects, flatten the first one
            flattenObject(value[0], newKey);
            // Add array length info
            flattened[`${newKey}_count`] = value.length;
          } else {
            // Simple array - join with semicolon
            flattened[newKey] = value.join('; ');
          }
        } else if (typeof value === 'object' && value !== null) {
          // Nested object - flatten recursively
          flattenObject(value, newKey);
        } else {
          // Primitive value
          flattened[newKey] = value;
        }
      }
    }
    
    flattenObject(record);
    return flattened;
  });
}

/**
 * Generic report fetcher with pagination + retries.
 *
 * @param {string} report   – one of keys in ENDPOINTS.
 * @param {string} tenant   – domain / account id.
 * @param {object} params   – query params (startDate/endDate etc).
 * @returns {Promise<object[]>}
 */
export async function fetchReport(report, tenant, params = {}) {
  if (!ENDPOINTS[report]) throw new Error(`Unknown report type: ${report}`);

  const url = `${process.env.BASE_URL}${ENDPOINTS[report]}`;
  let token;
  const out = [];
  let startKey;
  const seenStartKeys = new Set(); // Track seen start keys to detect infinite loops
  let consecutiveSameKey = 0; // Count consecutive same keys

  retry: for (let attempt = 0, delay = 1_000; attempt < MAX_RETRIES; attempt++, delay *= 2) {
    try {
      while (true) {
        const qs = {
          ...params,
          // Request specific fields for CDRs
          ...(report === 'cdrs' && {
            fields: [
              'call_id',
              'caller_id_number',
              'callee_id_number',
              'disposition',
              'subdisposition',
              'follow_up_notes',
              'timestamp'
            ].join(',')
          }),
          // Request full set of columns for queue reports so duration, abandon etc. are returned
          ...(report === 'queueOutboundCalls' && {
            fields: [
              'called_time',
              'agent_name',
              'agent_ext',
              'destination',
              'answered_time',
              'hangup_time',
              'wait_duration',
              'talked_duration',
              'queue_name',
              'queue_history',
              'agent_history',
              'agent_hangup',
              'call_id',
              'bleg_call_id',
              'event_timestamp',
              'agent_first_name',
              'agent_last_name',
              'agent_extension',
              'agent_email',
              'agent_talk_time',
              'agent_connect_time',
              'agent_action',
              'agent_transfer',
              'csat',
              'media_recording_id',
              'recording_filename',
              'caller_id_name',
              'caller_id_number',
              'a_leg',
              'to',
              'interaction_id',
              'agent_disposition',
              'agent_subdisposition1',
              'agent_subdisposition2'
            ].join(',')
          }),
          ...(report === 'queueCalls' && {
            fields: [
              'called_time',
              'caller_id_number',
              'caller_id_name',
              'answered_time',
              'hangup_time',
              'wait_duration',
              'talked_duration',
              'queue_name',
              'abandoned',
              'queue_history',
              'agent_history',
              'agent_attempts',
              'agent_hangup',
              'call_id',
              'bleg_call_id',
              'event_timestamp',
              'agent_first_name',
              'agent_last_name',
              'agent_extension',
              'agent_email',
              'agent_talk_time',
              'agent_connect_time',
              'agent_action',
              'agent_transfer',
              'csat',
              'media_recording_id',
              'recording_filename',
              'callee_id_number',
              'a_leg',
              'interaction_id',
              'agent_disposition',
              'agent_subdisposition1',
              'agent_subdisposition2'
            ].join(',')
          }),
          ...(startKey && { start_key: startKey })
        };

        // Acquire/refresh token for every loop iteration (cheap due to cache)
        token = await getPortalToken(tenant);

        console.log(`Fetching ${report} data${startKey ? ` (page with start_key: ${startKey})` : ''}...`);
        const startTime = Date.now();

        const { data } = await axios.get(url, {
          params: qs,
          headers: {
            Authorization: `Bearer ${token}`,
            'X-User-Agent': 'portal',
            'X-Account-ID': process.env.ACCOUNT_ID_HEADER ?? tenant
          },
          httpsAgent,
          timeout: 300000, // 5 minutes timeout for large datasets
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });

        const fetchTime = Date.now() - startTime;
        console.log(`✅ Fetch completed in ${fetchTime}ms`);

        let chunk;
        if (Array.isArray(data.data)) {
          chunk = data.data;
        } else if (Array.isArray(data)) {
          // Some endpoints return an array at top-level
          chunk = data;
        } else if (data.rows && Array.isArray(data.rows)) {
          chunk = data.rows;
        } else if (data && typeof data === 'object') {
          // Handle object with numeric keys (CDR data structure)
          const keys = Object.keys(data);
          if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
            // This is an object with numeric keys like {"0": {record}, "1": {record}, ...}
            chunk = Object.values(data);
            console.log(`🔧 Converted object with ${keys.length} numeric keys to array`);
          } else {
            // fallback – attempt to flatten object of objects (similar to agentStatus)
            chunk = Object.entries(data).map(([k, v]) => ({ key: k, ...v }));
          }
        } else {
          chunk = [];
        }
        out.push(...chunk);

        console.log(`📊 Processed ${chunk.length} records (total: ${out.length})`);

        if (data.next_start_key) {
          // Check for infinite loop - same start_key returned multiple times
          if (startKey === data.next_start_key) {
            consecutiveSameKey++;
            console.warn(`⚠️  Same start_key returned ${consecutiveSameKey} times: ${data.next_start_key}`);
            
            if (consecutiveSameKey >= 3) {
              console.error(`🚫 Infinite loop detected! Same start_key returned ${consecutiveSameKey} times. Breaking pagination.`);
              break;
            }
          } else {
            consecutiveSameKey = 0; // Reset counter when key changes
          }

          // Check if we've seen this start_key before (broader infinite loop detection)
          if (seenStartKeys.has(data.next_start_key)) {
            console.error(`🚫 Infinite loop detected! start_key ${data.next_start_key} was already processed. Breaking pagination.`);
            break;
          }
          
          seenStartKeys.add(data.next_start_key);
          startKey = data.next_start_key;
          console.log(`🔄 More data available, continuing with next page...`);
        } else {
          console.log(`✅ All data fetched. Total records: ${out.length}`);
          break; // no more pages
        }
      }
      break retry; // success
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      console.warn(`Report fetch failed (${err.message}); retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // ---------------------------------------------------------------------------
  // Post-processing helpers
  if (report === 'queueCalls' || report === 'queueOutboundCalls') {
    // Derive durations if the backend omitted them (older Talkdesk tenants)
    out.forEach(record => {
      // Talked duration
      if (!record.talked_duration && record.hangup_time && record.answered_time) {
        record.talked_duration = record.hangup_time - record.answered_time;
      }
      // Wait / queue duration
      if (!record.wait_duration && record.called_time) {
        if (record.answered_time) {
          record.wait_duration = record.answered_time - record.called_time;
        } else if (record.hangup_time) {
          record.wait_duration = record.hangup_time - record.called_time;
        }
      }
    });
  }

  // For inbound queue reports Talkdesk returns one row per agent leg.
  // When the consumer only needs a single row per call we keep the *first*
  // occurrence for each call_id (usually the initial `dial` leg) and drop the rest.
  if (report === 'queueCalls') {
    const seen = new Set();
    const firstRows = [];
    for (const rec of out) {
      // If the row is missing a call_id we cannot group it – keep it.
      if (!rec.call_id) {
        firstRows.push(rec);
        continue;
      }
      if (!seen.has(rec.call_id)) {
        seen.add(rec.call_id);
        firstRows.push(rec);
      }
    }

    // Each first row may still contain a multi-entry agent_history array; keep only
    // its first element if so.
    firstRows.forEach(r => {
      if (Array.isArray(r.agent_history) && r.agent_history.length > 1) {
        r.agent_history = [r.agent_history[0]];
      }
    });

    return firstRows;
  }

  // For outbound queue reports the API returns one row but embeds full
  // queue history as an array.  Keep only the first queue_history element
  // (oldest) while leaving the full agent_history intact.
  if (report === 'queueOutboundCalls') {
    out.forEach(rec => {
      if (Array.isArray(rec.queue_history) && rec.queue_history.length > 1) {
        rec.queue_history = [rec.queue_history[0]];
      }
    });
    return out;
  }

  // Process each item in rawData
  for (const item of out) {
    if (item && typeof item === 'object') {
      // Check if this item has a 'cdrs' property (CDR-specific structure)
      if (item.cdrs && Array.isArray(item.cdrs)) {
        console.log(`🔧 Found CDR data with ${item.cdrs.length} records in 'cdrs' property`);
        
        // Process each CDR record to flatten fonoUC fields
        const processedCdrs = item.cdrs.map(cdr => {
          const processedCdr = { ...cdr };
          
          // Flatten fonoUC fields to root level
          if (cdr.fonoUC) {
            // Prioritize fonoUC.disposition over root disposition
            if (cdr.fonoUC.disposition) {
              processedCdr.disposition = cdr.fonoUC.disposition;
            }
            
            if (cdr.fonoUC.follow_up_notes) {
              processedCdr.follow_up_notes = cdr.fonoUC.follow_up_notes;
            }
            
            // Handle nested subdisposition structure
            if (cdr.fonoUC.subdisposition) {
              if (typeof cdr.fonoUC.subdisposition === 'string') {
                processedCdr.subdisposition = cdr.fonoUC.subdisposition;
              } else if (cdr.fonoUC.subdisposition.name) {
                // Check for deeply nested subdisposition
                if (cdr.fonoUC.subdisposition.subdisposition && cdr.fonoUC.subdisposition.subdisposition.name) {
                  processedCdr.subdisposition = `${cdr.fonoUC.subdisposition.name} - ${cdr.fonoUC.subdisposition.subdisposition.name}`;
                } else {
                  processedCdr.subdisposition = cdr.fonoUC.subdisposition.name;
                }
              }
            }
          }
          
          return processedCdr;
        });
        
        return processedCdrs;
      }
    }
  }

  return out;
}

/**
 * Paginated report fetcher for lazy loading/infinite scroll.
 * Fetches a limited number of records and returns pagination info.
 *
 * @param {string} report   – one of keys in ENDPOINTS.
 * @param {string} tenant   – domain / account id.
 * @param {object} params   – query params (startDate/endDate etc).
 * @param {number} limit    – maximum number of records to fetch (default: 5).
 * @param {string} startKey – pagination start key for next page.
 * @returns {Promise<{data: object[], hasMore: boolean, nextStartKey: string|null}>}
 */
export async function fetchReportPaginated(report, tenant, params = {}, limit = 5, startKey = null) {
  if (!ENDPOINTS[report]) throw new Error(`Unknown report type: ${report}`);

  const url = `${process.env.BASE_URL}${ENDPOINTS[report]}`;
  let token;
  const out = [];
  let currentStartKey = startKey;

  for (let attempt = 0, delay = 1_000; attempt < 3; attempt++, delay *= 2) {
    try {
      // Continue fetching until we have enough records or no more data
      while (out.length < limit) {
        const qs = {
          ...params,
          // Request specific fields for CDRs
          ...(report === 'cdrs' && {
            fields: [
              'call_id',
              'caller_id_number',
              'callee_id_number',
              'disposition',
              'subdisposition',
              'follow_up_notes',
              'timestamp'
            ].join(',')
          }),
          // Add specific field configurations for different report types
          ...(report === 'queueOutboundCalls' && {
            fields: [
              'called_time', 'agent_name', 'agent_ext', 'destination', 'answered_time',
              'hangup_time', 'wait_duration', 'talked_duration', 'queue_name',
              'queue_history', 'agent_history', 'agent_hangup', 'call_id', 'bleg_call_id',
              'event_timestamp', 'agent_first_name', 'agent_last_name', 'agent_extension',
              'agent_email', 'agent_talk_time', 'agent_connect_time', 'agent_action',
              'agent_transfer', 'csat', 'media_recording_id', 'recording_filename',
              'caller_id_name', 'caller_id_number', 'a_leg', 'to', 'interaction_id',
              'agent_disposition', 'agent_subdisposition1', 'agent_subdisposition2'
            ].join(',')
          }),
          ...(report === 'queueCalls' && {
            fields: [
              'called_time', 'caller_id_number', 'caller_id_name', 'answered_time',
              'hangup_time', 'wait_duration', 'talked_duration', 'queue_name', 'abandoned',
              'queue_history', 'agent_history', 'agent_attempts', 'agent_hangup',
              'call_id', 'bleg_call_id', 'event_timestamp', 'agent_first_name',
              'agent_last_name', 'agent_extension', 'agent_email', 'agent_talk_time',
              'agent_connect_time', 'agent_action', 'agent_transfer', 'csat',
              'media_recording_id', 'recording_filename', 'callee_id_number', 'a_leg',
              'interaction_id', 'agent_disposition', 'agent_subdisposition1', 'agent_subdisposition2'
            ].join(',')
          }),
          ...(currentStartKey && { start_key: currentStartKey })
        };

        // Acquire/refresh token
        token = await getPortalToken(tenant);

        console.log(`Fetching ${report} data (paginated, limit: ${limit})${currentStartKey ? ` with start_key: ${currentStartKey}` : ''}...`);
        const startTime = Date.now();

        const { data } = await axios.get(url, {
          params: qs,
          headers: {
            Authorization: `Bearer ${token}`,
            'X-User-Agent': 'portal',
            'X-Account-ID': process.env.ACCOUNT_ID_HEADER ?? tenant
          },
          httpsAgent,
          timeout: 300000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });

        const fetchTime = Date.now() - startTime;
        console.log(`✅ Paginated fetch completed in ${fetchTime}ms`);

        // Parse response data
        let chunk;
        if (Array.isArray(data.data)) {
          chunk = data.data;
        } else if (Array.isArray(data)) {
          chunk = data;
        } else if (data.rows && Array.isArray(data.rows)) {
          chunk = data.rows;
        } else if (data && typeof data === 'object') {
          // Handle object with numeric keys (CDR data structure)
          const keys = Object.keys(data);
          if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
            // This is an object with numeric keys like {"0": {record}, "1": {record}, ...}
            chunk = Object.values(data);
            console.log(`🔧 Converted object with ${keys.length} numeric keys to array`);
          } else {
            // fallback – attempt to flatten object of objects (similar to agentStatus)
            chunk = Object.entries(data).map(([k, v]) => ({ key: k, ...v }));
          }
        } else {
          chunk = [];
        }

        // Add records up to the limit
        const remainingSlots = limit - out.length;
        const recordsToAdd = chunk.slice(0, remainingSlots);
        out.push(...recordsToAdd);

        console.log(`📊 Added ${recordsToAdd.length} records (total: ${out.length}/${limit})`);

        // Check if we have more data available
        if (data.next_start_key) {
          currentStartKey = data.next_start_key;
          
          // If we've reached our limit but there's more data, return with pagination info
          if (out.length >= limit) {
            console.log(`✅ Reached limit of ${limit} records. More data available.`);
            return {
              data: out,
              hasMore: true,
              nextStartKey: currentStartKey
            };
          }
        } else {
          // No more data available
          console.log(`✅ All available data fetched. Total records: ${out.length}`);
          return {
            data: out,
            hasMore: false,
            nextStartKey: null
          };
        }
      }

      // If we exit the while loop, we've reached the limit
      return {
        data: out,
        hasMore: !!currentStartKey,
        nextStartKey: currentStartKey
      };

    } catch (err) {
      if (attempt === 2) throw err; // Last attempt
      console.warn(`Paginated report fetch failed (${err.message}); retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Fetch a single page of report data without pagination.
 * This is useful when you want to limit the response to a manageable size
 * and align data according to headers without fetching all available records.
 *
 * @param {string} report   – one of keys in ENDPOINTS.
 * @param {string} tenant   – domain / account id.
 * @param {object} params   – query params (startDate/endDate etc).
 * @param {number} limit    – maximum number of records to fetch (optional).
 * @returns {Promise<object[]>}
 */
export async function fetchReportSinglePage(report, tenant, params = {}, limit = null) {
  if (!ENDPOINTS[report]) throw new Error(`Unknown report type: ${report}`);

  const url = `${process.env.BASE_URL}${ENDPOINTS[report]}`;
  let token;

  for (let attempt = 0, delay = 1_000; attempt < MAX_RETRIES; attempt++, delay *= 2) {
    try {
      const qs = {
        ...params,
        // Add limit if specified
        ...(limit && { limit }),
        // Request specific fields for CDRs
        ...(report === 'cdrs' && {
          fields: [
            'call_id',
            'caller_id_number',
            'callee_id_number',
            'disposition',
            'subdisposition',
            'follow_up_notes',
            'timestamp'
          ].join(',')
        }),
        // Request full set of columns for queue reports
        ...(report === 'queueOutboundCalls' && {
          fields: [
            'called_time',
            'agent_name',
            'agent_ext',
            'destination',
            'answered_time',
            'hangup_time',
            'wait_duration',
            'talked_duration',
            'queue_name',
            'queue_history',
            'agent_history',
            'agent_hangup',
            'call_id',
            'bleg_call_id',
            'event_timestamp',
            'agent_first_name',
            'agent_last_name',
            'agent_extension',
            'agent_email',
            'agent_talk_time',
            'agent_connect_time',
            'agent_action',
            'agent_transfer',
            'csat',
            'media_recording_id',
            'recording_filename',
            'caller_id_name',
            'caller_id_number',
            'a_leg',
            'to',
            'interaction_id',
            'agent_disposition',
            'agent_subdisposition1',
            'agent_subdisposition2'
          ].join(',')
        }),
        // Same for inbound queue calls
        ...(report === 'queueCalls' && {
          fields: [
            'called_time',
            'caller_id_number',
            'caller_id_name',
            'answered_time',
            'hangup_time',
            'wait_duration',
            'talked_duration',
            'queue_name',
            'abandoned',
            'queue_history',
            'agent_history',
            'agent_attempts',
            'agent_hangup',
            'call_id',
            'bleg_call_id',
            'event_timestamp',
            'agent_first_name',
            'agent_last_name',
            'agent_extension',
            'agent_email',
            'agent_talk_time',
            'agent_connect_time',
            'agent_action',
            'agent_transfer',
            'csat',
            'media_recording_id',
            'recording_filename',
            'callee_id_number',
            'a_leg',
            'interaction_id',
            'agent_disposition',
            'agent_subdisposition1',
            'agent_subdisposition2'
          ].join(',')
        })
      };

      // Acquire token
      token = await getPortalToken(tenant);

      console.log(`Fetching single page of ${report} data${limit ? ` (limit: ${limit})` : ''}...`);
      const startTime = Date.now();

      const { data } = await axios.get(url, {
        params: qs,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-User-Agent': 'portal',
          'X-Account-ID': process.env.ACCOUNT_ID_HEADER ?? tenant
        },
        httpsAgent,
        timeout: 300000, // 5 minutes timeout
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      const fetchTime = Date.now() - startTime;
      console.log(`✅ Single page fetch completed in ${fetchTime}ms`);

      let records = [];
      
      // Handle different response structures
      let rawData;
      if (Array.isArray(data.data)) {
        rawData = data.data;
      } else if (Array.isArray(data)) {
        rawData = data;
      } else if (data.rows && Array.isArray(data.rows)) {
        rawData = data.rows;
      } else if (data && typeof data === 'object') {
        // Handle object with numeric keys (CDR data structure)
        const keys = Object.keys(data);
        if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
          rawData = Object.values(data);
          console.log(`🔧 Converted object with ${keys.length} numeric keys to array`);
        } else {
          rawData = [data]; // Wrap single object in array
        }
      } else {
        rawData = [];
      }

      // Process each item in rawData
      for (const item of rawData) {
        if (item && typeof item === 'object') {
          // Check if this item has a 'cdrs' property (CDR-specific structure)
          if (item.cdrs && Array.isArray(item.cdrs)) {
            console.log(`🔧 Found CDR data with ${item.cdrs.length} records in 'cdrs' property`);
            
            // Process each CDR record to flatten fonoUC fields
            const processedCdrs = item.cdrs.map(cdr => {
              const processedCdr = { ...cdr };
              
              // Flatten fonoUC fields to root level
              if (cdr.fonoUC) {
                // Prioritize fonoUC.disposition over root disposition
                if (cdr.fonoUC.disposition) {
                  processedCdr.disposition = cdr.fonoUC.disposition;
                }
                
                if (cdr.fonoUC.follow_up_notes) {
                  processedCdr.follow_up_notes = cdr.fonoUC.follow_up_notes;
                }
                
                // Handle nested subdisposition structure
                if (cdr.fonoUC.subdisposition) {
                  if (typeof cdr.fonoUC.subdisposition === 'string') {
                    processedCdr.subdisposition = cdr.fonoUC.subdisposition;
                  } else if (cdr.fonoUC.subdisposition.name) {
                    // Check for deeply nested subdisposition
                    if (cdr.fonoUC.subdisposition.subdisposition && cdr.fonoUC.subdisposition.subdisposition.name) {
                      processedCdr.subdisposition = `${cdr.fonoUC.subdisposition.name} - ${cdr.fonoUC.subdisposition.subdisposition.name}`;
                    } else {
                      processedCdr.subdisposition = cdr.fonoUC.subdisposition.name;
                    }
                  }
                }
              }
              
              return processedCdr;
            });
            
            records.push(...processedCdrs);
            continue;
          }
          
          const itemKeys = Object.keys(item);
          
          // Check if this item has numeric keys (contains nested records)
          if (itemKeys.length > 0 && itemKeys.every(k => /^\d+$/.test(k))) {
            // This item contains nested records with numeric keys
            const nestedRecords = Object.values(item);
            console.log(`🔧 Flattening item with ${nestedRecords.length} nested records`);
            records.push(...nestedRecords);
          } else {
            // This is a regular record
            records.push(item);
          }
        } else {
          // Handle primitive values or null
          records.push(item);
        }
      }

      console.log(`📊 Fetched ${records.length} records (single page, flattened)`);
      return records;

    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      console.warn(`Single page fetch failed (${err.message}); retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Fetches multiple pages of data to overcome the 500 record API limit.
 * Uses time-based slicing when offset pagination fails.
 * 
 * @param {string} report    – report type (e.g., 'cdrs', 'queueCalls').
 * @param {string} tenant    – account/tenant ID.
 * @param {object} params    – query parameters (startDate, endDate, etc.).
 * @param {number} totalLimit – total number of records desired.
 * @returns {Promise<Array>} – combined array of records from all pages.
 */
export async function fetchReportMultiPage(report, tenant, params = {}, totalLimit = 1000) {
  console.log(`🔄 Starting multi-page fetch for ${report} (target: ${totalLimit} records)`);
  
  const allRecords = [];
  const seenRecords = new Set(); // Track unique records to prevent duplicates
  const pageSize = 500; // API's maximum per request
  let currentOffset = 0;
  let hasMoreData = true;
  let pageCount = 0;
  let consecutiveEmptyPages = 0;
  let consecutiveDuplicatePages = 0;
  
  // First, try standard offset-based pagination
  while (allRecords.length < totalLimit && hasMoreData && pageCount < 5) { // Limit initial attempts
    pageCount++;
    console.log(`📄 Fetching page ${pageCount} (offset: ${currentOffset}, unique records so far: ${allRecords.length})`);
    
    try {
      // Add offset parameter for pagination
      const pageParams = {
        ...params,
        limit: Math.min(pageSize, totalLimit - allRecords.length),
        offset: currentOffset
      };
      
      const pageData = await fetchReportSinglePage(report, tenant, pageParams, pageParams.limit);
      
      if (!pageData || pageData.length === 0) {
        console.log(`📄 Page ${pageCount}: No more data available`);
        consecutiveEmptyPages++;
        if (consecutiveEmptyPages >= 2) {
          hasMoreData = false;
          break;
        }
        currentOffset += pageSize;
        continue;
      }
      
      // Reset consecutive empty pages counter
      consecutiveEmptyPages = 0;
      
      // Deduplicate records using call_id or a combination of fields
      let newRecords = 0;
      let duplicateRecords = 0;
      
      for (const record of pageData) {
        // Create a unique identifier for each record
        let recordId;
        if (record.call_id) {
          recordId = record.call_id;
        } else {
          // Fallback: use combination of available fields
          recordId = `${record.caller_id_number || ''}_${record.callee_id_number || ''}_${record.timestamp || ''}_${record.called_time || ''}`;
        }
        
        if (!seenRecords.has(recordId)) {
          seenRecords.add(recordId);
          allRecords.push(record);
          newRecords++;
        } else {
          duplicateRecords++;
        }
      }
      
      console.log(`📄 Page ${pageCount}: Retrieved ${pageData.length} records (${newRecords} new, ${duplicateRecords} duplicates)`);
      
      // If we got no new records, the API might not support offset pagination
      if (newRecords === 0) {
        consecutiveDuplicatePages++;
        console.log(`📄 Page ${pageCount}: No new records found (${consecutiveDuplicatePages} consecutive duplicate pages)`);
        
        if (consecutiveDuplicatePages >= 2) {
          console.log(`⚠️ API doesn't support offset pagination. Switching to time-based slicing...`);
          break;
        }
      } else {
        consecutiveDuplicatePages = 0;
      }
      
      // If we got less than the page size, we've reached the end
      if (pageData.length < pageSize) {
        console.log(`📄 Page ${pageCount}: Reached end of data (got ${pageData.length} < ${pageSize})`);
        hasMoreData = false;
      }
      
      currentOffset += pageData.length;
      
      // Small delay between requests to be respectful to the API
      if (hasMoreData && allRecords.length < totalLimit) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
    } catch (error) {
      console.error(`❌ Error fetching page ${pageCount}:`, error.message);
      
      // If it's the first page, re-throw the error
      if (pageCount === 1) {
        throw error;
      }
      
      // For subsequent pages, log the error but continue with what we have
      console.log(`⚠️ Continuing with ${allRecords.length} records from previous pages`);
      hasMoreData = false;
    }
  }
  
  // If we still need more records and have time range parameters, try time-based slicing
  if (allRecords.length < totalLimit && (consecutiveDuplicatePages >= 1 || (pageCount >= 2 && allRecords.length === 500)) && params.startDate && params.endDate) {
    console.log(`🕐 Attempting time-based slicing to get more records...`);
    console.log(`🕐 Conditions: records=${allRecords.length}, target=${totalLimit}, duplicatePages=${consecutiveDuplicatePages}, hasTimeRange=${!!(params.startDate && params.endDate)}`);
    
    const timeSliceRecords = await fetchWithTimeSlicing(report, tenant, params, totalLimit - allRecords.length, seenRecords);
    
    // Add new unique records from time slicing
    let addedFromTimeSlicing = 0;
    for (const record of timeSliceRecords) {
      let recordId;
      if (record.call_id) {
        recordId = record.call_id;
      } else {
        recordId = `${record.caller_id_number || ''}_${record.callee_id_number || ''}_${record.timestamp || ''}_${record.called_time || ''}`;
      }
      
      if (!seenRecords.has(recordId)) {
        seenRecords.add(recordId);
        allRecords.push(record);
        addedFromTimeSlicing++;
      }
    }
    
    console.log(`🕐 Time-based slicing added ${addedFromTimeSlicing} new unique records`);
  } else {
    console.log(`🕐 Time-based slicing not triggered:`);
    console.log(`   - Records: ${allRecords.length}/${totalLimit}`);
    console.log(`   - Consecutive duplicate pages: ${consecutiveDuplicatePages}`);
    console.log(`   - Has time range: ${!!(params.startDate && params.endDate)}`);
  }
  
  console.log(`✅ Multi-page fetch completed: ${allRecords.length} unique records from ${pageCount} pages (${seenRecords.size} total unique IDs tracked)`);
  return allRecords.slice(0, totalLimit); // Ensure we don't exceed the requested limit
}

/**
 * Attempts to fetch more records by slicing the time range into smaller chunks.
 * This is used when offset-based pagination doesn't work.
 */
async function fetchWithTimeSlicing(report, tenant, params, remainingLimit, seenRecords) {
  console.log(`🕐 Starting time-based slicing for ${remainingLimit} more records`);
  
  const startTime = parseInt(params.startDate);
  const endTime = parseInt(params.endDate);
  const totalDuration = endTime - startTime;
  
  // Split into 4-hour chunks (14400 seconds)
  const chunkDuration = Math.min(14400, Math.floor(totalDuration / 4));
  const chunks = [];
  
  for (let chunkStart = startTime; chunkStart < endTime; chunkStart += chunkDuration) {
    const chunkEnd = Math.min(chunkStart + chunkDuration, endTime);
    chunks.push({ startDate: chunkStart, endDate: chunkEnd });
  }
  
  console.log(`🕐 Created ${chunks.length} time chunks of ~${chunkDuration/3600} hours each`);
  
  const timeSliceRecords = [];
  
  for (let i = 0; i < chunks.length && timeSliceRecords.length < remainingLimit; i++) {
    const chunk = chunks[i];
    console.log(`🕐 Fetching chunk ${i + 1}/${chunks.length}: ${new Date(chunk.startDate * 1000).toISOString()} to ${new Date(chunk.endDate * 1000).toISOString()}`);
    
    try {
      const chunkParams = {
        ...params,
        startDate: chunk.startDate,
        endDate: chunk.endDate,
        limit: 500 // API max
      };
      
      const chunkData = await fetchReportSinglePage(report, tenant, chunkParams, 500);
      
      if (chunkData && chunkData.length > 0) {
        console.log(`🕐 Chunk ${i + 1}: Retrieved ${chunkData.length} records`);
        timeSliceRecords.push(...chunkData);
      } else {
        console.log(`🕐 Chunk ${i + 1}: No data`);
      }
      
      // Small delay between chunk requests
      await new Promise(resolve => setTimeout(resolve, 200));
      
    } catch (error) {
      console.error(`❌ Error fetching time chunk ${i + 1}:`, error.message);
      // Continue with other chunks
    }
  }
  
  console.log(`🕐 Time-based slicing completed: ${timeSliceRecords.length} additional records`);
  return timeSliceRecords;
}

/**
 * Enhanced single page fetch that tries different pagination parameters
 * if the API supports them.
 */
export async function fetchReportSinglePageEnhanced(report, tenant, params = {}, limit = null) {
  // First try with different pagination parameter names that the API might support
  const paginationAttempts = [
    { ...params, ...(limit && { limit }) },
    { ...params, ...(limit && { size: limit }) },
    { ...params, ...(limit && { count: limit }) },
    { ...params, ...(limit && { max_results: limit }) },
    { ...params, ...(limit && { per_page: limit }) }
  ];
  
  for (let i = 0; i < paginationAttempts.length; i++) {
    try {
      console.log(`🔍 Trying pagination attempt ${i + 1} with params:`, paginationAttempts[i]);
      const result = await fetchReportSinglePage(report, tenant, paginationAttempts[i], limit);
      
      if (result && result.length > 500) {
        console.log(`✅ Success with pagination attempt ${i + 1}: got ${result.length} records`);
        return result;
      } else if (i === 0) {
        // If the first attempt (standard limit) gives us ≤500 records, 
        // and we want more, continue trying other parameters
        if (limit && limit > 500) {
          console.log(`🔄 Standard limit gave ${result.length} records, trying other pagination parameters...`);
          continue;
        } else {
          // If we only wanted ≤500 records, return the result
          return result;
        }
      }
    } catch (error) {
      console.log(`❌ Pagination attempt ${i + 1} failed:`, error.message);
      if (i === paginationAttempts.length - 1) {
        throw error; // Re-throw if all attempts failed
      }
    }
  }
  
  // If all single-page attempts failed to get more than 500 records,
  // fall back to the original result
  return await fetchReportSinglePage(report, tenant, params, limit);
}

/**
 * Minimal CLI: node -r dotenv/config reportFetcher.js <report> <tenant> <startISO> <endISO> [outfile]
 */
async function cli() {
  const [,, report, tenant, startIso, endIso, outFile] = process.argv;
  if (!report || !tenant) {
    console.error('Usage: node -r dotenv/config reportFetcher.js <report> <tenant> [startISO] [endISO] [outfile.{csv|json}]');
    console.error(`report = ${Object.keys(ENDPOINTS).join(' | ')}`);
    process.exit(1);
  }
  const params = {};
  if (startIso) {
    const startDate = Date.parse(startIso);
    if (Number.isNaN(startDate)) throw new Error('Invalid start date');
    params.startDate = Math.floor(startDate / 1000);
  }
  if (endIso) {
    const endDate = Date.parse(endIso);
    if (Number.isNaN(endDate)) throw new Error('Invalid end date');
    params.endDate = Math.floor(endDate / 1000);
  }

  const data = await fetchReport(report, tenant, params);
  console.log(`Fetched ${data.length} rows for ${report}`);

  if (outFile) {
    await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
    if (outFile.endsWith('.csv')) {
      // Use CDR-specific flattening for CDR reports
      const csvData = report === 'cdrs' ? flattenCdrForCsv(data) : data;
      await fs.promises.writeFile(outFile, toCsv(csvData));
    } else {
      await fs.promises.writeFile(outFile, JSON.stringify(data, null, 2));
    }
    console.log(`Saved to ${outFile}`);
  } else {
    console.table(data);
  }
}

if (import.meta.url === process.argv[1] || import.meta.url === `file://${process.argv[1]}`) {
  cli().catch(err => {
    console.error(err.response?.data || err.stack || err.message);
    process.exit(1);
  });
}

// Convenience wrappers
export const fetchCdrs = (tenant, opts) => fetchReport('cdrs', tenant, opts);
export const fetchQueueCalls = (tenant, opts) => fetchReport('queueCalls', tenant, opts);
export const fetchQueueOutboundCalls = (tenant, opts) => fetchReport('queueOutboundCalls', tenant, opts);
export const fetchCampaignsActivity = (tenant, opts) => fetchReport('campaignsActivity', tenant, opts);
