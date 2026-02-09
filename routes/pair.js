const { 
    giftedId,
    removeFile,
    generateRandomCode
} = require('../gift');
const zlib = require('zlib');
const express = require('express');
const fs = require('fs');
const path = require('path');
let router = express.Router();
const pino = require("pino");
const { sendButtons } = require('gifted-btns');
const {
    default: giftedConnect,
    useMultiFileAuthState,
    delay,
    downloadContentFromMessage, 
    generateWAMessageFromContent,
    normalizeMessageContent,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    getContentType
} = require("@whiskeysockets/baileys");

const sessionDir = path.join(__dirname, "session");

function getTextFromMessage(msg) {
    try {
        const m = normalizeMessageContent(msg.message);
        if (!m) return "";
        const type = getContentType(m);
        if (type === 'conversation') return m.conversation || "";
        if (type === 'extendedTextMessage') return m.extendedTextMessage?.text || "";
        if (type === 'imageMessage') return m.imageMessage?.caption || "";
        if (type === 'videoMessage') return m.videoMessage?.caption || "";
        if (type === 'documentMessage') return m.documentMessage?.caption || "";
        if (type === 'buttonsResponseMessage') return m.buttonsResponseMessage?.selectedButtonId || "";
        if (type === 'listResponseMessage') return m.listResponseMessage?.singleSelectReply?.selectedRowId || "";
        if (type === 'templateButtonReplyMessage') return m.templateButtonReplyMessage?.selectedId || "";
        return "";
    } catch (e) {
        return "";
    }
}

async function startBasicBot(Gifted) {
    Gifted.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages?.[0];
        if (!msg || !msg.message) return;
        if (msg.key?.fromMe) return;

        const from = msg.key?.remoteJid;
        if (!from || from.endsWith('@g.us')) return;

        const text = (getTextFromMessage(msg) || "").trim();
        if (!text) return;

        const lower = text.toLowerCase();
        const prefixMatch = /^[!.\/]/.test(text);
        const cmd = prefixMatch ? lower.slice(1).split(/\s+/)[0] : "";

        const reply = (t) => Gifted.sendMessage(from, { text: t }, { quoted: msg });

        // Accept both "ping" and ".ping"
        if (cmd === 'ping' || lower === 'ping') return reply('pong ✅');
        if (cmd === 'alive' || cmd === 'status' || lower === 'alive') return reply('I am online ✅\nBasic bot mode is active.');
        if (cmd === 'help' || cmd === 'menu' || lower === 'help') {
            return reply(
`*Buddy Session Bot (Basic Commands)*

• .ping  – test response
• .alive – bot status
• .id    – show your JID
• .time  – server time
• .help  – this menu

> Powered by XTR Developers`
            );
        }
        if (cmd === 'id') return reply(`Your JID: ${from}`);
        if (cmd === 'time') return reply(`Server time: ${new Date().toISOString()}`);

        // Quick keyword replies (no prefix)
        if (lower === 'hi' || lower === 'hello') return reply('Hey 👋');
    });
}

