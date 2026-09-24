/**
 * Apps Script — Sheet "TikTok PROGRAMA Form"
 *
 * QUÉ HACE:
 * 1. Detecta filas nuevas escritas por ManyChat (TikTok DM → mail capturado)
 * 2. POST a Nexo-mail /api/webhook/tiktok-form
 * 3. Nexo-mail manda mail desde mauro@urologia.ar con link al form
 * 4. Escribe SUCCESS/FAILED/SKIPPED/ERROR en col E + timestamp en col F
 * 5. Idempotente: filas con SUCCESS o SKIPPED nunca se reprocesan
 *
 * SETUP (una sola vez):
 * 1. Abrir el sheet → Extensiones → Apps Script
 * 2. Borrar el código existente y pegar este
 * 3. Guardar (Ctrl+S / Cmd+S)
 * 4. En el editor de Apps Script, seleccionar la función `setupTrigger` y darle Ejecutar
 * 5. Aceptar los permisos cuando Google los pida
 * 6. Listo. El script corre automático ante cualquier cambio en el sheet.
 *
 * COLUMNAS DEL SHEET:
 *   A: NOMBRE
 *   B: id de contacto (ManyChat user ID)
 *   C: tiempo
 *   D: mail
 *   E: mail_enviado     ← lo escribe este script
 *   F: fecha_mail_enviado ← lo escribe este script
 *   G: completo_form     (fase 2, manual o script aparte)
 *   H: fecha_completo_form
 */

// ============== CONFIGURACIÓN ==============
const WEBHOOK_URL = 'https://nexo-mail.vercel.app/api/webhook/tiktok-form';
const API_KEY = 'nexo-secret-2024-urocarrillo';

const NAME_COLUMN = 1;        // A
const MANYCHAT_ID_COLUMN = 2; // B
const EMAIL_COLUMN = 4;       // D
const STATUS_COLUMN = 5;      // E (mail_enviado)
const DATE_COLUMN = 6;        // F (fecha_mail_enviado)
// ===========================================

/**
 * onChange — dispara con cualquier cambio en el sheet (incluye writes de ManyChat via API)
 */
function onChange(e) {
  processAllPending();
}

/**
 * onEdit — dispara solo con ediciones manuales en la UI (backup para tests)
 */
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.source.getActiveSheet();
  const row = e.range.getRow();
  if (row > 1) {
    processRow(sheet, row);
  }
}

/**
 * Procesa una fila individual
 */
function processRow(sheet, row) {
  const statusCell = sheet.getRange(row, STATUS_COLUMN);
  const dateCell = sheet.getRange(row, DATE_COLUMN);
  const currentStatus = statusCell.getValue();

  // Idempotencia: si ya fue procesada, no la toques
  if (currentStatus === 'SUCCESS' || currentStatus === 'SKIPPED') {
    return;
  }

  const name = sheet.getRange(row, NAME_COLUMN).getValue();
  const manychatId = sheet.getRange(row, MANYCHAT_ID_COLUMN).getValue();
  const email = sheet.getRange(row, EMAIL_COLUMN).getValue();

  // Email vacío: fila aún incompleta. Salir silencioso, próximo edit lo retomará.
  if (!email) {
    return;
  }

  // Email con contenido pero sin @ = inválido. Marcar SKIPPED para no reintentar.
  if (!email.toString().includes('@')) {
    statusCell.setValue('SKIPPED');
    dateCell.setValue(new Date().toISOString());
    return;
  }

  const payload = {
    email: email.toString().trim().toLowerCase(),
    name: name ? name.toString().trim() : undefined,
    manychat_id: manychatId ? manychatId.toString().trim() : undefined
  };

  // Remover keys undefined
  Object.keys(payload).forEach(function(key) {
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
    dateCell.setValue(new Date().toISOString());

    if (!result.success) {
      Logger.log('Row ' + row + ' FAILED: ' + response.getContentText());
    }

  } catch (error) {
    statusCell.setValue('ERROR');
    dateCell.setValue(new Date().toISOString());
    Logger.log('Row ' + row + ' ERROR: ' + error.toString());
  }
}

/**
 * Procesa todas las filas sin SUCCESS/SKIPPED
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
      Utilities.sleep(300); // rate limit
    }
  }

  Logger.log('Filas procesadas: ' + processed);
}

/**
 * Configurar triggers automáticos. EJECUTAR UNA SOLA VEZ después de pegar el script.
 */
function setupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });

  ScriptApp.newTrigger('onChange')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onChange()
    .create();

  ScriptApp.newTrigger('onEdit')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();

  Logger.log('Triggers configurados:');
  Logger.log('- onChange (para writes de ManyChat / API)');
  Logger.log('- onEdit (para ediciones manuales / tests)');
}

/**
 * Test rápido contra el endpoint (no manda mail, solo verifica que responde)
 */
function testConnection() {
  try {
    const response = UrlFetchApp.fetch(WEBHOOK_URL, {
      method: 'GET',
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
 * Menú custom en el sheet
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('TikTok Form')
    .addItem('Procesar todas las pendientes', 'processAllPending')
    .addItem('Test conexión', 'testConnection')
    .addItem('Setup triggers (1ª vez)', 'setupTrigger')
    .addToUi();
}
