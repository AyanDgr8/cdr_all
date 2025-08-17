// script.js

/* global axios */
const form = document.getElementById('filterForm');
const loadingEl = document.getElementById('loading');
const errorBox = document.getElementById('errorBox');
const table = document.getElementById('resultTable');
const fetchBtn = document.getElementById('fetchBtn');
const filtersGrid = document.getElementById('filtersGrid');
const statsEl = document.getElementById('stats');
let tenantAccount; // Global variable for recording URL construction

// Store original data for filtering
let originalData = [];
let filteredData = [];
let activeFilters = {};

// Columns whose raw value should NEVER be interpreted as epoch or duration
const RAW_COLUMNS = new Set([
  'caller_id_number',
  'caller_id_name',
  'callee_id_number',
  'callee_id_name',
  'caller_id_lead_name',
  'callee_id_lead_number',
  'agent_ext',
  'lead_number',
  'agent_extension',
  'extension',
  'ext',
  'to'
]);

// Columns that are durations in seconds
const DURATION_COLUMNS = new Set([
  'wait_duration',
  'talk_duration'
]);

function show(el) { el.classList.remove('is-hidden'); }
function hide(el) { el.classList.add('is-hidden'); }

// Convert seconds → HH:MM:SS or D days HH:MM:SS
function secondsToHMS(sec) {
  const total = parseInt(sec, 10);
  if (Number.isNaN(total)) return sec;
  const days = Math.floor(total / 86400);
  const rem = total % 86400;
  const h = Math.floor(rem / 3600).toString().padStart(2, '0');
  const m = Math.floor((rem % 3600) / 60).toString().padStart(2, '0');
  const s = (rem % 60).toString().padStart(2, '0');
  return days ? `${days} day${days > 1 ? 's' : ''} ${h}:${m}:${s}` : `${h}:${m}:${s}`;
}

function isoToLocal(dateStr) {
  // Always display Dubai Time (Asia/Dubai) irrespective of client or server TZ
  return new Date(dateStr).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' });
}

/**
 * Extract country name from a phone number
 * @param {string} phoneNumber - The phone number to parse
 * @returns {string} - Country name or empty string if not found
 */
function extractCountryFromPhoneNumber(phoneNumber) {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return '';
  }

  try {
    // Clean the phone number
    let cleanNumber = phoneNumber.replace(/[^\d+]/g, '');
    
    // Skip very short numbers
    if (!cleanNumber.startsWith('+')) {
      cleanNumber = cleanNumber.replace(/^0+/, '');
    }
    if (cleanNumber.length <= 4) {
      return '';
    }

    // Manual checks for common patterns first (for performance)
    if (cleanNumber.match(/^(971|00971|\+971)/)) {
      return 'UAE';
    }
    if (cleanNumber.match(/^(91|0091|\+91)/)) {
      return 'India';
    }
    if (cleanNumber.match(/^(20|0020|\+20)/)) {
      return 'Egypt';
    }
    if (cleanNumber.match(/^(44|0044|\+44)/)) {
      return 'United Kingdom';
    }

    // Normalize the number format for libphonenumber-js
    if (cleanNumber.startsWith('00')) {
      cleanNumber = '+' + cleanNumber.substring(2);
    } else if (cleanNumber.startsWith('0') && cleanNumber.length > 10) {
      cleanNumber = '+' + cleanNumber.substring(1);
    } else if (!cleanNumber.startsWith('+') && cleanNumber.length > 10) {
      cleanNumber = '+' + cleanNumber;
    }

    // Debug logging
    console.log('Parsing phone number:', cleanNumber);

    // Check if libphonenumber is available
    if (typeof libphonenumber === 'undefined') {
      console.warn('libphonenumber-js library not loaded');
      return '';
    }

    // Parse the phone number using libphonenumber-js
    const phoneNumberObj = libphonenumber.parsePhoneNumber(cleanNumber);
    
    if (phoneNumberObj && phoneNumberObj.country) {
      const countryCode = phoneNumberObj.country;
      console.log('Extracted country code:', countryCode);
      
      // Map common country codes to names
      const countryNames = {
        'AE': 'UAE',
        'IN': 'India', 
        'GB': 'United Kingdom',
        'US': 'United States',
        'CA': 'Canada',
        'AU': 'Australia',
        'DE': 'Germany',
        'FR': 'France',
        'IT': 'Italy',
        'ES': 'Spain',
        'NL': 'Netherlands',
        'BE': 'Belgium',
        'CH': 'Switzerland',
        'AT': 'Austria',
        'SE': 'Sweden',
        'NO': 'Norway',
        'DK': 'Denmark',
        'FI': 'Finland',
        'PL': 'Poland',
        'CZ': 'Czech Republic',
        'HU': 'Hungary',
        'RO': 'Romania',
        'BG': 'Bulgaria',
        'HR': 'Croatia',
        'SI': 'Slovenia',
        'SK': 'Slovakia',
        'LT': 'Lithuania',
        'LV': 'Latvia',
        'EE': 'Estonia',
        'IE': 'Ireland',
        'PT': 'Portugal',
        'GR': 'Greece',
        'TR': 'Turkey',
        'RU': 'Russia',
        'JP': 'Japan',
        'KR': 'South Korea',
        'CN': 'China',
        'SG': 'Singapore',
        'MY': 'Malaysia',
        'TH': 'Thailand',
        'ID': 'Indonesia',
        'PH': 'Philippines',
        'VN': 'Vietnam',
        'BD': 'Bangladesh',
        'PK': 'Pakistan',
        'LK': 'Sri Lanka',
        'NP': 'Nepal',
        'AF': 'Afghanistan',
        'IR': 'Iran',
        'IQ': 'Iraq',
        'SA': 'Saudi Arabia',
        'KW': 'Kuwait',
        'QA': 'Qatar',
        'BH': 'Bahrain',
        'OM': 'Oman',
        'JO': 'Jordan',
        'LB': 'Lebanon',
        'SY': 'Syria',
        'IL': 'Israel',
        'EG': 'Egypt',
        'LY': 'Libya',
        'TN': 'Tunisia',
        'DZ': 'Algeria',
        'MA': 'Morocco',
        'ZA': 'South Africa',
        'NG': 'Nigeria',
        'KE': 'Kenya',
        'GH': 'Ghana',
        'ET': 'Ethiopia',
        'UG': 'Uganda',
        'TZ': 'Tanzania',
        'ZW': 'Zimbabwe',
        'BW': 'Botswana',
        'ZM': 'Zambia',
        'MW': 'Malawi',
        'MZ': 'Mozambique',
        'MG': 'Madagascar',
        'MU': 'Mauritius',
        'SC': 'Seychelles',
        'BR': 'Brazil',
        'AR': 'Argentina',
        'CL': 'Chile',
        'CO': 'Colombia',
        'PE': 'Peru',
        'VE': 'Venezuela',
        'UY': 'Uruguay',
        'PY': 'Paraguay',
        'BO': 'Bolivia',
        'EC': 'Ecuador',
        'GY': 'Guyana',
        'SR': 'Suriname',
        'MX': 'Mexico',
        'GT': 'Guatemala',
        'BZ': 'Belize',
        'SV': 'El Salvador',
        'HN': 'Honduras',
        'NI': 'Nicaragua',
        'CR': 'Costa Rica',
        'PA': 'Panama',
        'CU': 'Cuba',
        'JM': 'Jamaica',
        'HT': 'Haiti',
        'DO': 'Dominican Republic',
        'TT': 'Trinidad and Tobago',
        'BB': 'Barbados',
        'GD': 'Grenada',
        'LC': 'Saint Lucia',
        'VC': 'Saint Vincent and the Grenadines',
        'AG': 'Antigua and Barbuda',
        'KN': 'Saint Kitts and Nevis',
        'DM': 'Dominica',
        'BS': 'Bahamas',
        'BM': 'Bermuda'
      };
      
      return countryNames[countryCode] || countryCode;
    } else {
      console.log('No country found for number:', cleanNumber);
    }
    
  } catch (error) {
    const cleanNum = phoneNumber.replace(/[\D]/g, '');
    if (cleanNum.length > 4) {
      console.warn(`Failed to parse phone number: ${phoneNumber}`, error.message);
    }
  }
  
  return '';
}

