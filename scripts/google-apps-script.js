/**
 * Google Apps Script for Nexo Mail Lead Automation
 *
 * SETUP INSTRUCTIONS:
 * 1. Open your Google Sheet
 * 2. Go to Extensions > Apps Script
 * 3. Delete any existing code and paste this script
 * 4. Update WEBHOOK_URL and API_KEY with your values
 * 5. Save the project
 * 6. Run the setupTrigger() function once to set up automatic triggers
 *
 * SHEET FORMAT (expected columns):
 * A: Timestamp
 * B: Email
 * C: Name (optional)
 * D: Phone (optional)
 * E: Source (optional, defaults to "instagram")
 * F: Tag (optional, defaults to "general")
 * G: Status (will be updated by script)
 * H: Response (will be updated by script)
 */

// ============== CONFIGURATION ==============
const WEBHOOK_URL = 'https://your-app.vercel.app/api/webhook/sheet';
const API_KEY = 'your-api-secret-key';
// ===========================================

/**
 * Trigger function that runs when a new row is added
 */
function onFormSubmit(e) {
  const sheet = e.source.getActiveSheet();
  const row = e.range.getRow();

  processRow(sheet, row);
}

/**
 * Manual trigger to process a specific row
 */
function processRow(sheet, row) {
  const data = sheet.getRange(row, 1, 1, 6).getValues()[0];

  const [timestamp, email, name, phone, source, tag] = data;

  // Skip if no email
  if (!email || !email.toString().includes('@')) {
    sheet.getRange(row, 7).setValue('SKIPPED');
    sheet.getRange(row, 8).setValue('Invalid or missing email');
    return;
  }

  // Prepare payload
  const payload = {
    email: email.toString().trim().toLowerCase(),
    name: name ? name.toString().trim() : undefined,
    phone: phone ? phone.toString().trim() : undefined,
    source: source ? source.toString().trim() : 'instagram',
    tag: tag ? tag.toString().trim() : 'general'
  };

  // Remove undefined values
  Object.keys(payload).forEach(key => {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  });

  try {
    const response = UrlFetchApp.fetch(WEBHOOK_URL, {
      method: 'POST',
      contentType: 'application/json',
      headers: {
        'X-API-Key': API_KEY
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();
    const responseBody = response.getContentText();

    let status, message;

    try {
      const jsonResponse = JSON.parse(responseBody);
      status = jsonResponse.success ? 'SUCCESS' : 'FAILED';
      message = jsonResponse.message || responseBody;
    } catch {
      status = responseCode === 200 ? 'SUCCESS' : 'FAILED';
      message = responseBody;
    }

    sheet.getRange(row, 7).setValue(status);
    sheet.getRange(row, 8).setValue(message.substring(0, 500)); // Limit length

  } catch (error) {
    sheet.getRange(row, 7).setValue('ERROR');
    sheet.getRange(row, 8).setValue(error.toString().substring(0, 500));
  }
}

/**
 * Process all pending rows (useful for batch processing)
 */
function processAllPending() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const lastRow = sheet.getLastRow();

  for (let row = 2; row <= lastRow; row++) { // Start from row 2 (skip header)
    const status = sheet.getRange(row, 7).getValue();

    // Only process rows without a status or with ERROR status
    if (!status || status === 'ERROR' || status === 'PENDING') {
      processRow(sheet, row);

      // Add a small delay to avoid rate limiting
      Utilities.sleep(500);
    }
  }
}

/**
 * Set up trigger for form submissions
 * Run this function once during initial setup
 */
function setupTrigger() {
  // Remove existing triggers
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'onFormSubmit') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  // Create new trigger
  ScriptApp.newTrigger('onFormSubmit')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onFormSubmit()
    .create();

  Logger.log('Trigger set up successfully!');
}

/**
 * Test the webhook connection
 */
function testConnection() {
  try {
    const response = UrlFetchApp.fetch(WEBHOOK_URL, {
      method: 'GET',
      muteHttpExceptions: true
    });

    Logger.log('Response Code: ' + response.getResponseCode());
    Logger.log('Response Body: ' + response.getContentText());

    return response.getResponseCode() === 200;
  } catch (error) {
    Logger.log('Error: ' + error.toString());
    return false;
  }
}

/**
 * Create menu for manual operations
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Nexo Mail')
    .addItem('Process All Pending', 'processAllPending')
    .addItem('Test Connection', 'testConnection')
    .addItem('Setup Trigger', 'setupTrigger')
    .addToUi();
}
