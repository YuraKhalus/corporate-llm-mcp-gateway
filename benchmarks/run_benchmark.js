const fs = require('fs');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const OPEN_WEBUI_URL = 'http://localhost:8080/api/chat/completions';
const API_KEY = process.env.OPEN_WEBUI_API_KEY || 'sk-your-api-key-here';
const USE_REAL_MCP = process.env.USE_REAL_MCP === 'true';

// Model to benchmark is passed via arguments or env var
const MODEL_NAME = process.argv[2] || process.env.TEST_MODEL_NAME || 'gemma4:e4b';

const REPORTS_DIR = path.join(__dirname, 'reports');
if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// Load System Prompt & Tools
let systemPrompt = "";
try {
    systemPrompt = fs.readFileSync(path.join(__dirname, 'system_prompt.txt'), 'utf8');
} catch (e) {
    console.warn(" system_prompt.txt not found, using empty system prompt.");
}

let mcpTools = [];
try {
    mcpTools = JSON.parse(fs.readFileSync(path.join(__dirname, 'mcp_tools.json'), 'utf8'));
} catch (e) {
    console.warn(" mcp_tools.json not found, tools will not be used.");
}

// Mock tool execution
async function handleToolCall(name, argsStr) {
    if (USE_REAL_MCP) {
        // Future integration: Make real call to MCP Server or CRM API
        return `[REAL MCP NOT YET IMPLEMENTED FOR ${name}]`;
    }

    // MOCK RESPONSES
    console.log(`     -> 🛠️  Executing mock tool: ${name}`);
    if (name === "get_my_clients") {
        return JSON.stringify([{ id: 1, name: "Іван Франко", city: "Київ", email: "ivan@example.com" }]);
    } else if (name === "get_client_details") {
        return JSON.stringify({ client: { name: "Іван Франко", city: "Київ" }, notes: [{ title: "Знайомство", content: "Пройшло успішно" }] });
    } else if (name === "get_team_structure") {
        return JSON.stringify([{ id: 2, name: "Марія", jobTitle: "Менеджер" }]);
    } else if (name === "get_team_analytics") {
        return JSON.stringify([{ consultant: "Я", totalClients: 1, clientsByCity: { "Київ": 1 } }]);
    }
    return JSON.stringify({ success: true, message: `Mock tool ${name} executed successfully.` });
}

async function runBenchmark() {
    console.log(` Starting Benchmark for model: ${MODEL_NAME}`);
    const datasetPath = path.join(__dirname, 'dataset.json');
    const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

    const reportPath = path.join(REPORTS_DIR, `${MODEL_NAME.replace(/:/g, '_')}_Run1.md`);
    let reportContent = `# Benchmark Report for ${MODEL_NAME}\n\n`;
    reportContent += `> Date: ${new Date().toISOString()}\n\n`;

    for (const categoryData of dataset) {
        console.log(`\n📁 Category: ${categoryData.category}`);
        reportContent += `## Category: ${categoryData.category}\n\n`;

        let messages = []; // Context is isolated per category
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        for (let i = 0; i < categoryData.prompts.length; i++) {
            const prompt = categoryData.prompts[i];
            console.log(`   Prompt [${i + 1}/${categoryData.prompts.length}]`);

            messages.push({ role: 'user', content: prompt });

            reportContent += `### Prompt ${i + 1}\n`;
            reportContent += `**User:** ${prompt}\n\n`;

            const trace_id = crypto.randomUUID(); // Unique ID to link agent requests
            let totalE2EDuration = 0;
            let fullAssistantResponse = "";
            let loopCount = 0;
            let errorOccurred = false;

            while (loopCount < 5) { // Max 5 loops to prevent infinite agents
                loopCount++;
                const startTime = Date.now();
                let assistantResponse = "";
                let toolCallsMap = {};

                try {
                    const response = await axios.post(
                        OPEN_WEBUI_URL,
                        {
                            model: MODEL_NAME,
                            model_id: MODEL_NAME,
                            messages: messages,
                            tools: mcpTools.length > 0 ? mcpTools : undefined,
                            stream: true,
                            stream_options: { include_usage: true },
                            chat_id: "",
                            session_id: trace_id
                        },
                        {
                            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
                            responseType: 'stream',
                            timeout: 300000 // 5 minutes 
                        }
                    );

                    await new Promise((resolve, reject) => {
                        response.data.on('data', (chunk) => {
                            const lines = chunk.toString().split('\n');
                            for (const line of lines) {
                                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                                    try {
                                        const parsed = JSON.parse(line.slice(6));
                                        if (parsed.choices?.[0]?.delta?.content) {
                                            assistantResponse += parsed.choices[0].delta.content;
                                        }
                                        if (parsed.choices?.[0]?.delta?.tool_calls) {
                                            for (const tc of parsed.choices[0].delta.tool_calls) {
                                                if (!toolCallsMap[tc.index]) {
                                                    toolCallsMap[tc.index] = {
                                                        id: tc.id,
                                                        type: "function",
                                                        function: { name: tc.function.name, arguments: "" }
                                                    };
                                                }
                                                if (tc.function?.arguments) {
                                                    toolCallsMap[tc.index].function.arguments += tc.function.arguments;
                                                }
                                            }
                                        }
                                    } catch (e) { }
                                }
                            }
                        });
                        response.data.on('end', resolve);
                        response.data.on('error', reject);
                    });

                    totalE2EDuration += (Date.now() - startTime);
                    if (assistantResponse) {
                        fullAssistantResponse += assistantResponse + "\n";
                    }

                    const toolCalls = Object.values(toolCallsMap);

                    if (toolCalls.length > 0) {
                        // Model requested tools
                        messages.push({ role: 'assistant', content: assistantResponse || "", tool_calls: toolCalls });

                        for (const tc of toolCalls) {
                            const result = await handleToolCall(tc.function.name, tc.function.arguments);
                            messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result });
                            fullAssistantResponse += `\n*[Визвано тул: ${tc.function.name}]*\n`;
                        }
                        // Loop continues to send tool result to LLM
                    } else {
                        // No more tools, final response received
                        messages.push({ role: 'assistant', content: assistantResponse });
                        break;
                    }

                } catch (error) {
                    totalE2EDuration += (Date.now() - startTime);
                    let errorDetail = error.message;
                    if (error.response) {
                        errorDetail = `HTTP ${error.response.status}: ${error.response.statusText}`;
                    }
                    console.log(`   Failed (${totalE2EDuration}ms): ${errorDetail}`);
                    reportContent += `**[ERROR]** Failed to generate response: ${errorDetail}\n\n---\n\n`;
                    errorOccurred = true;
                    break;
                }
            }

            if (!errorOccurred) {
                const mins = Math.floor(totalE2EDuration / 60000);
                const secs = ((totalE2EDuration % 60000) / 1000).toFixed(1);
                const timeStr = `${totalE2EDuration}ms (${mins}m ${secs}s)`;
                console.log(`   Success: ${timeStr}`);
                reportContent += `**Assistant - E2E Time: ${timeStr}:**\n${fullAssistantResponse.trim()}\n\n`;
                reportContent += `> **Score (1-10):** ___\n\n---\n\n`;
            }
        }
    }

    fs.writeFileSync(reportPath, reportContent);
    console.log(`\n🎉 Benchmark complete! Report saved to ${reportPath}`);
}

runBenchmark().catch(console.error);