function inputToDubaiIso(val) {
  if (!val) return '';
  const [datePart, timePart = '00:00'] = val.split('T'); // "YYYY-MM-DD" & "HH:MM"
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  // Asia/Dubai is UTC+4 with no daylight saving; subtract 4 h to get UTC.
  const utcMillis = Date.UTC(year, month - 1, day, hour - 4, minute);
  return new Date(utcMillis).toISOString();
}

function renderTable(data) {
  if (!data || !data.data) {
    table.innerHTML = '<caption>No data received from server.</caption>';
    hide(statsEl);
    return;
  }

  if (!data.data.length) {
    table.innerHTML = '<caption>No results for selected range.</caption>';
    hide(statsEl);
    return;
  }

  // Store original data for filtering with added index and transformed fields
  originalData = data.data.map((record, index) => {
    const transformedRecord = {
      ...record,
      row_index: index + 1 // Add 1-based indexing
    };

    // Transform and map fields for CDR display
    if (document.getElementById('reportType').value === 'cdrs') {
      // Map API fields to display fields
      transformedRecord.s_no = index + 1; // S. No
      transformedRecord.type_direction = record.call_direction || 'Internal outbound'; // Type/Direction
      transformedRecord.called_time = record.channel_created_time || ''; // Called Time
      transformedRecord.queue_name = extractQueueName(record); // Queue Name
      transformedRecord.campaign_name = extractCampaignName(record); // Campaign Name
      transformedRecord.caller_id_number = record.caller_id_number; // Caller ID Number
      transformedRecord.caller_id_name = record.caller_id_name; // Caller ID/Lead Name
      transformedRecord.answered_time = calculateAnsweredTime(record); // Answered Time
      transformedRecord.hangup_time = calculateHangupTime(record); // Hangup Time
      transformedRecord.wait_duration = Number(record.ringing_seconds) || 0; // Wait Duration
      transformedRecord.talk_duration = Number(record.billing_seconds) || 0; // Talk Duration
      transformedRecord.agent_disposition = record.disposition; // Agent Disposition
      transformedRecord.sub_disposition_1 = extractSubDisposition1(record); // Sub-disposition 1
      transformedRecord.sub_disposition_2 = extractSubDisposition2(record); // Sub-disposition 2
      transformedRecord.callee_id_lead_number = record.callee_id_number; // Callee ID/Lead Number
      transformedRecord.status = mapStatus(record); // Status
      transformedRecord.campaign_type = extractCampaignType(record); // Campaign Type
      transformedRecord.agent_history = record.agent_history; // Agent History
      transformedRecord.queue_history = record.queue_history; // Queue History
      transformedRecord.recording = extractRecording(record); // Recording
      transformedRecord.agent_name = extractAgentName(record); // Agent Name
      transformedRecord.extension = extractExtension(record); // Extension
      transformedRecord.country = extractCountryFromPhoneNumber(record.caller_id_number || record.callee_id_number); // Country
      transformedRecord.follow_up_notes = record.follow_up_notes || ''; // Follow-up Notes

      // Calculate talked duration if not present
      if (!transformedRecord.talk_duration && transformedRecord.hangup_time && transformedRecord.answered_time) {
        transformedRecord.talk_duration = transformedRecord.hangup_time - transformedRecord.answered_time;
      }

      // Calculate wait/queue duration if not present
      if (!transformedRecord.wait_duration && transformedRecord.called_time) {
        if (transformedRecord.answered_time) {
          transformedRecord.wait_duration = transformedRecord.answered_time - transformedRecord.called_time;
        } else if (transformedRecord.hangup_time) {
          transformedRecord.wait_duration = transformedRecord.hangup_time - transformedRecord.called_time;
        }
      }
    }

    return transformedRecord;
  });

  // Filter and deduplicate for CDR reports
  if (document.getElementById('reportType').value === 'cdrs') {
    // Group by caller_id_number and callee_id_number combination to remove duplicates
    const phoneGroups = new Map();
    originalData.forEach(record => {
      const callerKey = record.caller_id_number || '';
      const calleeKey = record.callee_id_number || '';
      const groupKey = `${callerKey}|${calleeKey}`;
      
      // Only keep the first occurrence of each combination
      if (!phoneGroups.has(groupKey)) {
        phoneGroups.set(groupKey, record);
      }
    });

    // Convert back to array with only first occurrences
    originalData = Array.from(phoneGroups.values());

    // Re-index the filtered data
    originalData = originalData.map((record, index) => ({
      ...record,
      s_no: index + 1,
      row_index: index + 1
    }));
  }

  // Initialize filteredData to originalData
  filteredData = [...originalData];

  // For CDRs, only show the specific fields we requested
  const reportType = document.getElementById('reportType').value;
  let cols;
  
  if (reportType === 'cdrs') {
    cols = [
      's_no',
      'type_direction',
      'queue_name',
      'campaign_name',
      'called_time',
      'caller_id_number',
      'caller_id_name',
      'callee_id_number',
      'callee_id_name',
      'answered_time',
      'hangup_time',
      'wait_duration',
      'talk_duration',
      'agent_disposition',
      'sub_disposition_1',
      'sub_disposition_2',
      'follow_up_notes',
      'status',
      'campaign_type',
      'agent_history',
      'queue_history',
      'recording',
      'agent_name',
      'extension',
      'country',
      'call_id'
    ];
  } else {
    const originalCols = Object.keys(originalData[0] || {});
    cols = ['row_index', ...originalCols.filter(col => col !== 'row_index')];
  }

  // Generate search filters based on columns
  generateSearchFilters(cols, originalData);
  
  // Apply any existing filters (this will update filteredData and stats)
  applyFilters();
}

