const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// WhatsApp client configuration
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

// Global variables
let qrCodeData = null;
let isAuthenticated = false;
let webhookUrl = process.env.WEBHOOK_URL || 'https://n8n-io-rjmy.onrender.com/webhook/wa-automation';

// WhatsApp event handlers
client.on('qr', async (qr) => {
    console.log('QR Code received, generating image...');
    try {
        qrCodeData = await qrcode.toDataURL(qr);
        console.log('QR Code generated successfully');
    } catch (error) {
        console.error('Error generating QR code:', error);
    }
});

client.on('ready', () => {
    console.log('WhatsApp client is ready!');
    isAuthenticated = true;
    qrCodeData = null;
});

client.on('authenticated', () => {
    console.log('WhatsApp client is authenticated!');
    isAuthenticated = true;
});

client.on('auth_failure', (msg) => {
    console.error('WhatsApp authentication failed:', msg);
    isAuthenticated = false;
});

client.on('disconnected', (reason) => {
    console.log('WhatsApp client was disconnected:', reason);
    isAuthenticated = false;
    qrCodeData = null;
});

client.on('message', async (message) => {
    console.log('New message received:', {
        from: message.from,
        body: message.body,
        type: message.type
    });

    try {
        // Safely get chat info
        const chat = await message.getChat();
        const messageData = {
            sender: message.from,
            message: message.body,
            timestamp: message.timestamp,
            type: message.type,
            chatId: chat.id._serialized,
            isGroup: chat.isGroup
        };

        // Handle media messages
        if (message.hasMedia) {
            try {
                const media = await message.downloadMedia();
                messageData.media = {
                    mimetype: media.mimetype,
                    data: media.data,
                    filename: media.filename
                };
                console.log('Media attached:', media.mimetype);
            } catch (mediaError) {
                console.error('Error downloading media:', mediaError);
                messageData.mediaError = mediaError.message;
            }
        }

        // Send to webhook
        if (webhookUrl) {
            try {
                const response = await axios.post(webhookUrl, messageData, {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                });
                console.log('Webhook sent successfully:', response.status);
            } catch (webhookError) {
                console.error('Error sending webhook:', webhookError.message);
            }
        } else {
            console.log('No webhook URL configured, message data:', messageData);
        }
    } catch (error) {
        console.error('Error processing message:', error);
    }
});

// Routes

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        whatsapp: {
            authenticated: isAuthenticated,
            hasQr: !!qrCodeData
        },
        webhook: webhookUrl
    });
});

// QR code endpoint
app.get('/qr', (req, res) => {
    if (!qrCodeData) {
        return res.status(404).json({
            error: 'QR code not available',
            message: isAuthenticated ? 'WhatsApp is already authenticated' : 'QR code not generated yet'
        });
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp QR Code</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    min-height: 100vh;
                    margin: 0;
                    background-color: #f0f0f0;
                }
                .container {
                    text-align: center;
                    background: white;
                    padding: 2rem;
                    border-radius: 10px;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                }
                h1 {
                    color: #25D366;
                    margin-bottom: 1rem;
                }
                img {
                    max-width: 300px;
                    border: 2px solid #25D366;
                    border-radius: 10px;
                }
                .status {
                    margin-top: 1rem;
                    padding: 0.5rem;
                    border-radius: 5px;
                    background-color: #e8f5e8;
                    color: #2e7d32;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>WhatsApp QR Code</h1>
                <img src="${qrCodeData}" alt="WhatsApp QR Code" />
                <div class="status">
                    Scan this QR code with your WhatsApp mobile app to authenticate
                </div>
            </div>
        </body>
        </html>
    `);
});

// Send message endpoint
app.post('/send', async (req, res) => {
    try {
        const { number, message } = req.body;

        if (!number || !message) {
            return res.status(400).json({
                error: 'Missing required fields',
                required: ['number', 'message']
            });
        }

        if (!isAuthenticated) {
            return res.status(400).json({
                error: 'WhatsApp not authenticated',
                message: 'Please scan the QR code first at /qr endpoint'
            });
        }

        // Format phone number (remove + if present and ensure it has country code)
        let formattedNumber = number.replace(/[^\d]/g, '');
        if (!formattedNumber.endsWith('@c.us')) {
            formattedNumber += '@c.us';
        }

        // Send message
        const response = await client.sendMessage(formattedNumber, message);
        
        console.log('Message sent successfully:', {
            to: formattedNumber,
            message: message,
            id: response.id._serialized
        });

        res.json({
            success: true,
            message: 'Message sent successfully',
            data: {
                to: formattedNumber,
                messageId: response.id._serialized,
                timestamp: response.timestamp
            }
        });

    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({
            error: 'Failed to send message',
            message: error.message
        });
    }
});

// Update webhook URL endpoint
app.post('/webhook', (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({
            error: 'Missing webhook URL'
        });
    }

    webhookUrl = url;
    console.log('Webhook URL updated to:', webhookUrl);
    
    res.json({
        success: true,
        message: 'Webhook URL updated successfully',
        webhook: webhookUrl
    });
});

// Get status endpoint
app.get('/status', (req, res) => {
    res.json({
        whatsapp: {
            authenticated: isAuthenticated,
            hasQr: !!qrCodeData
        },
        webhook: webhookUrl,
        timestamp: new Date().toISOString()
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        error: 'Internal server error',
        message: error.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Route not found',
        availableRoutes: [
            'GET /',
            'GET /qr',
            'GET /status',
            'POST /send',
            'POST /webhook'
        ]
    });
});

// Start server
async function startServer() {
    try {
        // Initialize WhatsApp client
        console.log('Initializing WhatsApp client...');
        await client.initialize();
        
        // Start Express server
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
            console.log(`QR Code available at: http://localhost:${PORT}/qr`);
            console.log(`Status available at: http://localhost:${PORT}/status`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    try {
        await client.destroy();
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    try {
        await client.destroy();
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

// Start the server
startServer(); 