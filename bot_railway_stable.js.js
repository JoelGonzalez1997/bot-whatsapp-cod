const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config();

const app = express();
const db = new Pool({ 
  connectionString: process.env.DATABASE_URL
});

app.use(express.json());
app.use(express.static('public'));

let sock;

async function connectToWhatsApp() {
  try {
    console.log('🔌 Conectando a WhatsApp...');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, qr } = update;
      
      if (qr) {
        console.log('📱 QR generado');
        qrcode.generate(qr, { small: true });
      }
      
      if (connection === 'open') {
        console.log('✅ WhatsApp conectado');
      }
      
      if (connection === 'close') {
        console.log('❌ Desconectado. Reconectando...');
        setTimeout(connectToWhatsApp, 5000);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message) return;
      
      const from = msg.key.remoteJid;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      
      console.log(`📨 ${from}: ${text.substring(0, 50)}`);
      
      try {
        if (text.includes('Hemos recibido') || text.includes('Easy COD')) {
          await handleNewOrder(text, from);
        } else if (text.trim().toUpperCase() === 'CONFIRMO') {
          await handleConfirm(from);
        }
      } catch (e) {
        console.error('Error:', e.message);
      }
    });
  } catch (error) {
    console.error('❌ Error conexión:', error.message);
    setTimeout(connectToWhatsApp, 10000);
  }
}

async function handleNewOrder(text, from) {
  try {
    const lines = text.split('\n');
    let orderNum = '';
    let custName = 'Cliente';
    let prodName = 'Producto';
    let total = '0';
    let addr = 'Sin dirección';
    let city = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('#')) {
        const m = line.match(/#(\d+)/);
        if (m) orderNum = m[1];
      }
      if (line.toLowerCase().includes('hola')) {
        custName = line.replace(/hola|,/gi, '').trim();
      }
      if (line.includes('$')) {
        const m = line.match(/\$?([\d.]+)/);
        if (m) total = m[1];
      }
      if (line.toLowerCase().includes('dirección')) {
        addr = lines[i+1]?.trim() || addr;
        city = lines[i+2]?.trim() || city;
      }
    }

    const phone = from.replace('@s.whatsapp.net', '').replace('@lid', '');

    await db.query(
      `INSERT INTO orders (easy_cod_order_id, customer_name, customer_phone, product_name, product_total, customer_address1, customer_city, order_status, address_validation, address_confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [orderNum, custName, phone, prodName, total, addr, city, 'PENDIENTE_CONFIRMACION', 'INCOMPLETA', 0]
    );

    const msg = `Hola ${custName} 😊\nGracias por tu pedido #${orderNum}.\n\n📦 ${prodName}\n💰 Total: $${total}\n📍 ${addr}, ${city}\n\n¿Deseas confirmar? Responde: CONFIRMO`;
    
    await sock.sendMessage(from, { text: msg });
    console.log('✅ Mensaje de confirmación enviado');
  } catch (e) {
    console.error('Error handleNewOrder:', e.message);
  }
}

async function handleConfirm(from) {
  try {
    const phone = from.replace('@s.whatsapp.net', '').replace('@lid', '');
    
    const result = await db.query(
      `SELECT * FROM orders WHERE customer_phone = $1 ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    
    if (!result.rows.length) {
      await sock.sendMessage(from, { text: '❌ Pedido no encontrado' });
      return;
    }
    
    const order = result.rows[0];
    
    if (order.order_status === 'CONFIRMADO') {
      console.log('⚠️ Ya estaba confirmado');
      return;
    }
    
    await db.query(
      `UPDATE orders SET order_status = $1 WHERE order_id = $2`,
      ['CONFIRMADO', order.order_id]
    );
    
    const msg = `✅ Perfecto ${order.customer_name}!\n\nTu pedido #${order.easy_cod_order_id} está confirmado.\n\n📦 ${order.product_name}\n💰 Total: $${order.product_total}\n📍 ${order.customer_address1}, ${order.customer_city}\n\n🚚 Será entregado en 48-72 horas.`;
    
    await sock.sendMessage(from, { text: msg });
    console.log('✅ Confirmación enviada');
  } catch (e) {
    console.error('Error handleConfirm:', e.message);
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/panel_simple.html');
});

app.get('/api/orders', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 50');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor puerto ${PORT}`);
  console.log(`📱 Panel: http://localhost:${PORT}\n`);
});

setTimeout(connectToWhatsApp, 2000);

process.on('unhandledRejection', (e) => console.error('Error:', e));