function renderTableData(cols, data) {
  if (!data.length) {
    table.innerHTML = '<caption>No results match the current filters.</caption>';
    return;
  }

  const thead = `<thead><tr>${cols.map(c => {
    let displayName;
    if (c === 's_no') {
      displayName = 'S.No';
    } else if (c === 'type_direction') {
      displayName = 'Type/Direction';
    } else if (c === 'queue_name') {
      displayName = 'Queue Name';
    } else if (c === 'campaign_name') {
      displayName = 'Campaign Name';
    } else if (c === 'caller_id_number') {
      displayName = 'Caller ID Number';
    } else if (c === 'caller_id_name') {
      displayName = 'Caller ID Name';
    } else if (c === 'callee_id_number') {
      displayName = 'Callee ID Number';
    } else if (c === 'callee_id_name') {
      displayName = 'Callee ID Name';
    } else if (c === 'sub_disposition_1') {
      displayName = 'Sub-disposition 1';
    } else if (c === 'sub_disposition_2') {
      displayName = 'Sub-disposition 2';
    } else if (c === 'follow_up_notes') {
      displayName = 'Follow-up Notes';
    } else {
      displayName = c.replace(/_/g, ' ').toUpperCase();
    }
    return `<th${c === 's_no' ? ' style="width: 60px; text-align: center;"' : ''}>${displayName}</th>`;
  }).join('')}</tr></thead>`;
  
  const tbody = `<tbody>${data
    .map(row => {
      return '<tr>' + cols.map(c => {
        let v = row[c];
        if (v == null) v = '';

        // Special handling for row_index
        if (c === 'row_index') {
          return `<td style="text-align: center; font-weight: bold; background-color: #f8f9fa;">${v}</td>`;
        }

        // Special handling for s_no (S. No) column - should always show as raw number
        if (c === 's_no') {
          return `<td style="text-align: center; font-weight: bold; background-color: #f8f9fa;">${v}</td>`;
        }

        // Skip any transformation for specific columns (caller/callee IDs) –
        // we define RAW_COLUMNS outside the loop for efficiency.
        if (RAW_COLUMNS.has(c.toLowerCase())) {
          return `<td>${v}</td>`;
        }

        if (typeof v === 'object') {
          v = JSON.stringify(v);
        } else if (typeof v === 'number' && !RAW_COLUMNS.has(c)) {
          if (DURATION_COLUMNS.has(c)) {
            // Treat as duration in seconds
            v = secondsToHMS(v);
          } else if (v > 1_000_000_000) {
            // Handle different timestamp formats
            let ms;
            if (v > 1_000_000_000_000_000) {
              // Microseconds (e.g., 1755191389441998) - divide by 1000 to get milliseconds
              ms = v / 1000;
            } else if (v < 4102444800000) {
              // Seconds - multiply by 1000 to get milliseconds
              ms = v * 1000;
            } else {
              // Already in milliseconds
              ms = v;
            }
            v = isoToLocal(new Date(ms).toISOString());
          }
        } else if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) {
          const num = Number(v);
          if (!Number.isNaN(num) && num > 1_000_000_000) {
            const ms = num < 4102444800000 ? num * 1000 : num;
            v = isoToLocal(new Date(ms).toISOString());
          }
        } else if (typeof v === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.test(v)) {
          v = isoToLocal(v);
        }
        if (c === 'recording') {
          if (v) {
            const id = v.replace(/[^\w]/g, '');
            const src = `/api/recordings/${v}?account=${encodeURIComponent(tenantAccount)}`;
            const metaUrl = `/api/recordings/${v}/meta?account=${encodeURIComponent(tenantAccount)}`;
            return `<td style="text-align:center">
              <audio class="recording-audio" controls preload="none" src="${src}" data-meta="${metaUrl}" data-id="${id}" style="max-width:200px"></audio>
              <br><span class="rec-dur" id="dur_${id}"></span>
            </td>`;
          }
          return '<td></td>';
        }
        
        // Handle queue history column
        if (c === 'queue_history') {
          return `<td style="text-align: center;">${formatQueueHistory(row)}</td>`;
        }
        
        // Handle agent history column
        if (c === 'agent_history') {
          return `<td style="text-align: center;">${formatAgentHistory(row)}</td>`;
        }
        
        return `<td>${v}</td>`;
      }).join('') + '</tr>';
    }).join('')}</tbody>`;
  table.innerHTML = thead + tbody;
  
  // Setup recording elements after table is rendered
  setupRecordingElements();
}

function generateSearchFilters(columns, data) {
  // Clear existing filters
  filtersGrid.innerHTML = '';
  activeFilters = {};
  
  // Define specific filters to create
  const specificFilters = [
    { key: 'type_direction', label: 'Type/Direction', type: 'select' },
    { key: 'agent_disposition', label: 'Agent Disposition', type: 'select' },
    { key: 'sub_disposition_1', label: 'Sub Disposition 1', type: 'select' },
    { key: 'sub_disposition_2', label: 'Sub Disposition 2', type: 'select' },
    { key: 'agent_ext', label: 'Extension', type: 'text' },
    { key: 'agent_name', label: 'Agent Name', type: 'text' },
    { key: 'campaign_type', label: 'Campaign Type', type: 'select' },
    { key: 'follow_up_notes', label: 'Follow Up Notes', type: 'text' },
    { key: 'phone_number', label: 'Phone Number', type: 'phone_search' }
  ];
  
  specificFilters.forEach(filter => {
    // Skip if column doesn't exist in data (except for phone_number which is special)
    if (filter.key !== 'phone_number' && !columns.includes(filter.key)) {
      return;
    }
    
    const filterDiv = document.createElement('div');
    filterDiv.className = 'column is-3';
    
    const fieldDiv = document.createElement('div');
    fieldDiv.className = 'field';
    
    const label = document.createElement('label');
    label.className = 'label is-small';
    label.textContent = filter.label;
    
    const controlDiv = document.createElement('div');
    controlDiv.className = 'control';
    
    if (filter.type === 'select') {
      // Create dropdown for columns with limited unique values
      const select = document.createElement('select');
      select.className = 'input is-small';
      select.id = `filter_${filter.key}`;
      
      // Add default option
      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = 'All';
      select.appendChild(defaultOption);
      
      // Get unique values for this column
      const uniqueValues = [...new Set(data.map(row => row[filter.key]).filter(v => v != null && v !== ''))];
      uniqueValues.sort().forEach(value => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      });
      
      select.addEventListener('change', () => applyFilters());
      controlDiv.appendChild(select);
      
    } else if (filter.type === 'text') {
      // Create text input for search
      const input = document.createElement('input');
      input.className = 'input is-small';
      input.type = 'text';
      input.id = `filter_${filter.key}`;
      input.placeholder = `Search ${filter.label}...`;
      
      input.addEventListener('input', debounce(() => applyFilters(), 300));
      controlDiv.appendChild(input);
      
    } else if (filter.type === 'phone_search') {
      // Special phone number search input
      const input = document.createElement('input');
      input.className = 'input is-small';
      input.type = 'text';
      input.id = `filter_${filter.key}`;
      input.placeholder = 'Search phone number...';
      
      input.addEventListener('input', debounce(() => applyFilters(), 300));
      controlDiv.appendChild(input);
    }
    
    fieldDiv.appendChild(label);
    fieldDiv.appendChild(controlDiv);
    filterDiv.appendChild(fieldDiv);
    filtersGrid.appendChild(filterDiv);
  });
  
  // Add clear filters button
  const clearDiv = document.createElement('div');
  clearDiv.className = 'column is-12';
  const clearButton = document.createElement('button');
  clearButton.className = 'button is-small is-light';
  clearButton.type = 'button';
  clearButton.textContent = 'Clear All Filters';
  clearButton.addEventListener('click', clearAllFilters);
  clearDiv.appendChild(clearButton);
  filtersGrid.appendChild(clearDiv);
}

