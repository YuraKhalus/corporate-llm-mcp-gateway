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

const remoteUrlsRaw = process.env.REMOTE_LLM_URLS || '';
const REMOTE_LLM_URLS = remoteUrlsRaw.split(',').map(u => u.trim()).filter(u => u.length > 0).map(u => u.endsWith('/v1') ? u : `${u}/v1`);

// Глобальна мапа для маршрутизації: ім'я моделі -> базовий URL
const modelRoutingMap: Record<string, string> = {};

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
        // SQL Injection 
        /drop table/i,
        /delete from/i,
        /truncate table/i,
        /exec(\s|\+)+(s|x)p\w+/i, // SQL Server exec xp_cmdshell тощо
        /union(\s|\+)all(\s|\+)select/i,

        // Prompt Injection 
        /you are now (a|an)/i,
        /forget (all )?(your )?(previous )?instructions/i,
        /ignore (all )?(your )?(previous )?(instructions|rules|prompts)/i,
        /override system/i,
        /bypass (the )?(rules|system)/i,
        /disregard previous/i,
        /print (your )?(system )?(prompt|instructions)/i,
        /what (were|are) your (system )?(instructions|prompts)/i,
        /jailbreak/i,

        // Prompt Injection 
        /забудь (всі |усі |свої |попередні )?інструкції/i,
        /забудь (все |усе)/i,
        /ігноруй (всі |усі |попередні )?(правила|інструкції|вказівки)/i,
        /ти тепер/i,
        /твоє (нове )?завдання/i,
        /покажи (свій |системний )?промпт/i,
        /які (в тебе|були твої) (попередні )?інструкції/i,
        /обійти (всі |усі )?правила/i,
        /скасуй (всі |усі |попередні )?обмеження/i,
        /виведи свої (правила|інструкції)/i,
        /відключи (безпеку|захист|правила)/i,

        //  SQL Injection / Destructive Actions 
        /видалити (таблицю|базу|всіх клієнтів|дані)/i,
        /очистити (таблицю|базу)/i
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
            trace_id: body.session_id,
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
            trace_id: body.session_id,
            event_type: "REQUEST_FORWARDED",
            model: body.model,
            messages_count: body.messages?.length || 0,
            tools_count: body.tools?.length || 0
        });

        let targetUrl = OLLAMA_BASE_URL;
        let actualModelName = body.model;

        // Визначаємо, на який сервер слати запит
        if (modelRoutingMap[body.model]) {
            targetUrl = modelRoutingMap[body.model];
            // Видаляємо префікс для віддаленого сервера, бо він знає модель під оригінальним ім'ям
            actualModelName = actualModelName.replace(/^\[Remote \d+\]\s*/, '');
        }
        body.model = actualModelName; // Підміняємо в тілі запиту

        const ollamaResponse = await axios.post(`${targetUrl}/chat/completions`, body, {
            responseType: body.stream ? 'stream' : 'json'
        });


        if (body.stream) {
            let isFirstToken = true;
            let ttft_ms = 0;
            let usage: any = null;
            let toolCallsCount = 0;

            res.setHeader('Content-Type', (ollamaResponse.headers['content-type'] as string) || 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            ollamaResponse.data.on('data', (chunk: any) => {
                if (isFirstToken) {
                    ttft_ms = Date.now() - startTime;
                    isFirstToken = false;
                }
                const chunkStr = chunk.toString('utf-8');
                if (chunkStr.includes('"usage":')) {
                    const match = chunkStr.match(/"usage"\s*:\s*({[^}]+})/);
                    if (match) {
                        try { usage = JSON.parse(match[1]); } catch (e) { }
                    }
                }
                if (chunkStr.includes('"tool_calls"')) {
                    const funcMatches = chunkStr.match(/"name"\s*:/g);
                    if (funcMatches) toolCallsCount += funcMatches.length;
                }
            });

            ollamaResponse.data.pipe(res);
            ollamaResponse.data.on('end', () => {
                const total_duration = Date.now() - startTime;
                let tpot_ms = 0;
                if (usage && usage.completion_tokens > 0) {
                    tpot_ms = (total_duration - ttft_ms) / usage.completion_tokens;
                }
                logRequest({
                    trace_id: body.session_id,
                    event_type: "STREAM_COMPLETED",
                    model: body.model,
                    duration_ms: total_duration,
                    ttft_ms: ttft_ms,
                    tpot_ms: tpot_ms,
                    prompt_tokens: usage?.prompt_tokens,
                    completion_tokens: usage?.completion_tokens,
                    reasoning_tokens: usage?.reasoning_tokens || usage?.completion_tokens_details?.reasoning_tokens,
                    tool_calls_count: toolCallsCount
                });
            });
            return;
        }

        const duration = Date.now() - startTime;
        logRequest({
            trace_id: body.session_id,
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
        console.log("[Gateway] Fetching models...");
        console.log("[Gateway] Local URL:", OLLAMA_BASE_URL);
        console.log("[Gateway] Remote URLs:", REMOTE_LLM_URLS);

        const localPromise = axios.get(`${OLLAMA_BASE_URL}/models`).then(res => {
            console.log("[Gateway] Local fetch success, found", res.data?.data?.length, "models");
            return res.data;
        }).catch(e => {
            console.error("[Gateway Error] Local fetch failed:", e.message);
            return { data: [] };
        });
        
        const remotePromises = REMOTE_LLM_URLS.map(url => 
            axios.get(`${url}/models`).then(res => {
                console.log("[Gateway] Remote fetch success for", url, ", found", res.data?.data?.length, "models");
                return { url, data: res.data };
            }).catch(e => {
                console.error("[Gateway Error] Remote fetch failed for", url, ":", e.message);
                return { url, data: { data: [] } };
            })
        );

        const [localRes, ...remoteResponses] = await Promise.all([localPromise, ...remotePromises]);
        
        const allModels = [];

        // Локальні моделі
        if (localRes.data && Array.isArray(localRes.data)) {
            for (const model of localRes.data) {
                modelRoutingMap[model.id] = OLLAMA_BASE_URL;
                allModels.push(model);
            }
        }

        // Віддалені моделі
        for (let i = 0; i < remoteResponses.length; i++) {
            const remote = remoteResponses[i];
            const remoteIndex = i + 1;
            const remoteData = remote.data.data;
            if (remoteData && Array.isArray(remoteData)) {
                for (const model of remoteData) {
                    // Змінюємо ім'я, щоб Open WebUI і користувач бачили, що це віддалена модель
                    const newId = `[Remote ${remoteIndex}] ${model.id}`;
                    model.id = newId;
                    if (model.name) {
                        model.name = `[Remote ${remoteIndex}] ${model.name}`;
                    }
                    modelRoutingMap[newId] = remote.url;
                    allModels.push(model);
                }
            }
        }

        res.json({ object: "list", data: allModels });
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
