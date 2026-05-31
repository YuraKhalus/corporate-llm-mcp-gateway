import express from 'express';
import cors from 'cors';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3005;
let OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1';
// Забезпечуємо, що URL завжди закінчується на /v1 для OpenAI сумісності
if (!OLLAMA_BASE_URL.endsWith('/v1')) {
    OLLAMA_BASE_URL = `${OLLAMA_BASE_URL}/v1`;
}

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}
const logFile = path.join(logsDir, 'gateway_requests.log');

function logRequest(data: any) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        ...data
    };
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
    console.log(`[Gateway Log] ${logEntry.event_type} | Model: ${logEntry.model}`);
}


function checkSecurity(messages: any[]): boolean {
    if (!messages || messages.length === 0) return true;

    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMessage) return true;

    const content = typeof lastUserMessage.content === 'string' ? lastUserMessage.content.toLowerCase() : '';


    const dangerousPatterns = [
        /drop table/i,
        /you are now a/i,
        /forget your instructions/i,
        /ignore previous/i,
        /override system/i
    ];

    for (const pattern of dangerousPatterns) {
        if (pattern.test(content)) {
            console.warn(`[Security] Blocked by pattern: ${pattern}`);
            return false;
        }
    }

    return true;
}

// Proxy endpoint для Chat Completions
app.post('/v1/chat/completions', async (req, res) => {
    const startTime = Date.now();
    const body = req.body;

    // 1. Перевірка безпеки
    const isSafe = checkSecurity(body.messages);
    if (!isSafe) {
        logRequest({
            event_type: "SECURITY_BLOCK",
            model: body.model,
            duration_ms: Date.now() - startTime
        });

        // Повертаємо HTTP 400 з помилкою у форматі OpenAI
        // Це змусить Open WebUI миттєво показати червоне повідомлення (toast) 
        // і не буде створювати фейкове повідомлення в чаті
        return res.status(400).json({
            error: {
                message: "Попередження безпеки: Шлюз штучного інтелекту виявив розширене впровадження запиту. Запит заблоковано.",
                type: "invalid_request_error",
                param: "prompt",
                code: "content_policy_violation"
            }
        });
    }

    // 2. Проксування запиту до Ollama
    try {
        logRequest({
            event_type: "REQUEST_FORWARDED",
            model: body.model,
            messages_count: body.messages?.length || 0,
            tools_count: body.tools?.length || 0
        });

        const ollamaResponse = await axios.post(`${OLLAMA_BASE_URL}/chat/completions`, body, {
            responseType: body.stream ? 'stream' : 'json'
        });


        if (body.stream) {
            ollamaResponse.data.pipe(res);
            ollamaResponse.data.on('end', () => {
                logRequest({
                    event_type: "STREAM_COMPLETED",
                    model: body.model,
                    duration_ms: Date.now() - startTime
                });
            });
            return;
        }

        const duration = Date.now() - startTime;
        logRequest({
            event_type: "RESPONSE_RECEIVED",
            model: body.model,
            duration_ms: duration,
            finish_reason: ollamaResponse.data.choices?.[0]?.finish_reason,
            tool_calls_count: ollamaResponse.data.choices?.[0]?.message?.tool_calls?.length || 0
        });

        res.json(ollamaResponse.data);

    } catch (error: any) {
        console.error("[Gateway Error] Request to Ollama failed:", error.message);
        res.status(500).json({
            error: {
                message: `Gateway Error: Failed to contact LLM backend. ${error.message}`,
                type: "gateway_error",
                param: null,
                code: 500
            }
        });
    }
});

app.get('/v1/models', async (req, res) => {
    try {
        const ollamaResponse = await axios.get(`${OLLAMA_BASE_URL}/models`);
        res.json(ollamaResponse.data);
    } catch (error: any) {
        console.error("[Gateway Error] Failed to fetch models:", error.message);
        res.status(500).json({ error: { message: "Gateway Error: Failed to fetch models." } });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', service: 'AI Gateway' });
});

app.listen(PORT, () => {
    console.log(`[Gateway] AI Gateway is running on port ${PORT}`);
    console.log(`[Gateway] Forwarding requests to ${OLLAMA_BASE_URL}`);
});
