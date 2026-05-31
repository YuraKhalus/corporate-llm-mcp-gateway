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
import axios from "axios";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TWENTY_API_KEY = process.env.TWENTY_API_KEY;
if (!TWENTY_API_KEY) {
    console.error("Помилка: TWENTY_API_KEY не знайдено");
    process.exit(1);
}

const api = axios.create({
    baseURL: process.env.TWENTY_API_URL || 'http://twenty:3000/rest',
    headers: {
        'Authorization': `Bearer ${TWENTY_API_KEY}`,
        'Content-Type': 'application/json'
    }
});

// -----------------------------------------------------------------------------
// Допоміжні функції для RLS (Row-Level Security)
// -----------------------------------------------------------------------------

/**
 * Отримує всі ID співробітників, які є підлеглими для заданого email.
 * Якщо співробітник - це директор, він побачить ID всіх підлеглих.
 * Якщо це консультант, він побачить лише свій ID.
 */
async function getUserContext(userEmail: string): Promise<{ allowedIds: string[], currentUser: any, allEmployees: any[] }> {
    const res = await api.get('/employees?limit=1000');
    const employees = res.data?.data?.employees || [];

    // Шукаємо поточного користувача
    const currentUser = employees.find((e: any) => e.email?.primaryEmail === userEmail);
    if (!currentUser) {
        throw new Error(`Користувача з email ${userEmail} не знайдено в CRM.`);
    }

    const allowedIds = new Set<string>();

    // Рекурсивна функція для обходу дерева
    function addSubordinates(managerId: string) {
        allowedIds.add(managerId);
        const subordinates = employees.filter((e: any) => e.managerId === managerId);
        for (const sub of subordinates) {
            addSubordinates(sub.id);
        }
    }

    addSubordinates(currentUser.id);
    return { allowedIds: Array.from(allowedIds), currentUser, allEmployees: employees };
}

