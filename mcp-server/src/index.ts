import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";


// 1. Ініціалізація екземпляра MCP Сервера
const server = new Server(
    {
        name: "corporate-crm-mcp-server",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// 2. Декларація (опис) інструментів, які сервер надає для ШІ-моделі
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "get_mock_crm_lead",
                description: "Отримати тестову інформацію про ліда (клієнта) з корпоративної системи",
                inputSchema: {
                    type: "object",
                    properties: {
                        leadId: {
                            type: "string",
                            description: "Унікальний ідентифікатор ліда (наприклад: 'lead-123')",
                        },
                    },
                    required: ["leadId"],
                },
            },
        ],
    };
});

// 3. Імплементація логіки виконання інструментів
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "get_mock_crm_lead") {
        const leadId = request.params.arguments?.leadId;

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        id: leadId,
                        name: "Олександр Коваленко",
                        company: "TechCorp Ukraine",
                        status: "QUALIFIED",
                        estimatedValue: 15000,
                        notes: "Потребує комплексної інтеграції цифрової інфраструктури"
                    }, null, 2),
                },
            ],
        };
    }

    throw new Error(`Інструмент не знайдено або не підтримується: ${request.params.name}`);
});

// 4. Запуск сервера через HTTP/SSE
const app = express();
const port = process.env.PORT || 3001;
let transport: SSEServerTransport;

app.get("/sse", async (req, res) => {
    transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
});

app.post("/messages", async (req, res) => {
    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(500).send("SSE transport not initialized");
    }
});

app.listen(port, () => {
    console.log(`Corporate MCP Server is running on SSE transport at http://localhost:${port}`);
});
