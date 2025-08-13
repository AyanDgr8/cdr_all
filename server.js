// server.js

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
// import { fetchAgentStatus } from './agentStatus.js';
import { fetchReport, fetchReportPaginated, fetchReportSinglePage, fetchReportMultiPage, fetchReportSinglePageEnhanced } from './reportFetcher.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5555;
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 ensures the server binds to all network interfaces
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// Helper to resolve __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, 'public')));

// GET /api/reports/:type?account=<tenant>&start=<ISO>&end=<ISO>
app.get('/api/reports/:type', async (req, res) => {
  const { type } = req.params;
  const { account, start, end, limit } = req.query;

  if (!account) {
    return res.status(400).json({ error: 'Missing account query param' });
  }

  const params = {};
  if (start) {
    const startDate = Date.parse(start);
    if (Number.isNaN(startDate)) {
      return res.status(400).json({ error: 'Invalid start date' });
    }
    params.startDate = Math.floor(startDate / 1000);
  }
  if (end) {
    const endDate = Date.parse(end);
    if (Number.isNaN(endDate)) {
      return res.status(400).json({ error: 'Invalid end date' });
    }
    params.endDate = Math.floor(endDate / 1000);
  }

  // Parse and validate limit parameter
  let recordLimit = null;
  if (limit) {
    recordLimit = parseInt(limit, 10);
    if (Number.isNaN(recordLimit) || recordLimit < 1) {
      return res.status(400).json({ error: 'Invalid limit parameter. Must be a positive integer.' });
    }
    // Set a reasonable maximum to prevent server overload
    if (recordLimit > 10000) {
      recordLimit = 10000;
      console.log(`Limit capped at 10000 records for performance reasons`);
    }
  }

  // Debug: log exactly what we are about to request
  console.log('fetchReportSinglePage payload', {
    type,
    account,
    params,
    limit: recordLimit
  });

  try {
    let data;
    
    if (recordLimit && recordLimit > 500) {
      // Use multi-page fetching for limits > 500
      console.log(`🔄 Using multi-page fetch for ${recordLimit} records`);
      data = await fetchReportMultiPage(type, account, params, recordLimit);
    } else {
      // Use single page fetch for limits ≤ 500 or no limit
      console.log(`📄 Using single page fetch${recordLimit ? ` for ${recordLimit} records` : ''}`);
      data = await fetchReportSinglePageEnhanced(type, account, params, recordLimit);
    }
    
    // Add metadata about the fetch
    const response = {
      data,
      total: data.length,
      limit: recordLimit,
      hasMore: recordLimit && data.length >= recordLimit,
      fetchMethod: recordLimit && recordLimit > 500 ? 'multi-page' : 'single-page'
    };
    
    console.log(`✅ Successfully fetched ${data.length} records${recordLimit ? ` (limit: ${recordLimit})` : ''} using ${response.fetchMethod} method`);
    res.json(response);
  } catch (err) {
    console.error('Report fetch error:', err.message);
    res.status(500).json({ 
      error: 'Failed to fetch report', 
      details: err.message,
      type,
      account,
      params,
      limit: recordLimit
    });
  }
});

