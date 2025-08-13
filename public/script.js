// script.js

/* global axios */
const form = document.getElementById('filterForm');
const loadingEl = document.getElementById('loading');
const errorBox = document.getElementById('errorBox');
const table = document.getElementById('resultTable');
const fetchBtn = document.getElementById('fetchBtn');
const filtersGrid = document.getElementById('filtersGrid');
const statsEl = document.getElementById('stats');

// Store original data for filtering
let originalData = [];
let filteredData = [];
let activeFilters = {};

// Columns whose raw value should NEVER be interpreted as epoch or duration
const RAW_COLUMNS = new Set([
  'caller_id_number',
  'caller_id_name',
  'callee_id_number',
  'agent_ext',
  'lead_number',
  'agent_extension',
  'to'
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

// Convert a <input type="datetime-local"> value assumed to be in Dubai local time
// into a proper ISO-8601 string (UTC) so the backend receives the right window.
function inputToDubaiIso(val) {
  if (!val) return '';
  const [datePart, timePart = '00:00'] = val.split('T'); // "YYYY-MM-DD" & "HH:MM"
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  // Asia/Dubai is UTC+4 with no daylight saving; subtract 4 h to get UTC.
  const utcMillis = Date.UTC(year, month - 1, day, hour - 4, minute);
  return new Date(utcMillis).toISOString();
}

function renderTable(raw) {
  const data = Array.isArray(raw) ? raw : raw?.data || raw?.records || [];
  
  // Store original data for filtering with added index
  originalData = data.map((record, index) => ({
    ...record,
    row_index: index + 1 // Add 1-based indexing
  }));
  filteredData = [...originalData];
  
  if (!data.length) {
    table.innerHTML = '<caption>No results for selected range.</caption>';
    hide(statsEl);
    return;
  }

  // For CDRs, only show the specific fields we requested
  const reportType = document.getElementById('reportType').value;
  let cols;
  
  if (reportType === 'cdrs') {
    // Define the specific CDR columns we want to display in order, with index first
    const cdrColumns = [
      'row_index',
      'call_id',
      'caller_id_number', 
      'callee_id_number',
      'call_direction',
      'disposition',
      'subdisposition',
      'follow_up_notes',
      'timestamp'
    ];
    // Always include all defined CDR columns (don't filter based on first record)
    cols = cdrColumns;
  } else {
    // For other report types, show all columns with index first
    const originalCols = Object.keys(originalData[0] || {});
    cols = ['row_index', ...originalCols.filter(col => col !== 'row_index')];
  }

  // Generate search filters based on columns
  generateSearchFilters(cols, originalData);
  
  // Display stats
  updateStats(originalData.length, originalData.length);
  
  // Render the table
  renderTableData(cols, filteredData);
}

function renderTableData(cols, data) {
  if (!data.length) {
    table.innerHTML = '<caption>No results match the current filters.</caption>';
    return;
  }

  const thead = `<thead><tr>${cols.map(c => {
    const displayName = c === 'row_index' ? '#' : c.replace(/_/g, ' ').toUpperCase();
    return `<th${c === 'row_index' ? ' style="width: 60px; text-align: center;"' : ''}>${displayName}</th>`;
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

        // Skip any transformation for specific columns (caller/callee IDs) –
        // we define RAW_COLUMNS outside the loop for efficiency.
        if (RAW_COLUMNS.has(c.toLowerCase())) {
          return `<td>${v}</td>`;
        }

        if (typeof v === 'object') {
          v = JSON.stringify(v);
        } else if (typeof v === 'number') {
          if (v > 1_000_000_000) {
            // Likely epoch timestamp (s or ms)
            const ms = v > 10_000_000_000 ? v : v * 1000;
            v = isoToLocal(new Date(ms).toISOString());
          } else {
            // Treat as duration in seconds
            v = secondsToHMS(v);
          }
        } else if (typeof v === 'string' && /^\d+$/.test(v)) {
          // Numeric string – decide duration vs epoch
          const num = Number(v);
          if (num > 1_000_000_000) {
            const ms = num > 10_000_000_000 ? num : num * 1000;
            v = isoToLocal(new Date(ms).toISOString());
          } else {
            v = secondsToHMS(num);
          }
        } else if (typeof v === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.test(v)) {
          // ISO 8601 string → format in IST
          v = isoToLocal(v);
        }
        return `<td>${v}</td>`;
      }).join('') + '</tr>';
    }).join('')}</tbody>`;
  table.innerHTML = thead + tbody;
}

function generateSearchFilters(columns, data) {
  // Clear existing filters
  filtersGrid.innerHTML = '';
  activeFilters = {};
  
  // Create filters for each column (except row_index)
  columns.filter(column => column !== 'row_index').forEach(column => {
    const filterDiv = document.createElement('div');
    filterDiv.className = 'column is-3';
    
    const fieldDiv = document.createElement('div');
    fieldDiv.className = 'field';
    
    const label = document.createElement('label');
    label.className = 'label is-small';
    label.textContent = column.replace(/_/g, ' ').toUpperCase();
    
    const controlDiv = document.createElement('div');
    controlDiv.className = 'control';
    
    // Determine filter type based on column and data
    const filterType = getFilterType(column, data);
    
    if (filterType === 'select') {
      // Create dropdown for columns with limited unique values
      const select = document.createElement('select');
      select.className = 'input is-small';
      select.id = `filter_${column}`;
      
      // Add default option
      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = 'All';
      select.appendChild(defaultOption);
      
      // Get unique values for this column
      const uniqueValues = [...new Set(data.map(row => row[column]).filter(v => v != null && v !== ''))];
      uniqueValues.sort().forEach(value => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      });
      
      select.addEventListener('change', () => applyFilters());
      controlDiv.appendChild(select);
      
    } else if (filterType === 'text') {
      // Create text input for search
      const input = document.createElement('input');
      input.className = 'input is-small';
      input.type = 'text';
      input.id = `filter_${column}`;
      input.placeholder = `Search ${column.replace(/_/g, ' ')}...`;
      
      input.addEventListener('input', debounce(() => applyFilters(), 300));
      controlDiv.appendChild(input);
    }
    
    if (filterType !== 'none') {
      fieldDiv.appendChild(label);
      fieldDiv.appendChild(controlDiv);
      filterDiv.appendChild(fieldDiv);
      filtersGrid.appendChild(filterDiv);
    }
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

function getFilterType(column, data) {
  // Don't create filter for row_index
  if (column === 'row_index') {
    return 'none';
  }
  
  // Get unique values for this column
  const uniqueValues = [...new Set(data.map(row => row[column]).filter(v => v != null && v !== ''))];
  
  // If there are 10 or fewer unique values, use dropdown
  if (uniqueValues.length <= 10 && uniqueValues.length > 0) {
    return 'select';
  }
  
  return 'text';
}

function applyFilters() {
  const reportType = document.getElementById('reportType').value;
  let cols;
  
  if (reportType === 'cdrs') {
    cols = [
      'row_index',
      'call_id',
      'caller_id_number', 
      'callee_id_number',
      'call_direction',
      'disposition',
      'subdisposition',
      'follow_up_notes',
      'timestamp'
    ];
  } else {
    const originalCols = Object.keys(originalData[0] || {});
    cols = ['row_index', ...originalCols.filter(col => col !== 'row_index')];
  }
  
  // Get current filter values (excluding row_index)
  activeFilters = {};
  cols.filter(column => column !== 'row_index').forEach(column => {
    const filterElement = document.getElementById(`filter_${column}`);
    if (filterElement && filterElement.value.trim()) {
      activeFilters[column] = filterElement.value.trim().toLowerCase();
      filterElement.classList.add('filter-active');
    } else if (filterElement) {
      filterElement.classList.remove('filter-active');
    }
  });
  
  // Apply filters to data
  filteredData = originalData.filter(row => {
    return Object.keys(activeFilters).every(column => {
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
  });
  
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
      'row_index',
      'call_id',
      'caller_id_number', 
      'callee_id_number',
      'call_direction',
      'disposition',
      'subdisposition',
      'follow_up_notes',
      'timestamp'
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
  
  let statsText = `Showing ${filtered.toLocaleString()} of ${total.toLocaleString()} records`;
  if (filtered !== total) {
    statsText += ` (${Object.keys(activeFilters).length} filter${Object.keys(activeFilters).length !== 1 ? 's' : ''} active)`;
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
  // is returned. Example: choosing 12:01 should include 12:01:59 as well.
  let end = inputToDubaiIso(document.getElementById('end').value);
  if (end) {
    const dt = new Date(end);
    dt.setSeconds(dt.getSeconds() + 59);
    end = dt.toISOString();
  }
  const type = document.getElementById('reportType').value;
  const limit = parseInt(document.getElementById('recordLimit').value, 10);

  console.log('Request params:', { account, start, end, type, limit }); // Debug log

  try {
    const res = await axios.get(`/api/reports/${type}`, {
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