router.get('/', async (req, res) => {
    const id = giftedId();
    let num = req.query.number;
    let responseSent = false;
    let sessionCleanedUp = false;

    async function cleanUpSession() {
        if (!sessionCleanedUp) {
            try {
                await removeFile(path.join(sessionDir, id));
            } catch (cleanupError) {
                console.error("Cleanup error:", cleanupError);
            }
            sessionCleanedUp = true;
        }
    }

    async function GIFTED_PAIR_CODE() {
    const { version } = await fetchLatestBaileysVersion();
    console.log(version);
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, id));
        try {
            let Gifted = giftedConnect({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.macOS("Safari"),
                syncFullHistory: false,
                generateHighQualityLinkPreview: true,
                shouldIgnoreJid: jid => !!jid?.endsWith('@g.us'),
                getMessage: async () => undefined,
                markOnlineOnConnect: true,
                connectTimeoutMs: 60000, 
                keepAliveIntervalMs: 30000
            });

            if (!Gifted.authState.creds.registered) {
                await delay(1500);
                num = num.replace(/[^0-9]/g, '');
                
                const randomCode = generateRandomCode();
                let code;
                try {
                    // Some Baileys versions accept only (phoneNumber). Keep a safe fallback.
                    code = await Gifted.requestPairingCode(num, randomCode);
                } catch (e) {
                    code = await Gifted.requestPairingCode(num);
                }
                
                if (!responseSent && !res.headersSent) {
                    res.json({ code: code });
                    responseSent = true;
                }
            }

            Gifted.ev.on('creds.update', saveCreds);
            Gifted.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect } = s;

                if (connection === "open") {
                    // Start a minimal bot as soon as we connect
                    try { await startBasicBot(Gifted); } catch (e) {}

                    // Optional: auto-join a group via invite code or full invite link.
// Set GROUP_INVITE in env to either an invite code (e.g. AbCdE...) or a full link.
if (process.env.GROUP_INVITE) {
    try {
        const raw = String(process.env.GROUP_INVITE).trim();
        const codeMatch = raw.match(/chat\.whatsapp\.com\/([0-9A-Za-z]+)/) || raw.match(/^([0-9A-Za-z]+)$/);
        const code = codeMatch ? codeMatch[1] : null;
        if (code) {
            await Gifted.groupAcceptInvite(code);
            console.log('[pair] Joined group via invite.');
        } else {
            console.warn('[pair] GROUP_INVITE is set but could not parse invite code.');
        }
    } catch (e) {
        // WhatsApp may return 400 bad-request for invalid/expired links or if already in group.
        console.warn('[pair] Could not join group via invite (ignored):', e?.message || e);
    }
}
await delay(50000);
                    
                    let sessionData = null;
                    let attempts = 0;
                    const maxAttempts = 15;
                    
                    while (attempts < maxAttempts && !sessionData) {
                        try {
                            const credsPath = path.join(sessionDir, id, "creds.json");
                            if (fs.existsSync(credsPath)) {
                                const data = fs.readFileSync(credsPath);
                                if (data && data.length > 100) {
                                    sessionData = data;
                                    break;
                                }
                            }
                            await delay(8000);
                            attempts++;
                        } catch (readError) {
                            console.error("Read error:", readError);
                            await delay(2000);
                            attempts++;
                        }
                    }

                    if (!sessionData) {
                        await cleanUpSession();
                        return;
                    }
                    
                    try {
                        let compressedData = zlib.gzipSync(sessionData);
                        let b64data = compressedData.toString('base64');
                        await delay(5000); 

                        let sessionSent = false;
                        let sendAttempts = 0;
                        const maxSendAttempts = 5;
                        let Sess = null;

                        while (sendAttempts < maxSendAttempts && !sessionSent) {
                            try {
                                const selfJid = jidNormalizedUser(Gifted.user.id);
                        const targetJid = selfJid; // send to 'message to self' chat
                        Sess = await sendButtons(Gifted, targetJid, {
            title: '',
            text: 'Buddy~' + b64data,
            footer: `> *Created by the XTR Developers*`,
            buttons: [
                { 
                    name: 'cta_copy', 
                    buttonParamsJson: JSON.stringify({ 
                        display_text: 'Copy Session', 
                        copy_code: 'Buddy~' + b64data 
                    }) 
                },
                {
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: 'Visit Bot Repo',
                        url: 'https://github.com/carl24tech/Buddy-XTR'
                    })
                },
                {
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: 'Join WaChannel',
                        url: 'https://whatsapp.com/channel/00293hlgX5kg7G0nFggl0Y'
                    })
                }
            ]
        });
                                sessionSent = true;
                            } catch (sendError) {
                                console.error("Send error:", sendError);
                                sendAttempts++;
                                if (sendAttempts < maxSendAttempts) {
                                    await delay(3000);
                                }
                            }
                        }

                        if (!sessionSent) {
                            await cleanUpSession();
                            return;
                        }

                        await delay(3000);

                        // Keep the connection alive for bot mode (about 10 minutes),
                        // then close and cleanup to avoid resource leaks on the server.
                        setTimeout(async () => {
                            try { await Gifted.ws.close(); } catch (e) {}
                            try { await cleanUpSession(); } catch (e) {}
                        }, 10 * 60 * 1000);
                    } catch (sessionError) {
                        console.error("Session processing error:", sessionError);
                    } finally {
                        // cleanup happens after socket close (see setTimeout above)
                    }
                    
                } else if (connection === "close" && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode != 401) {
                    console.log("Reconnecting...");
                    await delay(5000);
                    GIFTED_PAIR_CODE();
                }
            });

        } catch (err) {
            console.error("Main error:", err);
            if (!responseSent && !res.headersSent) {
                res.status(500).json({ code: "Service is Currently Unavailable" });
                responseSent = true;
            }
            await cleanUpSession();
        }
    }

    try {
        await GIFTED_PAIR_CODE();
    } catch (finalError) {
        console.error("Final error:", finalError);
        await cleanUpSession();
        if (!responseSent && !res.headersSent) {
            res.status(500).json({ code: "Service Error" });
        }
    }
});

module.exports = router;
