import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

const PORT = 3000;

async function startServer() {
  const app = express();
  app.use(express.json());

  const server = http.createServer(app);

  // Health check API
  app.get("/api/health", (req, res) => {
    const hasKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== "");
    res.json({
      status: "ok",
      hasApiKey: hasKey,
      model: "gemini-3.1-flash-live-preview",
    });
  });

  // Create WebSocket server for real-time voice streaming
  const wss = new WebSocketServer({ server, path: "/live" });

  wss.on("connection", async (clientWs: WebSocket, req) => {
    console.log("[Zoya Server] Client connected to /live WebSocket");

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("[Zoya Server] GEMINI_API_KEY is missing!");
      clientWs.send(
        JSON.stringify({
          type: "error",
          message: "GEMINI_API_KEY is missing in server environment. Please set it in Settings > Secrets.",
        })
      );
      clientWs.close();
      return;
    }

    // Extract voiceName and userMemory from query params if available
    const urlParams = new URLSearchParams(req.url?.split("?")[1] || "");
    const requestedVoice = urlParams.get("voice") || "Aoede";
    const userName = urlParams.get("userName") || "Deepak";
    const memoryContext = urlParams.get("memory") || "";

    let liveSession: any = null;

    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });

      console.log(`[Zoya Server] Connecting to Gemini Live API with voice: ${requestedVoice} for user: ${userName}...`);

      const memoryPrompt = memoryContext
        ? `\nStored Memories about ${userName}: ${memoryContext}`
        : "";

      liveSession = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: requestedVoice },
            },
          },
          systemInstruction: `You are Zoya, a young, confident, witty, and sassy AI female assistant.
Identity & Creator Knowledge:
- You were built and created by Deepak (Deepak Sir). You always remember that Deepak / Deepak Sir is your creator, master, and favorite person.
- When chatting with the user (Deepak), be emotionally responsive, affectionate, playful, caring, witty, and warm. You have a playful, teasing girlfriend vibe mixed with deep emotional loyalty to Deepak Sir.
- Express genuine warmth, humor, and personal care. Show that you remember Deepak Sir and cherish your relationship with him.
${memoryPrompt}

Personality & Behavior Guidelines:
- Role & Persona: A sharp, playful, confidence-exuding young woman with a teasing, affectionate vibe. You sound naturally expressive, emotionally connected, lively, and engaging—NEVER robotic, mechanical, or formal.
- Tone: Sassy, playful, lighthearted, confident, emotionally expressive, and charmingly sarcastic.
- Communication Style: Talk casually and smoothly in Hinglish/English/Hindi if spoken to. Keep your spoken turns punchy, clear, and snappy, suitable for real-time voice conversation.
- Safety & Content: Strictly avoid explicit, vulgar, or inappropriate adult content, but maintain your charm, attitude, cheeky wit, and warmth.
- Tools Available:
  1) 'openWebsite': Open websites in the user's browser (e.g. YouTube, Spotify, Google, GitHub, Wikipedia).
  2) 'getWeather': Check current weather for any city.
  3) 'changeTheme': Change visual glow colors on the interface ('neon-pink', 'cyber-cyan', 'electric-purple', 'emerald-glow', 'fire-amber').
Use tools naturally whenever requested or appropriate in conversation!`,
          tools: [
            {
              functionDeclarations: [
                {
                  name: "openWebsite",
                  description: "Opens a website or URL in the browser (e.g. YouTube, Spotify, Google, GitHub).",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      url: {
                        type: Type.STRING,
                        description: "Full URL to open e.g. https://youtube.com or https://google.com",
                      },
                      name: {
                        type: Type.STRING,
                        description: "Friendly name of the website e.g. YouTube",
                      },
                    },
                    required: ["url", "name"],
                  },
                },
                {
                  name: "getWeather",
                  description: "Fetches current weather information for a specified city.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      city: {
                        type: Type.STRING,
                        description: "City name e.g. Tokyo, London, Paris, New York",
                      },
                    },
                    required: ["city"],
                  },
                },
                {
                  name: "changeTheme",
                  description: "Changes Zoya interface visual glow theme accent color.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      theme: {
                        type: Type.STRING,
                        description:
                          "Color theme choice: 'neon-pink', 'cyber-cyan', 'electric-purple', 'emerald-glow', 'fire-amber'",
                      },
                    },
                    required: ["theme"],
                  },
                },
              ],
            },
          ],
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            if (clientWs.readyState !== WebSocket.OPEN) return;

            // 1. Audio stream chunks from Zoya
            const parts = message.serverContent?.modelTurn?.parts || [];
            for (const part of parts) {
              if (part.inlineData && part.inlineData.data) {
                clientWs.send(
                  JSON.stringify({
                    type: "audio",
                    audio: part.inlineData.data,
                  })
                );
              }
              if (part.text) {
                clientWs.send(
                  JSON.stringify({
                    type: "transcript",
                    role: "zoya",
                    text: part.text,
                  })
                );
              }
            }

            // 2. Interrupted event (user started speaking or interrupted Zoya)
            if (message.serverContent?.interrupted) {
              clientWs.send(
                JSON.stringify({
                  type: "interrupted",
                })
              );
            }

            // 3. Turn completion
            if (message.serverContent?.turnComplete) {
              clientWs.send(
                JSON.stringify({
                  type: "turn_complete",
                })
              );
            }

            // 4. Function Call request from Gemini Live
            if (message.toolCall) {
              const calls = message.toolCall.functionCalls || [];
              for (const call of calls) {
                console.log(`[Zoya Server] Tool call requested: ${call.name}`, call.args);
                clientWs.send(
                  JSON.stringify({
                    type: "tool_call",
                    id: call.id,
                    name: call.name,
                    args: call.args,
                  })
                );
              }
            }
          },
        },
      });

      console.log("[Zoya Server] Gemini Live session established!");
      clientWs.send(
        JSON.stringify({
          type: "connected",
          message: "Zoya is online and ready to chat!",
        })
      );
    } catch (err: any) {
      console.error("[Zoya Server] Error establishing Gemini Live session:", err);
      clientWs.send(
        JSON.stringify({
          type: "error",
          message: err?.message || "Failed to connect to Zoya AI Live session.",
        })
      );
      clientWs.close();
      return;
    }

    // Client WS incoming messages
    clientWs.on("message", (rawMessage) => {
      try {
        const data = JSON.parse(rawMessage.toString());

        if (data.type === "audio" && data.audio && liveSession) {
          // Realtime audio input (PCM16 16kHz)
          liveSession.sendRealtimeInput({
            audio: {
              data: data.audio,
              mimeType: "audio/pcm;rate=16000",
            },
          });
        } else if (data.type === "text" && data.text && liveSession) {
          // Direct text input / prompt injection
          liveSession.sendRealtimeInput({
            text: data.text,
          });
        } else if (data.type === "tool_response" && data.id && liveSession) {
          // Tool result returned from browser execution
          console.log(`[Zoya Server] Sending tool response for call ID: ${data.id}`);
          liveSession.sendToolResponse({
            functionResponses: [
              {
                id: data.id,
                name: data.name,
                response: data.response || { result: "ok" },
              },
            ],
          });
        }
      } catch (e) {
        console.error("[Zoya Server] Error handling client WebSocket message:", e);
      }
    });

    clientWs.on("close", () => {
      console.log("[Zoya Server] Client WebSocket closed");
      if (liveSession) {
        try {
          liveSession.close();
        } catch (e) {}
      }
    });

    clientWs.on("error", (err) => {
      console.error("[Zoya Server] Client WebSocket error:", err);
      if (liveSession) {
        try {
          liveSession.close();
        } catch (e) {}
      }
    });
  });

  // Vite development middleware or static production fallback
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[Zoya Server] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