function applyFilters() {
  // Get current filter values
  activeFilters = {};
  
  // Handle regular filters
  const regularFilters = ['type_direction', 'agent_disposition', 'sub_disposition_1', 'sub_disposition_2', 'agent_ext', 'agent_name', 'campaign_type', 'follow_up_notes'];
  regularFilters.forEach(column => {
    const filterElement = document.getElementById(`filter_${column}`);
    if (filterElement && filterElement.value.trim()) {
      activeFilters[column] = filterElement.value.trim().toLowerCase();
      filterElement.classList.add('filter-active');
    } else if (filterElement) {
      filterElement.classList.remove('filter-active');
    }
  });
  
  // Handle special phone number filter
  const phoneFilterElement = document.getElementById('filter_phone_number');
  let phoneSearchValue = '';
  if (phoneFilterElement && phoneFilterElement.value.trim()) {
    phoneSearchValue = phoneFilterElement.value.trim().toLowerCase();
    phoneFilterElement.classList.add('filter-active');
  } else if (phoneFilterElement) {
    phoneFilterElement.classList.remove('filter-active');
  }
  
  // Apply filters to data
  filteredData = originalData.filter(row => {
    // Check regular filters
    const regularFiltersPassed = Object.keys(activeFilters).every(column => {
      const filterValue = activeFilters[column];
      const cellValue = String(row[column] || '').toLowerCase();
      
      const filterElement = document.getElementById(`filter_${column}`);
      if (filterElement && filterElement.tagName === 'SELECT') {
        // Exact match for dropdown
        return cellValue === filterValue;
      } else {
        // Partial match for text input
        return cellValue.includes(filterValue);
      }
    });
    
    // Check phone number filter across multiple fields
    let phoneFilterPassed = true;
    if (phoneSearchValue) {
      const phoneFields = [
        String(row.caller_id_number || '').toLowerCase(),
        String(row.callee_id_number || '').toLowerCase()
      ];
      
      phoneFilterPassed = phoneFields.some(field => field.includes(phoneSearchValue));
    }
    
    return regularFiltersPassed && phoneFilterPassed;
  });
  
  // Define columns for rendering
  const reportType = document.getElementById('reportType').value;
  let cols;
  
  if (reportType === 'cdrs') {
    cols = [
      's_no',
      'type_direction',
      'queue_name',
      'campaign_name',
      'called_time',
      'caller_id_number',
      'caller_id_name',
      'callee_id_number',
      'callee_id_name',
      'answered_time',
      'hangup_time',
      'wait_duration',
      'talk_duration',
      'agent_disposition',
      'sub_disposition_1',
      'sub_disposition_2',
      'follow_up_notes',
      'status',
      'campaign_type',
      'agent_history',
      'queue_history',
      'recording',
      'agent_name',
      'extension',
      'country',
      'call_id'
    ];
  } else {
    const originalCols = Object.keys(originalData[0] || {});
    cols = ['row_index', ...originalCols.filter(col => col !== 'row_index')];
  }
  
  // Update stats and re-render table
  updateStats(filteredData.length, originalData.length);
  renderTableData(cols, filteredData);
}

function clearAllFilters() {
  // Clear all filter inputs
  const filterInputs = filtersGrid.querySelectorAll('input, select');
  filterInputs.forEach(input => {
    input.value = '';
    input.classList.remove('filter-active');
  });
  
  // Reset data and re-render
  activeFilters = {};
  filteredData = [...originalData];
  
  const reportType = document.getElementById('reportType').value;
  let cols;
  
  if (reportType === 'cdrs') {
    cols = [
      's_no',
      'type_direction',
      'queue_name',
      'campaign_name',
      'called_time',
      'caller_id_number',
      'caller_id_name',
      'callee_id_number',
      'callee_id_name',
      'answered_time',
      'hangup_time',
      'wait_duration',
      'talk_duration',
      'agent_disposition',
      'sub_disposition_1',
      'sub_disposition_2',
      'follow_up_notes',
      'status',
      'campaign_type',
      'agent_history',
      'queue_history',
      'recording',
      'agent_name',
      'extension',
      'country',
      'call_id'
    ];
  } else {
    const originalCols = Object.keys(originalData[0] || {});
    cols = ['row_index', ...originalCols.filter(col => col !== 'row_index')];
  }
  
  updateStats(filteredData.length, originalData.length);
  renderTableData(cols, filteredData);
}

function updateStats(filtered, total) {
  if (total === 0) {
    hide(statsEl);
    return;
  }
  
  // Count active filters including phone number filter
  let activeFilterCount = Object.keys(activeFilters).length;
  const phoneFilterElement = document.getElementById('filter_phone_number');
  if (phoneFilterElement && phoneFilterElement.value.trim()) {
    activeFilterCount++;
  }
  
  let statsText = `Showing ${filtered.toLocaleString()} of ${total.toLocaleString()} records`;
  if (filtered !== total) {
    statsText += ` (${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active)`;
  }
  
  statsEl.textContent = statsText;
  show(statsEl);
}

// Debounce function to limit API calls
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Function to check if form is valid and enable/disable button
function validateForm() {
  const account = document.getElementById('account').value.trim();
  const start = document.getElementById('start').value;
  const end = document.getElementById('end').value;
  const reportType = document.getElementById('reportType').value;
  const recordLimit = document.getElementById('recordLimit').value;
  
  const isValid = account && start && end && reportType && recordLimit && recordLimit > 0;
  fetchBtn.disabled = !isValid;
}

// Add event listeners to form fields to validate on change
document.getElementById('account').addEventListener('input', validateForm);
document.getElementById('start').addEventListener('change', validateForm);
document.getElementById('end').addEventListener('change', validateForm);
document.getElementById('reportType').addEventListener('change', validateForm);
document.getElementById('recordLimit').addEventListener('input', validateForm);

