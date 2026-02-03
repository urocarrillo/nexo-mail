/**
 * Google Apps Script for Nexo Mail Lead Automation
 *
 * SETUP INSTRUCTIONS:
 * 1. Open your Google Sheet
 * 2. Go to Extensions > Apps Script
 * 3. Delete any existing code and paste this script
 * 4. Save the project (Ctrl+S)
 * 5. Run setupTrigger() once to configure automatic processing
 *
 * COMPATIBLE WITH:
 * - ManyChat integration (API writes)
 * - Manual data entry
 * - Form submissions
 *
 * SHEET FORMAT:
 * A: Name
 * B: Email
 * C: Timestamp (optional)
 * D: ID (optional)
 * E: Status (updated by script: SUCCESS, FAILED, SKIPPED, ERROR)
 */

// ============== CONFIGURATION ==============
const WEBHOOK_URL = 'https://nexo-mail.vercel.app/api/webhook/sheet';
const API_KEY = 'nexo-secret-2024-urocarrillo';
const EMAIL_COLUMN = 2;  // Column B = Email
const NAME_COLUMN = 1;   // Column A = Name
const STATUS_COLUMN = 5; // Column E = Status
// ===========================================

/**
 * onChange trigger - fires on ANY change including API writes (ManyChat)
 * This is the main trigger for production use
 */
function onChange(e) {
  if (!e || e.changeType !== 'EDIT' && e.changeType !== 'INSERT_ROW') {
    // For other change types, process all pending
    processAllPending();
    return;
  }

  // For edits, process all pending rows
  processAllPending();
}

/**
 * onEdit trigger - fires only on manual edits in the UI
 * Backup trigger for manual testing
 */
function onEdit(e) {
  if (!e || !e.range) return;

  const sheet = e.source.getActiveSheet();
  const row = e.range.getRow();

  // Skip header row
  if (row > 1) {
    processRow(sheet, row);
  }
}

/**
 * Process a single row
 */
function processRow(sheet, row) {
  const statusCell = sheet.getRange(row, STATUS_COLUMN);
  const currentStatus = statusCell.getValue();

  // Skip if already processed
  if (currentStatus === 'SUCCESS' || currentStatus === 'SKIPPED') {
    return;
  }

  const name = sheet.getRange(row, NAME_COLUMN).getValue();
  const email = sheet.getRange(row, EMAIL_COLUMN).getValue();

  // Validate email
  if (!email || !email.toString().includes('@')) {
    statusCell.setValue('SKIPPED');
    return;
  }

  const payload = {
    email: email.toString().trim().toLowerCase(),
    name: name ? name.toString().trim() : undefined,
    source: 'instagram',
    tag: 'general'
  };

  // Remove undefined
  Object.keys(payload).forEach(key => {
    if (payload[key] === undefined) delete payload[key];
  });

  try {
    const response = UrlFetchApp.fetch(WEBHOOK_URL, {
      method: 'POST',
      contentType: 'application/json',
      headers: { 'X-API-Key': API_KEY },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const result = JSON.parse(response.getContentText());
    statusCell.setValue(result.success ? 'SUCCESS' : 'FAILED');

  } catch (error) {
    statusCell.setValue('ERROR');
    Logger.log('Row ' + row + ' error: ' + error.toString());
  }
}

/**
 * Process all rows without SUCCESS status
 */
function processAllPending() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const lastRow = sheet.getLastRow();
  let processed = 0;

  for (let row = 2; row <= lastRow; row++) {
    const status = sheet.getRange(row, STATUS_COLUMN).getValue();

    if (!status || status === 'ERROR' || status === 'FAILED') {
      processRow(sheet, row);
      processed++;
      Utilities.sleep(300); // Rate limit protection
    }
  }

  Logger.log('Processed ' + processed + ' rows');
}

/**
 * Set up the onChange trigger for ManyChat/API writes
 * RUN THIS FUNCTION ONCE after pasting the script
 */
function setupTrigger() {
  // Remove existing triggers from this project
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));

  // Create onChange trigger (catches ManyChat API writes)
  ScriptApp.newTrigger('onChange')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onChange()
    .create();

  // Create onEdit trigger (backup for manual edits)
  ScriptApp.newTrigger('onEdit')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();

  Logger.log('Triggers configured successfully!');
  Logger.log('- onChange: For ManyChat/API writes');
  Logger.log('- onEdit: For manual edits');
}

/**
 * Test webhook connection
 */
function testConnection() {
  try {
    const response = UrlFetchApp.fetch(WEBHOOK_URL, {
      method: 'GET',
      headers: { 'X-API-Key': API_KEY },
      muteHttpExceptions: true
    });
    Logger.log('Status: ' + response.getResponseCode());
    Logger.log('Response: ' + response.getContentText());
    return response.getResponseCode() === 200;
  } catch (error) {
    Logger.log('Error: ' + error);
    return false;
  }
}

/**
 * Add menu to spreadsheet
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Nexo Mail')
    .addItem('Process All Pending', 'processAllPending')
    .addItem('Test Connection', 'testConnection')
    .addItem('Setup Triggers', 'setupTrigger')
    .addToUi();
}
