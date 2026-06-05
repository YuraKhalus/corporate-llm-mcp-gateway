import express from 'express';
import cors from 'cors';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    next();
});

const PORT = process.env.OIDC_PORT || 3006;
const TWENTY_BASE_URL = process.env.TWENTY_BASE_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-key';
const BROKER_URL = process.env.OPENID_PROVIDER_URL || `http://localhost:${PORT}`;

// Тимчасове сховище для кодів авторизації (в пам'яті)
const authCodes = new Map<string, { email: string, redirect_uri: string, nonce: string, expiresAt: number }>();

// Генеруємо RSA ключі для OIDC (RS256), оскільки Open WebUI/Authlib вимагає jwks_uri
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// Функція для конвертації PEM в JWK 
function pemToJwk(pem: string) {
    const pubKeyObj = crypto.createPublicKey(pem);
    const jwk = pubKeyObj.export({ format: 'jwk' }) as any;
    return {
        kty: 'RSA',
        kid: 'broker-key-1',
        use: 'sig',
        alg: 'RS256',
        n: jwk.n,
        e: jwk.e
    };
}

// 1. OIDC Configuration
app.get('/.well-known/openid-configuration', (req, res) => {
    res.json({
        issuer: BROKER_URL,
        // The authorization endpoint must be reachable from the user's browser
        authorization_endpoint: `http://localhost:${PORT}/oidc/authorize`,
        token_endpoint: `${BROKER_URL}/oidc/token`,
        userinfo_endpoint: `${BROKER_URL}/oidc/userinfo`,
        jwks_uri: `${BROKER_URL}/oidc/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email'],
        claims_supported: ['sub', 'name', 'email']
    });
});

app.get('/', (req, res) => {
    res.json({
        issuer: BROKER_URL,
        authorization_endpoint: `http://localhost:${PORT}/oidc/authorize`,
        token_endpoint: `${BROKER_URL}/oidc/token`,
        userinfo_endpoint: `${BROKER_URL}/oidc/userinfo`,
        jwks_uri: `${BROKER_URL}/oidc/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email'],
        claims_supported: ['sub', 'name', 'email']
    });
});

app.get('/oidc/jwks', (req, res) => {
    res.json({ keys: [pemToJwk(publicKey)] });
});

// 2. Authorize Endpoint 
app.get('/oidc/authorize', (req, res) => {
    const { redirect_uri, state, client_id, nonce } = req.query;

    if (!redirect_uri) {
        return res.status(400).send('Missing redirect_uri');
    }

    const html = `
    <!DOCTYPE html>
    <html lang="uk">
    <head>
        <meta charset="UTF-8">
        <title>Корпоративний Вхід - AI Gateway</title>
        <style>
            :root {
                --bg-color: #f4f5f7;
                --container-bg: white;
                --text-main: #172b4d;
                --text-muted: #5e6c84;
                --input-border: #dfe1e6;
                --input-bg: white;
                --input-text: #172b4d;
                --btn-bg: #0052cc;
                --btn-hover: #0047b3;
            }
            @media (prefers-color-scheme: dark) {
                :root {
                    --bg-color: #1a1a1a;
                    --container-bg: #2d2d2d;
                    --text-main: #e0e0e0;
                    --text-muted: #a0a0a0;
                    --input-border: #404040;
                    --input-bg: #1f1f1f;
                    --input-text: #e0e0e0;
                    --btn-bg: #4c9aff;
                    --btn-hover: #2684ff;
                }
            }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: var(--bg-color); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; transition: background-color 0.3s; }
            .login-container { background: var(--container-bg); padding: 40px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.15); width: 100%; max-width: 400px; transition: background-color 0.3s; }
            h2 { margin-top: 0; color: var(--text-main); text-align: center; }
            p.subtitle { color: var(--text-muted); text-align: center; margin-bottom: 24px; font-size: 14px; }
            .form-group { margin-bottom: 16px; }
            label { display: block; margin-bottom: 6px; color: var(--text-main); font-weight: 500; font-size: 14px; }
            input[type="email"], input[type="password"] { width: 100%; padding: 10px 12px; border: 2px solid var(--input-border); background-color: var(--input-bg); color: var(--input-text); border-radius: 6px; box-sizing: border-box; font-size: 14px; transition: border-color 0.2s, background-color 0.3s; }
            input:focus { border-color: var(--btn-bg); outline: none; }
            button { width: 100%; padding: 12px; background-color: var(--btn-bg); color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: bold; cursor: pointer; transition: background-color 0.2s; }
            button:hover { background-color: var(--btn-hover); }
            .error { color: #ff5630; font-size: 14px; text-align: center; margin-bottom: 16px; display: none; background: rgba(255,86,48,0.1); padding: 8px; border-radius: 4px; }
        </style>
    </head>
    <body>
        <div class="login-container">
            <h2>Корпоративний AI Gateway</h2>
            <p class="subtitle">Увійдіть, використовуючи обліковий запис Twenty CRM</p>
            <div class="error" id="errorMsg">Невірний логін або пароль</div>
            <form action="/oidc/login" method="POST">
                <input type="hidden" name="redirect_uri" value="${redirect_uri}">
                <input type="hidden" name="state" value="${state || ''}">
                <input type="hidden" name="nonce" value="${nonce || ''}">
                <div class="form-group">
                    <label>Електронна пошта</label>
                    <input type="email" name="email" required placeholder="name@corporate.com">
                </div>
                <div class="form-group">
                    <label>Пароль CRM</label>
                    <input type="password" name="password" required placeholder="••••••••">
                </div>
                <button type="submit">Увійти</button>
            </form>
        </div>
        <script>
            if (window.location.search.includes('error=1')) {
                document.getElementById('errorMsg').style.display = 'block';
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

// 3. Обробка форми логіну та перевірка в Twenty CRM
app.post('/oidc/login', async (req, res) => {
    const { email, password, redirect_uri, state, nonce } = req.body;

    try {
        // Відправляємо запит на перевірку пароля до Twenty CRM
        const query = `mutation GetLoginTokenFromCredentials($email: String!, $password: String!, $origin: String!) {
            getLoginTokenFromCredentials(email: $email, password: $password, origin: $origin) {
                loginToken { token }
            }
        }`;

        const crmResponse = await axios.post(`${TWENTY_BASE_URL}/metadata`, {
            operationName: "GetLoginTokenFromCredentials",
            variables: { email, password, origin: "http://localhost:3000" },
            query: query
        }, {
            headers: { 'Content-Type': 'application/json' }
        });

        // Якщо в CRM відповіли помилкою або не повернули токен
        if (crmResponse.data.errors || !crmResponse.data.data?.getLoginTokenFromCredentials?.loginToken) {
            console.warn(`[OIDC] Failed login attempt for ${email}`);
            return res.redirect(`/oidc/authorize?redirect_uri=${encodeURIComponent(redirect_uri)}&state=${encodeURIComponent(state)}&error=1`);
        }

        console.log(`[OIDC] Successful CRM authentication for ${email}`);

        // Генеруємо одноразовий Authorization Code
        const code = crypto.randomBytes(16).toString('hex');
        authCodes.set(code, {
            email,
            redirect_uri,
            nonce: nonce || '',
            expiresAt: Date.now() + 5 * 60 * 1000 // 5 хвилин
        });

        // Повертаємо користувача до Open WebUI з кодом
        res.redirect(`${redirect_uri}?code=${code}&state=${state}`);

    } catch (error: any) {
        console.error("[OIDC] CRM connection error:", error.message);
        res.redirect(`/oidc/authorize?redirect_uri=${encodeURIComponent(redirect_uri)}&state=${encodeURIComponent(state)}&error=1`);
    }
});

// 4. Token Endpoint (Open WebUI обмінює code на ID Token)
app.post('/oidc/token', async (req, res) => {
    const { code, redirect_uri } = req.body;

    const session = authCodes.get(code);
    if (!session || session.expiresAt < Date.now() || session.redirect_uri !== redirect_uri) {
        return res.status(400).json({ error: 'invalid_grant' });
    }

    // Видаляємо код після використання
    authCodes.delete(code);

    const email = session.email;

    // Генеруємо ID Token (JWT) для Open WebUI (за допомогою RSA)
    const payload: any = {
        iss: BROKER_URL,
        sub: email, // Використовуємо email як унікальний ідентифікатор
        aud: "open-webui-client",
        exp: Math.floor(Date.now() / 1000) + (60 * 60),
        iat: Math.floor(Date.now() / 1000),
        email: email,
        name: email.split('@')[0] // Формуємо просте ім'я з пошти
    };

    if (session.nonce) {
        payload.nonce = session.nonce;
    }

    const idToken = jwt.sign(payload, privateKey, { algorithm: 'RS256', keyid: 'broker-key-1' });

    res.json({
        access_token: "dummy-access-token-not-needed",
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: idToken
    });
});

// 5. UserInfo Endpoint (Запасний, якщо Open WebUI його викличе)
app.get('/oidc/userinfo', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, publicKey) as any;
        res.json({
            sub: decoded.sub,
            name: decoded.name,
            email: decoded.email
        });
    } catch (e) {
        // Якщо токен не наш, просто повернемо заглушку
        res.json({ sub: "unknown", name: "User", email: "user@corporate.com" });
    }
});

app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🚀 OIDC Identity Broker listening on port ${PORT}`);
});
