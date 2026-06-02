const fs = require('fs');
const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const OPEN_WEBUI_URL = 'http://localhost:8080/api/chat/completions';
const API_KEY = process.env.OPEN_WEBUI_API_KEY || 'sk-your-api-key-here';

// Model to benchmark is passed via arguments or env var
const MODEL_NAME = process.argv[2] || process.env.TEST_MODEL_NAME || 'gemma4:e4b';

const REPORTS_DIR = path.join(__dirname, 'reports');
if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
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

        for (let i = 0; i < categoryData.prompts.length; i++) {
            const prompt = categoryData.prompts[i];
            console.log(`   Prompt [${i + 1}/${categoryData.prompts.length}]`);

            messages.push({ role: 'user', content: prompt });

            reportContent += `### Prompt ${i + 1}\n`;
            reportContent += `**User:** ${prompt}\n\n`;

            const startTime = Date.now();
            let assistantResponse = "";

            try {
                const response = await axios.post(
                    OPEN_WEBUI_URL,
                    {
                        model: MODEL_NAME,
                        model_id: MODEL_NAME,
                        messages: messages,
                        stream: true, stream_options: { include_usage: true }, // MUST BE TRUE to trigger TTFT in AI Gateway
                        chat_id: "",
                        session_id: ""
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        responseType: 'stream',
                        timeout: 300000 // 5 minutes 
                    }
                );

                // Read stream
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
                                } catch (e) {
                                    // ignore incomplete chunks or parse errors
                                }
                            }
                        }
                    });
                    response.data.on('end', resolve);
                    response.data.on('error', reject);
                });

                const e2eDuration = Date.now() - startTime;
                const mins = Math.floor(e2eDuration / 60000);
                const secs = ((e2eDuration % 60000) / 1000).toFixed(1);
                const timeStr = `${e2eDuration}ms (${mins}m ${secs}s)`;

                console.log(` Success: ${timeStr}`);

                // Add assistant response to history
                messages.push({ role: 'assistant', content: assistantResponse });

                reportContent += `**Assistant - E2E Time: ${timeStr}:**\n${assistantResponse}\n\n`;
                reportContent += `> **Score (1-10):** ___\n\n---\n\n`;

            } catch (error) {
                const duration = Date.now() - startTime;
                let errorDetail = error.message;
                if (error.response) {
                    errorDetail = `HTTP ${error.response.status}: ${error.response.statusText}`;
                    // If stream fails early, we might not have a body, but we can log the status.
                }
                console.log(`   Failed (${duration}ms): ${errorDetail}`);
                reportContent += `**[ERROR]** Failed to generate response: ${errorDetail}\n\n---\n\n`;
            }
        }
    }

    fs.writeFileSync(reportPath, reportContent);
    console.log(`\n Benchmark complete! Report saved to ${reportPath}`);
    console.log(`Don't forget to check AI Gateway logs for detailed TTFT/TPOT metrics!`);
}

runBenchmark().catch(console.error);