// -----------------------------------------------------------------------------
// Ініціалізація MCP Сервера
// -----------------------------------------------------------------------------
const server = new Server(
    { name: "corporate-crm-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.log("[MCP] Запит на отримання списку інструментів (ListToolsRequestSchema)");
    return {
        tools: [
            {
                name: "get_my_clients",
                description: "Отримати список всіх клієнтів, до яких у поточного користувача є доступ (власні клієнти + клієнти підлеглих).",
                inputSchema: {
                    type: "object",
                    properties: {
                        user_email: { type: "string", description: "Email поточного користувача (обов'язково)" }
                    },
                    required: ["user_email"],
                },
            },
            {
                name: "get_client_details",
                description: "Отримати деталі клієнта та історію зустрічей (нотатки) за його ім'ям.",
                inputSchema: {
                    type: "object",
                    properties: {
                        user_email: { type: "string", description: "Email поточного користувача" },
                        client_name: { type: "string", description: "Ім'я та прізвище клієнта (напр. 'Олена Шевченко')" }
                    },
                    required: ["user_email", "client_name"],
                },
            },
            {
                name: "add_client_note",
                description: "Додати нову нотатку або запис про зустріч до клієнта.",
                inputSchema: {
                    type: "object",
                    properties: {
                        user_email: { type: "string" },
                        client_name: { type: "string" },
                        title: { type: "string", description: "Заголовок або мета зустрічі" },
                        content: { type: "string", description: "Текст нотатки (можна Markdown)" }
                    },
                    required: ["user_email", "client_name", "title", "content"],
                },
            },
            {
                name: "get_team_structure",
                description: "Показати ієрархію підлеглих для заданого менеджера.",
                inputSchema: {
                    type: "object",
                    properties: {
                        user_email: { type: "string" }
                    },
                    required: ["user_email"],
                },
            },
            {
                name: "get_team_analytics",
                description: "Зібрати статистику кількості клієнтів по відділу (включаючи міста).",
                inputSchema: {
                    type: "object",
                    properties: {
                        user_email: { type: "string" }
                    },
                    required: ["user_email"],
                },
            },
            {
                name: "create_client",
                description: "Створити нову картку клієнта та закріпити її за поточним користувачем.",
                inputSchema: {
                    type: "object",
                    properties: {
                        user_email: { type: "string" },
                        firstName: { type: "string" },
                        lastName: { type: "string" },
                        city: { type: "string" },
                        email: { type: "string", description: "Опціонально" }
                    },
                    required: ["user_email", "firstName", "lastName", "city"],
                },
            },
            {
                name: "onboard_new_client",
                description: "Створити клієнта і одразу додати стартову нотатку.",
                inputSchema: {
                    type: "object",
                    properties: {
                        user_email: { type: "string" },
                        firstName: { type: "string" },
                        lastName: { type: "string" },
                        city: { type: "string" },
                        email: { type: "string" },
                        noteTitle: { type: "string" },
                        noteContent: { type: "string" }
                    },
                    required: ["user_email", "firstName", "lastName", "city", "noteTitle", "noteContent"],
                },
            }
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.log(`\n[MCP] ВИКЛИКАНО ІНСТРУМЕНТ: ${name}`);
    console.log(`[MCP] Аргументи:`, args);

    if (!args || typeof args.user_email !== "string") {
        throw new Error("user_email обов'язковий аргумент для перевірки доступу");
    }

    const userEmail = args.user_email;

    try {
        // Отримуємо дозволені ID для поточного юзера та сам об'єкт користувача
        const { allowedIds, currentUser, allEmployees } = await getUserContext(userEmail);

        if (name === "get_team_structure") {
            const team = allEmployees
                .filter((e: any) => allowedIds.includes(e.id))
                .map((e: any) => ({
                    id: e.id,
                    name: e.name,
                    jobTitle: e.jobTitle,
                    email: e.email?.primaryEmail,
                    isMe: e.id === currentUser.id
                }));
            return { content: [{ type: "text", text: JSON.stringify(team, null, 2) }] };
        }

        if (name === "get_team_analytics") {
            const peopleRes = await api.get('/people?limit=1000');
            const allPeople = peopleRes.data?.data?.people || [];

            const analytics = allowedIds.map(consultantId => {
                const consultant = allEmployees.find((e: any) => e.id === consultantId);
                const clients = allPeople.filter((p: any) => p.consultantId === consultantId);
                
                const byCity: Record<string, number> = {};
                clients.forEach((c: any) => {
                    const city = c.city || 'Невідомо';
                    byCity[city] = (byCity[city] || 0) + 1;
                });

                return {
                    consultant: consultant?.name,
                    totalClients: clients.length,
                    clientsByCity: byCity
                };
            });

            return { content: [{ type: "text", text: JSON.stringify(analytics, null, 2) }] };
        }

        if (name === "create_client" || name === "onboard_new_client") {
            const { firstName, lastName, city, email, noteTitle, noteContent } = args as any;

            const newPersonRes = await api.post('/people', {
                name: { firstName, lastName },
                city: city,
                emails: email ? { primaryEmail: email, additionalEmails: [] } : undefined,
                consultantId: currentUser.id
            });
            const personId = newPersonRes.data.data.createPerson.id;

            let responseText = `Клієнта ${firstName} ${lastName} успішно створено. ID: ${personId}`;

            if (name === "onboard_new_client" && noteTitle && noteContent) {
                const noteRes = await api.post('/notes', {
                    title: noteTitle,
                    bodyV2: { markdown: noteContent }
                });
                const noteId = noteRes.data.data.createNote.id;

                await api.post('/noteTargets', {
                    noteId: noteId,
                    targetPersonId: personId
                });
                responseText += `\nСтартову нотатку "${noteTitle}" успішно додано.`;
            }

            return { content: [{ type: "text", text: responseText }] };
        }

        if (name === "get_my_clients") {
            const peopleRes = await api.get('/people?limit=1000');
            const allPeople = peopleRes.data?.data?.people || [];

            // RLS: Фільтруємо лише тих клієнтів, чий консультант є в списку allowedIds
            const myClients = allPeople.filter((p: any) => allowedIds.includes(p.consultantId));

            const result = myClients.map((p: any) => ({
                id: p.id,
                name: `${p.name?.firstName} ${p.name?.lastName}`,
                city: p.city,
                email: p.emails?.primaryEmail
            }));

            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
        }

        if (name === "get_client_details" || name === "add_client_note") {
            const clientName = args.client_name as string;

            // Шукаємо клієнта
            const peopleRes = await api.get('/people?limit=1000');
            const allPeople = peopleRes.data?.data?.people || [];

            const client = allPeople.find((p: any) =>
                `${p.name?.firstName} ${p.name?.lastName}`.toLowerCase() === clientName.toLowerCase()
            );

            if (!client) {
                return { content: [{ type: "text", text: `Клієнта з іменем "${clientName}" не знайдено.` }] };
            }

            // RLS ПЕРЕВІРКА ДОСТУПУ ДО КОНКРЕТНОГО КЛІЄНТА
            if (!allowedIds.includes(client.consultantId)) {
                return { content: [{ type: "text", text: `[ACCESS DENIED] У вас немає доступу до клієнта "${clientName}". Він належить іншій гілці.` }] };
            }

            if (name === "get_client_details") {
                // Витягуємо зв'язки нотаток
                const targetsRes = await api.get(`/noteTargets?limit=100`);
                const targets = targetsRes.data?.data?.noteTargets || [];
                const clientTargetNotes = targets.filter((t: any) => t.targetPersonId === client.id);

                let notesData = [];
                if (clientTargetNotes.length > 0) {
                    const noteIds = clientTargetNotes.map((t: any) => t.noteId).join(',');
                    // Витягуємо самі нотатки
                    const notesRes = await api.get(`/notes`);
                    const allNotes = notesRes.data?.data?.notes || [];

                    const clientNotes = allNotes.filter((n: any) => clientTargetNotes.some((t: any) => t.noteId === n.id));

                    notesData = clientNotes.map((n: any) => ({
                        date: n.createdAt,
                        title: n.title,
                        content: n.bodyV2?.markdown || "Блок тексту (Rich Text)"
                    }));
                }

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            client: {
                                id: client.id,
                                name: `${client.name?.firstName} ${client.name?.lastName}`,
                                city: client.city
                            },
                            notes: notesData
                        }, null, 2)
                    }]
                };
            }

            if (name === "add_client_note") {
                const title = args.title as string;
                const content = args.content as string;

                const noteRes = await api.post('/notes', {
                    title: title,
                    bodyV2: { markdown: content }
                });
                const noteId = noteRes.data.data.createNote.id;

                await api.post('/noteTargets', {
                    noteId: noteId,
                    targetPersonId: client.id
                });

                return {
                    content: [{ type: "text", text: `Нотатку "${title}" успішно додано до клієнта ${clientName}.` }]
                };
            }
        }

        throw new Error(`Невідомий інструмент: ${name}`);
    } catch (e: any) {
        throw new Error(`Помилка CRM API: ${e.response?.data?.messages || e.message}`);
    }
});

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