// Initial validation on page load
document.addEventListener('DOMContentLoaded', validateForm);

form.addEventListener('submit', async e => {
  e.preventDefault();
  hide(errorBox);
  show(loadingEl);
  table.innerHTML = '';

  const account = document.getElementById('account').value.trim();
  const start = inputToDubaiIso(document.getElementById('start').value);
  // Make end-time inclusive (the backend treats endDate as exclusive < end).
  // We therefore add 59 seconds so anything happening within the selected minute
  const endDate = new Date(inputToDubaiIso(document.getElementById('end').value));
  endDate.setSeconds(endDate.getSeconds() + 59);
  const end = endDate.toISOString();
  const reportType = document.getElementById('reportType').value;
  const limit = parseInt(document.getElementById('recordLimit').value, 10);

  console.log('Request params:', { account, start, end, reportType, limit }); // Debug log

  try {
    tenantAccount = account; // Assign tenantAccount here
    const res = await axios.get(`/api/reports/${reportType}`, {
      params: { account, start, end, limit }
    });
    console.log('Full API response:', res); // Debug log
    console.log('Response data:', res.data); // Debug log
    console.log('Response data type:', typeof res.data); // Debug log
    console.log('Response data keys:', Object.keys(res.data || {})); // Debug log
    
    if (res.data && res.data.data) {
      console.log('Found data.data:', res.data.data); // Debug log
      console.log('data.data length:', res.data.data.length); // Debug log
      console.log('First record:', res.data.data[0]); // Debug log
    }
    
    renderTable(res.data);
  } catch (err) {
    console.error('Request failed:', err); // Debug log
    errorBox.textContent = err.response?.data?.error || err.message;
    show(errorBox);
  } finally {
    hide(loadingEl);
  }
});

function extractSubDisposition1(record) {
  // Extract from subdisposition first level, then fallback to fonoUC and custom fields
  if (record.subdisposition?.name) {
    return record.subdisposition.name;
  }
  if (record.fonoUC?.subdisposition?.name) {
    return record.fonoUC.subdisposition.name;
  }
  return record.sub_disposition_1 || 
         record.custom_channel_vars?.subdisposition1 || 
         '';
}

function extractSubDisposition2(record) {
  // Extract from subdisposition second level, then fallback to fonoUC and custom fields
  if (record.subdisposition?.subdisposition?.name) {
    return record.subdisposition.subdisposition.name;
  }
  if (record.fonoUC?.subdisposition?.subdisposition?.name) {
    return record.fonoUC.subdisposition.subdisposition.name;
  }
  return record.sub_disposition_2 || 
         record.custom_channel_vars?.subdisposition2 || 
         '';
}

function extractQueueName(record) {
  // Extract queue name from fonoUC.cc.queue_name or custom fields
  return record.fonoUC?.cc?.queue_name || 
         record.fonoUC?.cc_campaign?.campaign?.queue_name || 
         record.queue_name || 
         '';
}

function extractCampaignName(record) {
  // Extract campaign name from fonoUC.cc_campaign.campaign.name or custom fields
  return record.fonoUC?.cc_campaign?.campaign?.name || record.campaign_name || '';
}

function calculateAnsweredTime(record) {
  // Extract answered time from fonoUC.cc_outbound.answered_time first, then fallback to other locations
  return record.fonoUC?.cc_outbound?.answered_time || 
         record.channel_answered_time || 
         record.answered_time || 
         '';
}

function calculateHangupTime(record) {
  // Extract hangup time from fonoUC campaign timestamps or fallback to other fields
  const timestamps = record.fonoUC?.cc_campaign?.lead?.lead_campaign?.timestamps;
  if (timestamps) {
    // Prefer lead_hangup_time, fallback to agent_hangup_time
    return timestamps.lead_hangup_time || timestamps.agent_hangup_time || '';
  }
  
  // Fallback to other possible locations
  return record.channel_hangup_time || record.hangup_time || '';
}

function mapStatus(record) {
  // Map status from fonoUC.cc_campaign.lead.lead_campaign.status or custom fields
  return record.fonoUC?.cc_campaign?.lead?.lead_campaign?.status || 
         record.fonoUC?.status || 
         record.status || 
         '';
}

function extractCampaignType(record) {
  // Extract campaign type from fonoUC.cc_campaign.campaign.type or custom fields
  return record.fonoUC?.cc_campaign?.campaign?.type || record.campaign_type || '';
}

function formatQueueHistory(record) {
  // Get queue history from various possible locations
  let history = record.fonoUC?.cc_outbound?.queue_history || 
                      record.fonoUC?.queue_history || 
                      record.queue_history || [];
  
  // If it's a string, try to parse it as JSON
  if (typeof history === 'string') {
    try {
      history = JSON.parse(history);
    } catch {
      history = [];
    }
  }
  
  // Ensure it's an array
  if (!Array.isArray(history)) {
    history = [];
  }
  
  // Convert Queue history array into an HTML table (Date, Queue Name)
  if (!Array.isArray(history) || !history.length) return '';
  
  // Sort by timestamp (oldest first)
  const sorted = [...history].sort((a, b) => {
    const aTs = a.ts ?? 0;
    const bTs = b.ts ?? 0;
    return aTs - bTs;
  });
  
  const thead = '<thead><tr><th>Date</th><th>Queue Name</th></tr></thead>';
  const rows = sorted.map(h => {
    let date = '';
    if (h.ts) {
      const ms = h.ts > 10_000_000_000 ? h.ts : h.ts * 1000;
      date = isoToLocal(new Date(ms).toISOString());
    }
    const queueName = h.queue_name ?? '';
    return `<tr><td>${date}</td><td>${queueName}</td></tr>`;
  }).join('');
  const tableHtml = `<table class="history-table">${thead}<tbody>${rows}</tbody></table>`;
  return createEyeBtn(tableHtml);
}

