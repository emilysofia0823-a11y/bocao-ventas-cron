// Envía por WhatsApp (vía Kapso) el resumen de ventas del día a la 1am hora Bogotá.
const cron = require('node-cron');

const FIREBASE_PROJECT_ID = 'e703-18361';
const FIREBASE_API_KEY = 'AIzaSyB7fkzZNNNY5oWt5oSAT-2wSwtJh69TKvs';

const KAPSO_API_KEY = process.env.KAPSO_API_KEY;
const KAPSO_PHONE_NUMBER_ID = process.env.KAPSO_PHONE_NUMBER_ID;

// Formato env var ADMIN_PHONES: "573001234567,573009876543" (con código de país, sin +)
function getDestinatarios() {
  var raw = process.env.ADMIN_PHONES || '';
  return raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function parseFirestoreValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return parseFirestoreFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(parseFirestoreValue);
  return null;
}
function parseFirestoreFields(fields) {
  var obj = {};
  Object.keys(fields || {}).forEach(function (k) { obj[k] = parseFirestoreValue(fields[k]); });
  return obj;
}

async function obtenerPedidos() {
  var base = 'https://firestore.googleapis.com/v1/projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents/pedidos';
  var pedidos = [];
  var pageToken = null;
  do {
    var url = base + '?key=' + FIREBASE_API_KEY + '&pageSize=300' + (pageToken ? '&pageToken=' + pageToken : '');
    var res = await fetch(url);
    var data = await res.json();
    (data.documents || []).forEach(function (doc) {
      pedidos.push(parseFirestoreFields(doc.fields));
    });
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return pedidos;
}

function fmt(n) {
  return '$' + Math.round(n || 0).toLocaleString('es-CO');
}

function calcularResumen(pedidos, startISO, endISO) {
  var delDia = pedidos.filter(function (p) { return p.fecha && p.fecha >= startISO && p.fecha < endISO; });
  var pagados = delDia.filter(function (p) { return !!p.metodoPago; });
  var pendientes = delDia.filter(function (p) { return !p.metodoPago; });

  var totalCobrado = 0, domTotal = 0, domCnt = 0, recCnt = 0, totalPendiente = 0;
  var pago = { efectivo: 0, nequi: 0, transferencia: 0 };

  delDia.forEach(function (p) { if (p.tipo === 'domicilio') domCnt++; else recCnt++; });

  pagados.forEach(function (p) {
    totalCobrado += p.total || 0;
    if (p.tipo === 'domicilio') domTotal += p.costoEnvio || 0;
    if (p.metodoPago) pago[p.metodoPago] = (pago[p.metodoPago] || 0) + (p.total || 0);
  });
  pendientes.forEach(function (p) { totalPendiente += p.total || 0; });

  return {
    totalCobrado: totalCobrado, totalPendiente: totalPendiente,
    pedidos: delDia.length, pagadosCnt: pagados.length, pendientesCnt: pendientes.length,
    domTotal: domTotal, domCnt: domCnt, recCnt: recCnt,
    pago: pago, promedio: pagados.length ? totalCobrado / pagados.length : 0
  };
}

var DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function construirMensaje(resumen, businessDay) {
  var fechaLabel = DIAS[businessDay.getUTCDay()] + ' ' + businessDay.getUTCDate() + ' de ' + MESES[businessDay.getUTCMonth()];
  var msg = '📊 *Resumen Boca\'o* — ' + fechaLabel + '\n\n';
  msg += '💰 Total cobrado: ' + fmt(resumen.totalCobrado) + '\n';
  msg += '🧾 Pedidos tomados: ' + resumen.pedidos + ' (' + resumen.pagadosCnt + ' cobrados, ' + resumen.pendientesCnt + ' pendientes)\n';
  msg += '🛵 Domicilio: ' + resumen.domCnt + '   🏃 Recoger: ' + resumen.recCnt + '\n';
  msg += '📦 Envíos cobrados: ' + fmt(resumen.domTotal) + '\n';
  msg += '🎫 Ticket promedio: ' + fmt(resumen.promedio) + '\n\n';
  msg += '*Desglose de pago:*\n';
  msg += '💵 Efectivo: ' + fmt(resumen.pago.efectivo) + '\n';
  msg += '📱 Nequi: ' + fmt(resumen.pago.nequi) + '\n';
  msg += '🏦 Transferencia: ' + fmt(resumen.pago.transferencia);
  if (resumen.pendientesCnt > 0) {
    msg += '\n\n⚠️ Quedaron ' + resumen.pendientesCnt + ' pedido(s) sin cobrar por ' + fmt(resumen.totalPendiente);
  }
  return msg;
}

async function enviarWhatsapp(phone, mensaje) {
  var url = 'https://api.kapso.ai/meta/whatsapp/v24.0/' + KAPSO_PHONE_NUMBER_ID + '/messages';
  try {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': KAPSO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: mensaje }
      })
    });
    var data = await res.text();
    console.log('Enviado a', phone, '- status', res.status, data);
  } catch (e) {
    console.error('Error enviando a', phone, e.message);
  }
}

async function correrResumenDiario() {
  console.log('Ejecutando resumen diario...', new Date().toISOString());
  if (!KAPSO_API_KEY || !KAPSO_PHONE_NUMBER_ID) {
    console.log('Faltan KAPSO_API_KEY o KAPSO_PHONE_NUMBER_ID. Nada que enviar.');
    return;
  }
  var destinatarios = getDestinatarios();
  if (destinatarios.length === 0) {
    console.log('Sin destinatarios configurados (ADMIN_PHONES vacío). Nada que enviar.');
    return;
  }
  // Bogotá no tiene horario de verano: UTC-5 siempre.
  var bogotaNow = new Date(Date.now() - 5 * 60 * 60 * 1000);
  var businessDay = new Date(bogotaNow.getTime() - 24 * 60 * 60 * 1000); // día que acaba de terminar
  var y = businessDay.getUTCFullYear(), m = businessDay.getUTCMonth(), d = businessDay.getUTCDate();
  var startUTC = new Date(Date.UTC(y, m, d, 5, 0, 0)); // medianoche Bogotá = 05:00 UTC
  var endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);

  var pedidos = await obtenerPedidos();
  var resumen = calcularResumen(pedidos, startUTC.toISOString(), endUTC.toISOString());
  var mensaje = construirMensaje(resumen, businessDay);
  console.log(mensaje);

  for (var i = 0; i < destinatarios.length; i++) {
    await enviarWhatsapp(destinatarios[i], mensaje);
  }
}

// Todos los días a la 1:00am hora Bogotá
cron.schedule('0 1 * * *', correrResumenDiario, { timezone: 'America/Bogota' });
console.log('Cron de ventas diarias iniciado. Esperando la 1:00am (Bogotá)...');

// Permite probar manualmente: RUN_NOW=1 node cron.js
if (process.env.RUN_NOW === '1') { correrResumenDiario(); }
