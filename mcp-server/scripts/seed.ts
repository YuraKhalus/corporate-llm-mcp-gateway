import axios from 'axios';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TWENTY_API_KEY = process.env.TWENTY_API_KEY;
const TWENTY_API_URL = 'http://localhost:3000/rest';

if (!TWENTY_API_KEY) {
    console.error('Помилка: TWENTY_API_KEY не знайдено у файлі .env');
    process.exit(1);
}

const api = axios.create({
    baseURL: TWENTY_API_URL,
    headers: {
        'Authorization': `Bearer ${TWENTY_API_KEY}`,
        'Content-Type': 'application/json'
    }
});

import { execSync } from 'child_process';

async function clearData() {
    console.log('🧹 Очищення старих даних (TRUNCATE)...');
    try {
        const dbUser = process.env.DB_USER || 'default';
        const dbName = process.env.DB_NAME || 'default';

        // Видаляємо всі записи з кастомної таблиці співробітників, клієнтів та нотаток 
        // через SQL-запит до контейнера crm-postgres, щоб уникнути конфліктів із soft-delete (deletedAt)
        const sql = `
            TRUNCATE workspace_9mnkufp3o5b6kdhs42fb17yst."_employee" CASCADE;
            TRUNCATE workspace_9mnkufp3o5b6kdhs42fb17yst.person CASCADE;
            TRUNCATE workspace_9mnkufp3o5b6kdhs42fb17yst.note CASCADE;
        `;

        execSync(`docker exec crm-postgres psql -U ${dbUser} -d ${dbName} -c '${sql}'`, { stdio: 'ignore' });
        console.log('Базу успішно очищено.');
    } catch (e: any) {
        console.error('Помилка очищення:', e.message);
    }
}

async function createEmployee(email: string, jobTitle: string, nameStr: string, managerId: string | null = null) {
    try {
        const payload: any = {
            name: nameStr,
            email: { primaryEmail: email },
            jobTitle: jobTitle
        };
        if (managerId) {
            payload.managerId = managerId;
        }
        const res = await api.post('/employees', payload);
        console.log(`Створено співробітника: ${nameStr} (${jobTitle})`);
        return res.data.data.createEmployee.id;
    } catch (e: any) {
        console.error(`Помилка створення ${email}:`, e.response?.data?.messages || e.message);
        throw e;
    }
}

async function createClient(firstName: string, lastName: string, city: string, consultantId: string, notes?: Array<{ date: string, purpose: string, product: string, text: string }>) {
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${Math.floor(Math.random() * 1000)}@gmail.com`;
    try {
        const res = await api.post('/people', {
            name: { firstName, lastName },
            emails: { primaryEmail: email },
            jobTitle: 'Приватний інвестор',
            city: city,
            consultantId: consultantId
        });
        const personId = res.data.data.createPerson.id;
        console.log(`Створено клієнта: ${firstName} ${lastName}`);

        if (notes && notes.length > 0) {
            for (const note of notes) {
                const noteBody = `Дата: ${note.date}\nПродукт: ${note.product}\n\n${note.text}`;
                try {
                    const noteRes = await api.post('/notes', {
                        title: note.purpose,
                        bodyV2: {
                            markdown: noteBody
                        }
                    });
                    const noteId = noteRes.data.data.createNote.id;

                    await api.post('/noteTargets', {
                        noteId: noteId,
                        targetPersonId: personId
                    });
                    console.log(`Додано нотатку: ${note.purpose}`);
                } catch (e: any) {
                    console.error(`Не вдалося додати нотатку:`, e.response?.data?.messages || e.message);
                }
            }
        }

        return personId;
    } catch (e: any) {
        console.error(`Помилка створення клієнта:`, e.response?.data?.messages || e.message);
    }
}

async function runSeed() {
    console.log('Починаємо генерацію даних для Fin Company...');
    try {
        // Очищаємо стару базу (у тому числі шаблонні дані)
        await clearData();

        const dataPath = path.join(__dirname, 'data.json');
        const fileContent = fs.readFileSync(dataPath, 'utf-8');
        const data = JSON.parse(fileContent);

        // 1. Створення Директора
        const directorId = await createEmployee(
            data.director.email,
            data.director.jobTitle,
            data.director.name
        );

        // 2. Створення Менеджерів та Консультантів
        for (const manager of data.managers) {
            const managerId = await createEmployee(
                manager.email,
                manager.jobTitle,
                manager.name,
                directorId
            );

            // 3. Консультанти цього менеджера
            for (const consultant of manager.consultants) {
                const consultantId = await createEmployee(
                    consultant.email,
                    consultant.jobTitle,
                    consultant.name,
                    managerId
                );

                // 4. Клієнти цього консультанта
                for (const client of consultant.clients) {
                    await createClient(
                        client.firstName,
                        client.lastName,
                        client.city,
                        consultantId,
                        client.notes
                    );
                }
            }
        }

        console.log(' Дані успішно завантажено з JSON!');
    } catch (error: any) {
        console.error('Критична помилка генерації:', error.message);
    }
}

runSeed();
