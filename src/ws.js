// WebSocket mínimo (RFC 6455) sin dependencias: mensajes de texto, ping/pong y cierre. Suficiente para el Pong Pizza.
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function aceptar(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  socket.setNoDelay(true);
  const ws = { abierto: true, onmensaje: () => {}, oncierre: () => {}, ultimo: Date.now() };
  const trama = (op, datos) => {
    const largo = datos.length; let cab;
    if (largo < 126) cab = Buffer.from([0x80 | op, largo]);
    else if (largo < 65536) { cab = Buffer.alloc(4); cab[0] = 0x80 | op; cab[1] = 126; cab.writeUInt16BE(largo, 2); }
    else { cab = Buffer.alloc(10); cab[0] = 0x80 | op; cab[1] = 127; cab.writeBigUInt64BE(BigInt(largo), 2); }
    return Buffer.concat([cab, datos]);
  };
  ws.enviar = (obj) => { if (!ws.abierto) return; try { socket.write(trama(1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)))); } catch (_) { /* socket cerrado */ } };
  ws.cerrar = () => { if (!ws.abierto) return; ws.abierto = false; try { socket.end(trama(8, Buffer.alloc(0))); } catch (_) { /* nada */ } ws.oncierre(); };
  let buf = Buffer.alloc(0), partes = [];
  socket.on('data', (d) => {
    ws.ultimo = Date.now(); buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, mask = (buf[1] & 0x80) !== 0; let largo = buf[1] & 0x7f, pos = 2;
      if (largo === 126) { if (buf.length < 4) return; largo = buf.readUInt16BE(2); pos = 4; }
      else if (largo === 127) { if (buf.length < 10) return; largo = Number(buf.readBigUInt64BE(2)); pos = 10; }
      if (largo > 1e6) { ws.cerrar(); socket.destroy(); return; }
      const total = pos + (mask ? 4 : 0) + largo; if (buf.length < total) return;
      let datos = buf.slice(pos + (mask ? 4 : 0), total);
      if (mask) { const k = buf.slice(pos, pos + 4); datos = Buffer.from(datos.map((b, i) => b ^ k[i % 4])); }
      buf = buf.slice(total);
      if (op === 8) { ws.cerrar(); return; }
      if (op === 9) { try { socket.write(trama(10, datos)); } catch (_) { /* nada */ } continue; }
      if (op === 10) continue;
      partes.push(datos);
      if (fin) { const txt = Buffer.concat(partes).toString('utf8'); partes = []; let m = null; try { m = JSON.parse(txt); } catch (_) { continue; } try { ws.onmensaje(m); } catch (e) { console.warn('WS:', e.message); } }
    }
  });
  const fin = () => { if (ws.abierto) { ws.abierto = false; ws.oncierre(); } };
  socket.on('close', fin); socket.on('error', fin);
  // Ping cada 20 s para que el proxy no corte la conexión; si no responde en 60 s, se cierra
  const ping = setInterval(() => { if (!ws.abierto) return clearInterval(ping); if (Date.now() - ws.ultimo > 60000) { ws.cerrar(); socket.destroy(); return clearInterval(ping); } try { socket.write(trama(9, Buffer.alloc(0))); } catch (_) { /* nada */ } }, 20000);
  return ws;
}
module.exports = { aceptar };