function formatAgentHistory(record) {
  // Get agent history from various possible locations
  let history = record.fonoUC?.cc_outbound?.agent_history || 
                      record.fonoUC?.agent_history || 
                      record.agent_history || [];
  
  // If it's a string, try to parse it as JSON
  if (typeof history === 'string') {
    try {
      history = JSON.parse(history);
    } catch {
      history = [];
    }
  }
  
  // Ensure it's an array
  if (!Array.isArray(history)) {
    history = [];
  }
  
  if (!history.length) return '';

  // Sort by called_time (oldest first)
  const sorted = [...history].sort((a, b) => {
    const aTs = a.called_time || a.last_attempt || 0;
    const bTs = b.called_time || b.last_attempt || 0;
    return aTs - bTs;
  });

  // Define columns for agent history
  const COLS = [
    { key: 'called_time', label: 'Last Attempt' },
    { key: 'name', label: 'Name' },
    { key: 'ext', label: 'Extension' },
    { key: 'type', label: 'Type' },
    { key: 'event', label: 'Event' },
    { key: 'connected', label: 'Connected' },
    { key: 'queue_name', label: 'Queue Name' }
  ];

  const thead = `<thead><tr>${COLS.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>`;

  const rows = sorted.map(h => {
    const cells = COLS.map(c => {
      let val = '';
      if (c.key === 'name') {
        val = `${h.first_name || ''} ${h.last_name || ''}`.trim();
      } else if (c.key === 'called_time') {
        const timestamp = h.called_time || h.last_attempt;
        if (timestamp) {
          // Handle different timestamp formats
          let ms;
          if (timestamp > 1_000_000_000_000_000) {
            ms = timestamp / 1000; // Microseconds
          } else if (timestamp < 4102444800000) {
            ms = timestamp * 1000; // Seconds
          } else {
            ms = timestamp; // Milliseconds
          }
          val = isoToLocal(new Date(ms).toISOString());
        }
      } else if (c.key === 'connected') {
        val = h.connected === 'True' || h.connected === true ? 'Yes' : 'No';
      } else {
        val = h[c.key] || '';
      }
      return `<td>${val}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  const tableHtml = `<table class="history-table">${thead}<tbody>${rows}</tbody></table>`;
  return createEyeBtn(tableHtml);
}

function createEyeBtn(innerHtml) {
  const id = 'popup_' + Math.random().toString(36).slice(2, 9);
  return `<button class="button is-small is-rounded eye-btn" data-target="${id}" title="View">&#128065;</button>` +
         `<div id="${id}" class="popup-content" style="display:none">${innerHtml}</div>`;
}

function showModal(contentHtml) {
  const modal = document.createElement('div');
  modal.className = 'modal is-active';
  modal.innerHTML = `
    <div class="modal-background"></div>
    <div class="modal-content" style="max-height:90vh; overflow:auto;">
      <div class="box">${contentHtml}</div>
    </div>
    <button class="modal-close is-large" aria-label="close"></button>`;
  const close = () => document.body.removeChild(modal);
  modal.querySelector('.modal-background').addEventListener('click', close);
  modal.querySelector('.modal-close').addEventListener('click', close);
  document.body.appendChild(modal);
}

if (!window.__eyeDelegationAttached) {
  document.addEventListener('click', e => {
    const btn = e.target.closest('.eye-btn');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.target);
    if (target) {
      showModal(target.innerHTML);
    }
  });
  window.__eyeDelegationAttached = true;
}

function extractRecording(record) {
  // Extract recording ID from multiple possible locations
  
  // First try custom_channel_vars.media_recording_id
  if (record.custom_channel_vars?.media_recording_id) {
    return record.custom_channel_vars.media_recording_id;
  }
  
  // Then try custom_channel_vars.media_recordings array (first item)
  if (Array.isArray(record.custom_channel_vars?.media_recordings) && record.custom_channel_vars.media_recordings.length > 0) {
    return record.custom_channel_vars.media_recordings[0];
  }
  
  // Fallback to fonoUC or direct fields
  return record.fonoUC?.recording || record.recording || record.media_recording_id || record.recording_filename || '';
}

function extractAgentName(record) {
  // Extract agent name from the first agent_history item
  const agentHistory = record.fonoUC?.cc_outbound?.agent_history || 
                      record.fonoUC?.agent_history || 
                      record.agent_history || [];
  
  if (agentHistory.length > 0) {
    const firstAgent = agentHistory[0];
    if (firstAgent.first_name && firstAgent.last_name) {
      return `${firstAgent.first_name} ${firstAgent.last_name}`;
    }
    return firstAgent.first_name || firstAgent.last_name || firstAgent.agent_name || '';
  }
  
  // Fallback to other possible locations
  return record.agent_name || record.fonoUC?.agent_name || '';
}

function extractExtension(record) {
  // Extract extension from the first agent_history item
  const agentHistory = record.fonoUC?.cc_outbound?.agent_history || 
                      record.fonoUC?.agent_history || 
                      record.agent_history || [];
  
  if (agentHistory.length > 0) {
    const firstAgent = agentHistory[0];
    return firstAgent.ext || firstAgent.extension || '';
  }
  
  // Fallback to other possible locations
  return record.extension || record.ext || record.fonoUC?.extension || '';
}

function extractCountry(record) {
  // First try to get country from existing fields
  if (record.fonoUC?.country || record.country) {
    return record.fonoUC?.country || record.country;
  }
  
  // If no country field exists, try to extract from phone numbers
  // Try different phone number fields that might contain the number
  const phoneFields = [
    record.callee_id_number,
    record.caller_id_number, 
    record.fonoUC?.callee_id_number,
    record.fonoUC?.caller_id_number,
    record.destination_number,
    record.fonoUC?.destination_number,
    record.called_number,
    record.fonoUC?.called_number
  ];
  
  // Try each phone field until we get a country
  for (const phoneNumber of phoneFields) {
    if (phoneNumber) {
      const country = extractCountryFromPhoneNumber(phoneNumber);
      if (country) {
        console.log(`Extracted country "${country}" from phone number: ${phoneNumber}`);
        return country;
      }
    }
  }
  
  return '';
}

function extractFollowUpNotes(record) {
  // Extract follow-up notes from fonoUC or custom fields
  return record.fonoUC?.follow_up_notes || record.follow_up_notes || '';
}

function renderTableData(cols, data) {
  if (!data.length) {
    table.innerHTML = '<caption>No results match the current filters.</caption>';
    return;
  }

  const thead = `<thead><tr>${cols.map(c => {
    let displayName;
    if (c === 's_no') {
      displayName = 'S.No';
    } else if (c === 'type_direction') {
      displayName = 'Type/Direction';
    } else if (c === 'queue_name') {
      displayName = 'Queue Name';
    } else if (c === 'campaign_name') {
      displayName = 'Campaign Name';
    } else if (c === 'caller_id_number') {
      displayName = 'Caller ID Number';
    } else if (c === 'caller_id_name') {
      displayName = 'Caller ID Name';
    } else if (c === 'callee_id_number') {
      displayName = 'Callee ID Number';
    } else if (c === 'callee_id_name') {
      displayName = 'Callee ID Name';
    } else if (c === 'sub_disposition_1') {
      displayName = 'Sub-disposition 1';
    } else if (c === 'sub_disposition_2') {
      displayName = 'Sub-disposition 2';
    } else if (c === 'follow_up_notes') {
      displayName = 'Follow-up Notes';
    } else {
      displayName = c.replace(/_/g, ' ').toUpperCase();
    }
    return `<th${c === 's_no' ? ' style="width: 60px; text-align: center;"' : ''}>${displayName}</th>`;
  }).join('')}</tr></thead>`;
  
  const tbody = `<tbody>${data
    .map(row => {
      // Determine row class based on call type/direction
      let rowClass = '';
      const typeDirection = row.type_direction || '';
      if (typeDirection.toLowerCase().includes('outbound')) {
        rowClass = 'row-outbound';
      } else if (typeDirection.toLowerCase().includes('inbound')) {
        rowClass = 'row-inbound';
      }

      return '<tr class="' + rowClass + '">' + cols.map(c => {
        let v = row[c];
        if (v == null) v = '';

        // Special handling for row_index
        if (c === 'row_index') {
          return `<td style="text-align: center; font-weight: bold; background-color: #f8f9fa;">${v}</td>`;
        }

        // Special handling for s_no (S. No) column - should always show as raw number
        if (c === 's_no') {
          return `<td style="text-align: center; font-weight: bold; background-color: #f8f9fa;">${v}</td>`;
        }

        // Skip any transformation for specific columns (caller/callee IDs) –
        // we define RAW_COLUMNS outside the loop for efficiency.
        if (RAW_COLUMNS.has(c.toLowerCase())) {
          return `<td>${v}</td>`;
        }

        if (typeof v === 'object') {
          v = JSON.stringify(v);
        } else if (typeof v === 'number' && !RAW_COLUMNS.has(c)) {
          if (DURATION_COLUMNS.has(c)) {
            // Treat as duration in seconds
            v = secondsToHMS(v);
          } else if (v > 1_000_000_000) {
            // Handle different timestamp formats
            let ms;
            if (v > 1_000_000_000_000_000) {
              // Microseconds (e.g., 1755191389441998) - divide by 1000 to get milliseconds
              ms = v / 1000;
            } else if (v < 4102444800000) {
              // Seconds - multiply by 1000 to get milliseconds
              ms = v * 1000;
            } else {
              // Already in milliseconds
              ms = v;
            }
            v = isoToLocal(new Date(ms).toISOString());
          }
        } else if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) {
          const num = Number(v);
          if (!Number.isNaN(num) && num > 1_000_000_000) {
            const ms = num < 4102444800000 ? num * 1000 : num;
            v = isoToLocal(new Date(ms).toISOString());
          }
        } else if (typeof v === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.test(v)) {
          v = isoToLocal(v);
        }
        if (c === 'recording') {
          if (v) {
            const id = v.replace(/[^\w]/g, '');
            const src = `/api/recordings/${v}?account=${encodeURIComponent(tenantAccount)}`;
            const metaUrl = `/api/recordings/${v}/meta?account=${encodeURIComponent(tenantAccount)}`;
            return `<td style="text-align:center">
              <audio class="recording-audio" controls preload="none" src="${src}" data-meta="${metaUrl}" data-id="${id}" style="max-width:200px"></audio>
              <br><span class="rec-dur" id="dur_${id}"></span>
            </td>`;
          }
          return '<td></td>';
        }
        
        // Handle queue history column
        if (c === 'queue_history') {
          return `<td style="text-align: center;">${formatQueueHistory(row)}</td>`;
        }
        
        // Handle agent history column
        if (c === 'agent_history') {
          return `<td style="text-align: center;">${formatAgentHistory(row)}</td>`;
        }
        
        return `<td>${v}</td>`;
      }).join('') + '</tr>';
    }).join('')}</tbody>`;
  table.innerHTML = thead + tbody;
  
  // Setup recording elements after table is rendered
  setupRecordingElements();
}

function setupRecordingElements() {
  // Call the new duration fetching logic
  afterRowsRendered();
}

// Called after rows are fully appended for the current render
function afterRowsRendered() {
  // Re-run duration worker setup for new rows
  const audioEls = Array.from(table.querySelectorAll('.recording-audio[data-meta]'));
  const MAX_CONCURRENT = 5;
  let idx = 0;
  async function worker() {
    while (idx < audioEls.length) {
      const el = audioEls[idx++];
      const spanId = 'dur_' + el.dataset.id;
      const span = document.getElementById(spanId);
      if (!span || span.textContent) continue;
      try {
        const resp = await axios.get(el.dataset.meta);
        const dur = resp.data?.duration;
        
        if (typeof dur === 'number') {
          span.textContent = ` Time: ${secondsToHMS(Math.round(dur))}`;
        }
      } catch {}
    }
  }
  Array.from({ length: Math.min(MAX_CONCURRENT, audioEls.length) }).forEach(worker);
}

function renderCurrentPage() {
  const totalPages = Math.max(1, Math.ceil(currentFiltered.length / PAGE_SIZE));
  // Clamp currentPage within valid range
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  const pageSlice = currentFiltered.slice(startIdx, startIdx + PAGE_SIZE);
  renderTableDataChunked(pageSlice, startIdx);

  // Update type totals (cumulative across all revealed pages)
  showTotals(lastRecords);

  // Build / update pagination UI
  let nav = document.getElementById('pageNav');
  if (!nav) {
    nav = document.createElement('nav');
    nav.id = 'pageNav';
    nav.className = 'pagination is-small';
    // Insert after the results table
    table.parentNode.insertBefore(nav, table.nextSibling);
  }

  // Determine if more data might exist beyond currentFiltered
  const reportType = document.getElementById('reportType').value;
  const buffersEmpty = !buffers[reportType] || !buffers[reportType].length;
  const noMoreTokens = nextTokens[reportType] === null;
  // Enable Next as long as we still have buffered records or server pages
  const mayHaveMore = !(buffersEmpty && noMoreTokens);

  const prevDisabled = currentPage === 1 ? 'disabled' : '';
  const nextDisabled = (currentPage === totalPages && !mayHaveMore) ? 'disabled' : '';

  // Remove any lingering children to avoid stale disabled links
  while (nav.firstChild) nav.removeChild(nav.firstChild);

  nav.innerHTML = `
    <a class="pagination-previous" ${prevDisabled}>Previous</a>
    <a class="pagination-next" ${nextDisabled}>Next</a>
    <span class="ml-2">Page ${currentPage} of ${totalPages}</span>`;
}

function renderTableDataChunked(records, globalStartIdx = 0) {
  if (!records.length) {
    table.innerHTML = '<caption>No results for selected range.</caption>';
    return;
  }

  const reportType = document.getElementById('reportType').value;
  let cols;
  
  if (reportType === 'cdrs') {
    cols = [
      's_no',
      'type_direction',
      'queue_name',
      'campaign_name',
      'called_time',
      'caller_id_number',
      'caller_id_name',
      'callee_id_number',
      'callee_id_name',
      'answered_time',
      'hangup_time',
      'wait_duration',
      'talk_duration',
      'agent_disposition',
      'sub_disposition_1',
      'sub_disposition_2',
      'follow_up_notes',
      'status',
      'campaign_type',
      'agent_history',
      'queue_history',
      'recording',
      'agent_name',
      'extension',
      'country',
      'call_id'
    ];
  } else {
    const originalCols = Object.keys(records[0] || {});
    cols = ['row_index', ...originalCols.filter(col => col !== 'row_index')];
  }

  const theadHtml = `<thead><tr>${cols.map(c => {
    let displayName;
    if (c === 's_no') {
      displayName = 'S.No';
    } else if (c === 'type_direction') {
      displayName = 'Type/Direction';
    } else if (c === 'queue_name') {
      displayName = 'Queue Name';
    } else if (c === 'campaign_name') {
      displayName = 'Campaign Name';
    } else if (c === 'caller_id_number') {
      displayName = 'Caller ID Number';
    } else if (c === 'caller_id_name') {
      displayName = 'Caller ID Name';
    } else if (c === 'callee_id_number') {
      displayName = 'Callee ID Number';
    } else if (c === 'callee_id_name') {
      displayName = 'Callee ID Name';
    } else if (c === 'sub_disposition_1') {
      displayName = 'Sub-disposition 1';
    } else if (c === 'sub_disposition_2') {
      displayName = 'Sub-disposition 2';
    } else if (c === 'follow_up_notes') {
      displayName = 'Follow-up Notes';
    } else {
      displayName = c.replace(/_/g, ' ').toUpperCase();
    }
    return `<th${c === 's_no' ? ' style="width: 60px; text-align: center;"' : ''}>${displayName}</th>`;
  }).join('')}</tr></thead>`;
  
  table.innerHTML = theadHtml + '<tbody></tbody>';
  const tbodyEl = table.querySelector('tbody');

  let offset = 0;
  function appendChunk() {
    const slice = records.slice(offset, offset + CHUNK_SIZE);
    tbodyEl.insertAdjacentHTML('beforeend', renderRowsHtml(slice, globalStartIdx + offset + 1, cols));
    offset += CHUNK_SIZE;
    if (offset < records.length) {
      // Yield back to event loop to keep UI responsive
      setTimeout(appendChunk, 0);
    } else {
      // Once all rows rendered trigger duration fetch workers
      afterRowsRendered();
    }
  }

  appendChunk();
}

function renderRowsHtml(rows, startSerial = 1, cols) {
  let serial = startSerial;
  return rows
    .map(rec => {
      // Determine row class based on call type/direction
      let rowClass = '';
      const typeDirection = rec.type_direction || '';
      if (typeDirection.toLowerCase().includes('outbound')) {
        rowClass = 'row-outbound';
      } else if (typeDirection.toLowerCase().includes('inbound')) {
        rowClass = 'row-inbound';
      }

      const tds = cols.map(c => {
        if (c === 's_no') return `<td style="text-align: center; font-weight: bold; background-color: #f8f9fa;">${serial}</td>`;
        let v = rec[c];
        if (v == null) v = '';

        // Special handling for row_index
        if (c === 'row_index') {
          return `<td style="text-align: center; font-weight: bold; background-color: #f8f9fa;">${v}</td>`;
        }

        // Skip any transformation for specific columns (caller/callee IDs) –
        // we define RAW_COLUMNS outside the loop for efficiency.
        if (RAW_COLUMNS.has(c.toLowerCase())) {
          return `<td>${v}</td>`;
        }

        if (typeof v === 'object') {
          v = JSON.stringify(v);
        } else if (typeof v === 'number' && !RAW_COLUMNS.has(c)) {
          if (DURATION_COLUMNS.has(c)) {
            // Treat as duration in seconds
            v = secondsToHMS(Math.round(v));
          } else if (v > 1_000_000_000) {
            // Handle different timestamp formats
            let ms;
            if (v > 1_000_000_000_000_000) {
              // Microseconds (e.g., 1755191389441998) - divide by 1000 to get milliseconds
              ms = v / 1000;
            } else if (v < 4102444800000) {
              // Seconds - multiply by 1000 to get milliseconds
              ms = v * 1000;
            } else {
              // Already in milliseconds
              ms = v;
            }
            v = isoToLocal(new Date(ms).toISOString());
          }
        } else if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) {
          const num = Number(v);
          if (!Number.isNaN(num) && num > 1_000_000_000) {
            const ms = num < 4102444800000 ? num * 1000 : num;
            v = isoToLocal(new Date(ms).toISOString());
          }
        } else if (typeof v === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.test(v)) {
          v = isoToLocal(v);
        }
        if (c === 'recording') {
          if (v) {
            const id = v.replace(/[^\w]/g, '');
            const src = `/api/recordings/${v}?account=${encodeURIComponent(tenantAccount)}`;
            const metaUrl = `/api/recordings/${v}/meta?account=${encodeURIComponent(tenantAccount)}`;
            return `<td style="text-align:center">
              <audio class="recording-audio" controls preload="none" src="${src}" data-meta="${metaUrl}" data-id="${id}" style="max-width:200px"></audio>
              <br><span class="rec-dur" id="dur_${id}"></span>
            </td>`;
          }
          return '<td></td>';
        }
        
        // Handle queue history column
        if (c === 'queue_history') {
          return `<td style="text-align: center;">${formatQueueHistory(rec)}</td>`;
        }
        
        // Handle agent history column
        if (c === 'agent_history') {
          return `<td style="text-align: center;">${formatAgentHistory(rec)}</td>`;
        }
        
        return `<td>${v}</td>`;
      }).join('');
      serial += 1;
      return `<tr class="${rowClass}">${tds.join('')}</tr>`;
    }).join('');
}

// Called after rows are fully appended for the current render
function afterRowsRendered() {
  // Re-run duration worker setup for new rows
  const audioEls = Array.from(table.querySelectorAll('.recording-audio[data-meta]'));
  const MAX_CONCURRENT = 5;
  let idx = 0;
  async function worker() {
    while (idx < audioEls.length) {
      const el = audioEls[idx++];
      const spanId = 'dur_' + el.dataset.id;
      const span = document.getElementById(spanId);
      if (!span || span.textContent) continue;
      try {
        const resp = await axios.get(el.dataset.meta);
        const dur = resp.data?.duration;
        
        if (typeof dur === 'number') {
          span.textContent = ` Time: ${secondsToHMS(Math.round(dur))}`;
        }
      } catch {}
    }
  }
  Array.from({ length: Math.min(MAX_CONCURRENT, audioEls.length) }).forEach(worker);
}

function showTotals(list) {
  if (!statsEl) return;
  const total = list.length;
  statsEl.innerHTML = `Total: <strong>${total}</strong> records loaded`;
  show(statsEl);
}

function updateStats(filtered, total) {
  if (total === 0) {
    hide(statsEl);
    return;
  }
  
  // Count active filters including phone number filter
  let activeFilterCount = Object.keys(activeFilters).length;
  const phoneFilterElement = document.getElementById('filter_phone_number');
  if (phoneFilterElement && phoneFilterElement.value.trim()) {
    activeFilterCount++;
  }
  
  let statsText = `Showing ${filtered.toLocaleString()} of ${total.toLocaleString()} records`;
  if (filtered !== total) {
    statsText += ` (${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active)`;
  }
  
  statsEl.textContent = statsText;
  show(statsEl);
}