// GET /api/reports/:type/paginated?account=<tenant>&start=<ISO>&end=<ISO>&limit=<number>&startKey=<string>
app.get('/api/reports/:type/paginated', async (req, res) => {
  const { type } = req.params;
  const { account, start, end, limit = 5, startKey } = req.query;

  if (!account) {
    return res.status(400).json({ error: 'Missing account query param' });
  }

  const params = {};
  if (start) {
    const startDate = Date.parse(start);
    if (Number.isNaN(startDate)) {
      return res.status(400).json({ error: 'Invalid start date' });
    }
    params.startDate = Math.floor(startDate / 1000);
  }
  if (end) {
    const endDate = Date.parse(end);
    if (Number.isNaN(endDate)) {
      return res.status(400).json({ error: 'Invalid end date' });
    }
    params.endDate = Math.floor(endDate / 1000);
  }

  // Debug: log exactly what we are about to request
  console.log('fetchReportPaginated payload', {
    type,
    account,
    startDate: params.startDate,
    endDate: params.endDate,
    limit: parseInt(limit),
    startKey
  });

  try {
    const result = await fetchReportPaginated(type, account, params, parseInt(limit), startKey);
    
    // Process the data similar to the original endpoint
    let processedData;
    if (type === 'cdrs') {
      // Handle the special case where data is an array containing one object with numeric keys
      let cdrRecords = [];
      if (result.data.length === 1 && result.data[0] && typeof result.data[0] === 'object') {
        const firstItem = result.data[0];
        const keys = Object.keys(firstItem);
        
        // Check if this is the numeric-keyed object structure
        if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
          console.log(`🔧 Converting single object with ${keys.length} numeric keys to ${keys.length} CDR records`);
          cdrRecords = Object.values(firstItem);
        } else {
          cdrRecords = result.data;
        }
      } else {
        cdrRecords = result.data;
      }
      
      processedData = cdrRecords.map(row => {
        // Extract only the specific fields requested based on actual CDR structure
        const filteredRow = {
          call_id: row.call_id || row._id || row.id || row.bridge_id || '',
          caller_id_number: row.caller_id_number || row.from || '',
          callee_id_number: row.callee_id_number || row.to || '',
          call_direction: row.call_direction || '',
          disposition: row.fonoUC?.disposition || row.disposition || row.hangup_cause || '',
          subdisposition: (() => {
            // Handle nested subdisposition structure
            const fonoSub = row.fonoUC?.subdisposition;
            if (fonoSub?.name && fonoSub?.subdisposition?.name) {
              return `${fonoSub.name} - ${fonoSub.subdisposition.name}`;
            }
            return fonoSub?.name || row.subdisposition || '';
          })(),
          follow_up_notes: row.fonoUC?.follow_up_notes || row.follow_up_notes || '',
          timestamp: (() => {
            // Handle timestamp conversion - try multiple timestamp fields
            const ts = row.timestamp || row.created || row.pvt_created || row.interaction_time;
            if (ts && typeof ts === 'number') {
              // Convert epoch timestamp to readable format
              const ms = ts > 10_000_000_000 ? ts : ts * 1000;
              return new Date(ms).toISOString();
            }
            return ts || '';
          })()
        };
        
        // Debug: Log fonoUC data for first few records
        if (processedData.length < 3 && row.fonoUC) {
          console.log(`🔍 CDR ${row.call_id || row._id} has fonoUC data:`, {
            disposition: row.fonoUC.disposition,
            subdisposition: row.fonoUC.subdisposition,
            follow_up_notes: row.fonoUC.follow_up_notes
          });
        }
        
        return filteredRow;
      }).filter(record => {
        // Only include records that have a disposition value
        return record.disposition && record.disposition.trim() !== '';
      });
      
      console.log(`📊 Total CDR records before disposition filter: ${cdrRecords.length}`);
      console.log(`📊 CDR records with disposition: ${processedData.length}`);
      
      // Debug: Log first filtered record
      if (processedData.length > 0) {
        console.log('🔍 First filtered CDR record:');
        console.log(JSON.stringify(processedData[0], null, 2));
      }
    } else {
      processedData = result.data.map(row => {
        // Ensure agent_history is an array
        let history = row.agent_history;
        if (typeof history === 'string') {
          try { history = JSON.parse(history); } catch { history = []; }
        }

        let ts = row.answered_time;
        if (!ts && Array.isArray(history)) {
          const answerEvt = history.find(e => e.event === 'answer' || e.connected);
          if (answerEvt?.last_attempt) {
            const ms = answerEvt.last_attempt > 10_000_000_000 ? answerEvt.last_attempt : answerEvt.last_attempt * 1000;
            ts = new Date(ms).toISOString();
          }
        }
        return { ...row, answered_time: ts ?? '--' };
      });
    }

    res.json({ 
      data: processedData,
      hasMore: result.hasMore,
      nextStartKey: result.nextStartKey,
      totalFetched: processedData.length
    });
  } catch (err) {
    console.error(err.response?.data || err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Web app running at ${PUBLIC_URL}`);
});
