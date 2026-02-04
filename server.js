/*
  SERVER.JS
  
  Instructions:
  1. Create a file named 'server.js' and paste this code.
  2. Create a file named 'package.json' and paste the config from the other tab.
  3. Run 'npm install' then 'npm start'.
*/

import Fastify from 'fastify';
import WebSocket from '@fastify/websocket';
import formBody from '@fastify/formbody';
import cors from '@fastify/cors';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import WebSocketWS from 'ws';

dotenv.config();

const fastify = Fastify({ logger: true });

// Enable CORS with permissive config for dev
await fastify.register(cors, {
  origin: true, // Allow all origins (reflection)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
});

fastify.register(WebSocket);
fastify.register(formBody);

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.GEMINI_API_KEY; 

// Root route
fastify.get('/', async (request, reply) => {
  return { status: 'SalesVoice AI Server Running' };
});

// Explicit OPTIONS handler for preflight checks
fastify.options('/*', async (request, reply) => {
  return reply.send();
});

// 1. OUTBOUND CALL ENDPOINT (Called by Frontend)
fastify.post('/outbound-call', async (request, reply) => {
  const { to, from, accountSid, authToken } = request.body;
  const host = request.headers.host;
  // This URL is what Twilio will call back when the call connects
  const twimlUrl = `https://${host}/incoming-call`;

  console.log(`Initiating call to ${to}...`);

  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const params = new URLSearchParams();
  params.append('Url', twimlUrl);
  params.append('To', to);
  params.append('From', from);

  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(text);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: error.message });
  }
});

// 2. INCOMING CALL WEBHOOK (Called by Twilio)
fastify.all('/incoming-call', async (request, reply) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say>Connecting to Sales Voice AI.</Say>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;
  
  reply.type('text/xml').send(twiml);
});

// 3. MEDIA STREAM WEBSOCKET (Audio Bridge)
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Client connected to media stream');
    
    const ai = new GoogleGenAI({ apiKey: API_KEY });
    let session = null;
    let streamId = null;

    const startGemini = async () => {
      try {
        session = await ai.live.connect({
          model: 'gemini-2.5-flash-native-audio-preview-12-2025',
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } 
            },
            systemInstruction: "You are Alex, a sales agent selling websites for $800. Be concise and professional.",
          },
          callbacks: {
             onopen: () => console.log('Gemini Connected'),
             onmessage: (msg) => {
               if (msg.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                 const audioData = msg.serverContent.modelTurn.parts[0].inlineData.data;
                 if (streamId && connection.readyState === connection.OPEN) {
                   connection.socket.send(JSON.stringify({
                     event: 'media',
                     streamSid: streamId,
                     media: { payload: audioData }
                   }));
                 }
               }
             }
          }
        });
      } catch (err) {
        console.error("Gemini Connect Error:", err);
      }
    };

    startGemini();

    connection.socket.on('message', async (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.event === 'start') {
          streamId = msg.start.streamSid;
        } else if (msg.event === 'media' && session) {
             session.sendRealtimeInput({ 
               media: { mimeType: 'audio/pcm;rate=8000', data: msg.media.payload } 
             });
        }
      } catch (e) {
        console.error("Socket message error", e);
      }
    });

    connection.socket.on('close', () => {
        console.log("Client disconnected");
        // Clean up session if needed
    });
  });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`Server listening on port ${PORT}`);
});
