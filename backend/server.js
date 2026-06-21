import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let clients = [];

wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket');
    clients.push(ws);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            // Broadcast to other clients (e.g. from AI Server to Frontend)
            const outMessage = JSON.stringify(data);
            clients.forEach(client => {
                if (client !== ws && client.readyState === 1) { // 1 = OPEN
                    client.send(outMessage);
                }
            });
        } catch (e) {
            console.error('Invalid message format received via WS', e);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        clients = clients.filter(c => c !== ws);
    });
});

const broadcast = (data) => {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === 1) { // OPEN
            client.send(message);
        }
    });
};

app.post('/api/command', (req, res) => {
    const command = req.body;
    if (!command || !command.type) {
        return res.status(400).json({ error: 'Invalid command type' });
    }

    broadcast(command);
    res.json({ success: true, command });
});

server.listen(port, () => {
    console.log(`VRoid API Server running at http://localhost:${port}`);
    console.log('Waiting for WebSocket connections...');
});
