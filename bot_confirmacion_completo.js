const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config();

const app = express();
const db = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(express.json());
app.use(express.static('public'));

let sock;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\n📱 ESCANEA ESTE CÓDIGO QR:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp(), 5000);
      }
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp conectado correctamente');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0];
    if (!message.message) return;
    
    const from = message.key.remoteJid;
    const text = message.message.conversation || message.message.extendedTextMessage?.text || '';
    
    console.log(`\n📨 ${new Date().toLocaleTimeString()} | De: ${from}`);
    console.log(`   Mensaje: "${text.substring(0, 60)}..."`);
    
    try {
      // DETECTAR MENSAJES DE EASY COD
      if (text.includes('Hemos recibido tu pedido') || text.includes('Easy COD')) {
        console.log('   ✓ Easy COD detectado');
        await handleNewOrder(text, from);
      }
      
      // PROCESAR CONFIRMO (usuario escribe esto)
      else {
        const normalizedText = text.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
        
        if (normalizedText === 'CONFIRMO') {
          console.log('   ✓ Cliente escribió CONFIRMO');
          await handleConfirm(text, from);
        } else {
          console.log('   ⚠️ Mensaje ignorado');
        }
      }
    } catch (error) {
      console.error('❌ ERROR:', error.message);
    }
  });
}

async function handleNewOrder(text, from) {
  console.log('🟡 [NUEVO PEDIDO] INICIANDO');
  
  try {
    const lines = text.split('\n');
    let orderNumber = '';
    let customerName = 'Cliente';
    let productName = 'Producto';
    let productTotal = '0';
    let address1 = 'Sin dirección';
    let city = '';
    let phone = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineLower = line.toLowerCase();
      
      if (line.includes('#')) {
        const match = line.match(/#(\d+)/);
        if (match) orderNumber = match[1];
      }
      
      if (lineLower.includes('hola') && customerName === 'Cliente') {
        customerName = line.replace(/hola|,/gi, '').trim();
      }
      
      if (lineLower.includes('producto') || lineLower.includes('abdominales') || lineLower.includes('soporte') || lineLower.includes('celimax') || lineLower.includes('ejercitador')) {
        if (lines[i+1]) productName = lines[i+1].trim();
      }
      
      if (lineLower.includes('total') && line.includes('$')) {
        const match = line.match(/\$?([\d.]+)/);
        if (match) productTotal = match[1];
      }
      
      if (lineLower.includes('dirección') || lineLower.includes('direccion')) {
        if (lines[i+1]) {
          address1 = lines[i+1].trim();
          if (lines[i+2]) city = lines[i+2].trim();
        }
      }
      
      if (lineLower.includes('teléfono') || lineLower.includes('telefono')) {
        const phoneMatch = line.match(/\+?[\d\s\-()]+/);
        if (phoneMatch) phone = phoneMatch[0].trim();
      }
    }

    if (!phone || phone.length < 5) {
      phone = from.replace('@s.whatsapp.net', '').replace('@lid', '').replace('@', '');
    }

    await db.query(
      `INSERT INTO orders (easy_cod_order_id, customer_name, customer_phone, product_name, product_total, customer_address1, customer_city, order_status, address_validation, address_confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [orderNumber, customerName, phone, productName, productTotal, address1, city, 'PENDIENTE_CONFIRMACION', 'INCOMPLETA', 0]
    );

    const confirmMsg = `Hola ${customerName} 😊\nGracias por tu pedido #${orderNumber}.\n\n📦 ${productName}\n💰 Total: $${productTotal}\n📍 ${address1}, ${city}\n\n¿Deseas confirmar este pedido? Responde con: CONFIRMO`;
    
    await sock.sendMessage(from, { text: confirmMsg });
    console.log('✅ Mensaje enviado - Esperando respuesta del cliente');
    
  } catch (error) {
    console.error('❌ Error handleNewOrder:', error.message);
  }
}

async function handleConfirm(text, from) {
  console.log('🟢 [CONFIRMO] PROCESANDO');
  
  try {
    const phone = from.replace('@s.whatsapp.net', '').replace('@lid', '').replace('@', '');
    
    const result = await db.query(
      `SELECT * FROM orders WHERE customer_phone = $1 ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    
    if (result.rows.length === 0) {
      await sock.sendMessage(from, { text: '❌ No encontramos tu pedido.' });
      return;
    }
    
    const order = result.rows[0];
    console.log('🟢 Orden encontrada:', order.easy_cod_order_id, 'Status:', order.order_status);
    
    if (order.order_status !== 'PENDIENTE_CONFIRMACION') {
      console.log('⚠️ Orden no está pendiente, ignorando');
      return;
    }
    
    await db.query(
      `UPDATE orders SET order_status = $1, updated_at = NOW() WHERE order_id = $2`,
      ['CONFIRMADO', order.order_id]
    );
    
    const responseMsg = `✅ Perfecto ${order.customer_name}!\n\nTu pedido #${order.easy_cod_order_id} está confirmado.\n\n📦 ${order.product_name}\n💰 Total: $${order.product_total}\n📍 ${order.customer_address1}, ${order.customer_city}\n\n🚚 Tu pedido será entregado en 48-72 horas hábiles.`;
    
    await sock.sendMessage(from, { text: responseMsg });
    console.log('✅ Confirmación enviada');
    
  } catch (error) {
    console.error('❌ Error handleConfirm:', error.message);
  }
}

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/panel_simple.html');
});

app.get('/api/orders', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 50');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`📱 Panel: http://localhost:${PORT}\n`);
});

connectToWhatsApp();
