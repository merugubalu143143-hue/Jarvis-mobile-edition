window.kalkiAssistantState = window.kalkiAssistantState || "idle";
window.kalkiVoiceState = window.kalkiVoiceState || { active: false, listening: false, processing: false, status: "" };
function publishKalkiAssistantState(state) {
    window.kalkiAssistantState = state;
    window.dispatchEvent(new CustomEvent("kalki:assistant-state", { detail: { state } }));
    if (state === "solving") window.ensureKalkiEffects?.();
}

document.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);
    const chatBox = $("chat");
    const messageInput = $("msg");
    const sendButton = $("send");
    const clearButton = $("clear-btn");
    const micButton = $("mic-btn");
    const settingsToggle = $("settings-toggle");
    const voiceSettings = $("voice-settings");
    const apiKeyInput = $("gemini-api-key");
    const apiKeyStatus = $("gemini-key-status");
    const saveApiKeyButton = $("save-api-key");
    const clearApiKeyButton = $("clear-api-key");
    const ttsAutoRead = $("tts-auto-read");
    const ttsStopButton = $("tts-stop-button");
    const ttsStatus = $("tts-status");
    const ttsVoiceSelect = $("tts-voice-select");
    const voiceInputLanguage = $("voice-input-language");
    const voiceModeStatus = $("voice-mode-status");
    const attachBtn = $("attach-btn");
    const attachMenu = $("attachment-menu");
    const camBtn = $("cam-btn");
    const fileBtn = $("file-btn");
    const fileInput = $("img-input");

    const MEMORY_KEY = "jarvis_chat_memory";
    const API_KEY_STORAGE = "jarvis_api_key";
    const TTS_AUTO_READ_KEY = "kalki.tts.autoRead";
    const TTS_VOICE_KEY = "kalki.tts.voiceURI";
    const VOICE_INPUT_LANGUAGE_KEY = "kalki.voice.inputLanguage";

    const MODEL_NAMES = [
        "gemini-3.7-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite"
    ];

    const VOICE_STOP_PHRASES = new Set([
        "stop", "stop voice", "stop voice chat", "stop voice mode", "stop listening", "stop talking",
        "end voice chat", "end conversation", "voice off", "turn off voice", "turn off voice chat",
        "pause voice", "pause voice chat", "cancel voice", "cancel voice chat", "quit voice", "quit voice chat",
        "goodbye", "that's all", "that's enough",
        "aapu", "aapeyi", "aapey", "aapandi", "voice aapu", "voice aapeyi", "voice aapey", "voice aapandi",
        "chaalu", "chalu",
        "ఆపు", "ఆపేయి", "ఆపండి", "చాలు", "వాయిస్ ఆపు", "వాయిస్ ఆపేయి", "వాయిస్ ఆపండి",
        "మాట్లాడటం ఆపు", "మాట్లాడడం ఆపండి", "వినడం ఆపు", "వినడం ఆపండి"
    ]);

    let activeUtterance = null;
    let activeSpeakButton = null;
    let voiceConversationActive = false;
    let voiceTurnPending = false;
    let recognition = null;
    let isListening = false;
    let recognitionStarting = false;
    let voiceRestartTimer = null;
    let busy = false;
    let pendingAttachment = null; // { name, mimeType, data (base64) | text }

    /* ---------- Memory ---------- */
    function readMemory() {
        try { return JSON.parse(localStorage.getItem(MEMORY_KEY) || "[]"); }
        catch (_) { return []; }
    }
    function saveMemory(memory) {
        try { localStorage.setItem(MEMORY_KEY, JSON.stringify(memory.slice(-30))); } catch (_) {}
    }
    function addToMemory(sender, text, type) {
        const memory = readMemory();
        memory.push({ sender, text, type });
        saveMemory(memory);
    }

    /* ---------- Messages ---------- */
    function showMessage(sender, text, type, save = true) {
        if (!chatBox) return null;
        const message = document.createElement("div");
        message.className = type === "user" ? "msg user" : "msg";

        const senderElement = document.createElement("strong");
        const displaySender = sender === "J.A.R.V.I.S" ? "KALKI" : sender;
        senderElement.textContent = displaySender + ": ";
        message.appendChild(senderElement);
        message.appendChild(document.createTextNode(text));

        const canSpeak = type === "ai" && sender !== "SYSTEM" && sender !== "YOU";
        let speakButton = null;
        if (canSpeak) {
            speakButton = document.createElement("button");
            speakButton.type = "button";
            speakButton.className = "speak-button";
            speakButton.textContent = "🔊 Read aloud";
            speakButton.setAttribute("aria-pressed", "false");
            speakButton.addEventListener("click", () => {
                if (activeSpeakButton === speakButton && window.speechSynthesis?.speaking) stopSpeaking();
                else speak(text, speakButton);
            });
            message.appendChild(speakButton);
        }

        chatBox.appendChild(message);
        document.body.classList.toggle("has-conversation", chatBox.children.length > 0);
        chatBox.scrollTop = chatBox.scrollHeight;
        window.scrollTo({ top: document.body.scrollHeight });

        if (save) addToMemory(sender, text, type);
        if (save && canSpeak && (ttsAutoRead?.checked || voiceConversationActive)) speak(text, speakButton);
        return message;
    }

    function loadSavedChat() {
        readMemory().forEach((item) => {
            const sender = item.sender === "J.A.R.V.I.S" ? "KALKI" : item.sender;
            showMessage(sender || "KALKI", item.text || "", item.type || "ai", false);
        });
    }

    function clearConversation() {
        stopSpeaking(false);
        try { localStorage.removeItem(MEMORY_KEY); } catch (_) {}
        if (chatBox) chatBox.innerHTML = "";
        document.body.classList.remove("has-conversation");
        pendingAttachment = null;
    }

    /* ---------- API key ---------- */
    function getApiKey() {
        try { return (localStorage.getItem(API_KEY_STORAGE) || "").trim(); }
        catch (_) { return ""; }
    }
    function setApiKeyStatus(message, state = "") {
        if (!apiKeyStatus) return;
        apiKeyStatus.textContent = message;
        apiKeyStatus.classList.toggle("is-saved", state === "saved");
        apiKeyStatus.classList.toggle("is-error", state === "error");
    }
    function refreshApiKeyStatus() {
        if (apiKeyInput) apiKeyInput.value = "";
        setApiKeyStatus(getApiKey() ? "Key saved locally · not verified with Google." : "No key saved on this device.",
            getApiKey() ? "saved" : "");
    }
    function saveApiKey() {
        const value = apiKeyInput?.value.trim() || "";
        if (!value) { setApiKeyStatus("Enter your Gemini API key first. Nothing was saved.", "error"); apiKeyInput?.focus(); return; }
        if (!/^(?:AIza[A-Za-z0-9_-]{20,96}|AQ\.[A-Za-z0-9_-]{20,96})$/.test(value)) {
            setApiKeyStatus("Use a standard AIza… key or an AI Studio key starting AQ. Nothing was saved.", "error");
            apiKeyInput?.focus();
            return;
        }
        try {
            localStorage.setItem(API_KEY_STORAGE, value);
            if (apiKeyInput) apiKeyInput.value = "";
            setApiKeyStatus("Key saved locally · format looks plausible only; Google has not verified it.", "saved");
        } catch (_) {
            setApiKeyStatus("Could not save in this browser. Check storage settings.", "error");
        }
    }
    function clearApiKey() {
        try { localStorage.removeItem(API_KEY_STORAGE); } catch (_) {}
        if (apiKeyInput) apiKeyInput.value = "";
        setApiKeyStatus("Saved key cleared from this browser/device.");
    }
    function openApiKeySettings() {
        if (voiceSettings) voiceSettings.hidden = false;
        settingsToggle?.setAttribute("aria-expanded", "true");
        document.body.classList.add("menu-open");
        setApiKeyStatus("A Gemini API key is required for AI replies. Add it here to continue.", "error");
        setTimeout(() => {
            $("gemini-api-settings")?.scrollIntoView({ behavior: "smooth", block: "center" });
            apiKeyInput?.focus({ preventScroll: true });
        }, 180);
    }

    /* ---------- Gemini ---------- */
    async function askGemini(attachment = null) {
        const apiKey = getApiKey();
        if (!apiKey) throw new Error("NO_API_KEY");

        const contents = readMemory()
            .filter((item) => (item.type === "user" || item.type === "ai") && item.sender !== "SYSTEM" && item.text)
            .slice(-20)
            .map((item) => ({
                role: item.type === "user" ? "user" : "model",
                parts: [{ text: String(item.text) }]
            }));
        while (contents.length && contents[0].role !== "user") contents.shift();
        if (!contents.length) throw new Error("Pampadaniki message ledu.");

        if (attachment) {
            const last = contents[contents.length - 1];
            if (attachment.data) last.parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } });
            else if (attachment.text) last.parts.push({ text: "\n\n[Attached file: " + attachment.name + "]\n" + attachment.text });
        }

        const systemText = "You are KALKI, a warm personal assistant who speaks naturally like a helpful friend, not a robotic list generator. " +
            "Acknowledge statements, show empathy for emotions, ask at most one relevant follow-up when useful, and offer one sensible next step. " +
            "Use Telugu/Teluglish naturally when the user does. Prefer concise, human replies. " +
            "Never invent calendar, task, weather, connector or memory facts. External actions remain explicit and confirmation-gated; never act in the background.";

        const apiBase = "https://generativelanguage.googleapis.com/v1beta/models/";
        const errors = [];

        for (const modelName of MODEL_NAMES) {
            try {
                const response = await fetch(apiBase + modelName + ":generateContent", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
                    body: JSON.stringify({ systemInstruction: { parts: [{ text: systemText }] }, contents })
                });
                const data = await response.json().catch(() => ({}));

                if (response.ok) {
                    const reply = data?.candidates?.[0]?.content?.parts
                        ?.map((p) => p.text || "").join("").trim();
                    if (reply) return reply;
                    errors.push(modelName + ": " + (data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || "empty reply"));
                    continue;
                }

                const message = data?.error?.message || ("HTTP " + response.status);
                errors.push(modelName + ": " + message);
                if (response.status === 401 || response.status === 403) break;
                if (response.status === 400 && /api key/i.test(message)) break;
            } catch (error) {
                errors.push(modelName + ": " + error.message);
            }
        }
        throw new Error(errors.join("\n") || "AI connection failed.");
    }

    /* ---------- Text to speech ---------- */
    function getSelectedTtsVoice(voices) {
        let uri = "";
        try { uri = localStorage.getItem(TTS_VOICE_KEY) || ""; } catch (_) {}
        return uri ? (voices.find((v) => v.voiceURI === uri) || null) : null;
    }
    function populateVoices() {
        if (!ttsVoiceSelect || !("speechSynthesis" in window)) return;
        const voices = window.speechSynthesis.getVoices();
        const saved = (() => { try { return localStorage.getItem(TTS_VOICE_KEY) || ""; } catch (_) { return ""; } })();
        ttsVoiceSelect.innerHTML = "";
        const auto = document.createElement("option");
        auto.value = "";
        auto.textContent = "Automatic (Telugu / English)";
        ttsVoiceSelect.appendChild(auto);
        voices.forEach((v) => {
            const o = document.createElement("option");
            o.value = v.voiceURI;
            o.textContent = v.name + " (" + v.lang + ")";
            ttsVoiceSelect.appendChild(o);
        });
        ttsVoiceSelect.value = saved;
    }
    function resetSpeakButton() {
        if (activeSpeakButton?.isConnected) {
            activeSpeakButton.textContent = "🔊 Read aloud";
            activeSpeakButton.setAttribute("aria-pressed", "false");
        }
        activeSpeakButton = null;
        activeUtterance = null;
    }
    function stopSpeaking(resumeVoice = true) {
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
        resetSpeakButton();
        if (resumeVoice && voiceConversationActive) scheduleVoiceListening(350);
    }
    function speak(text, button = null) {
        if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
            if (ttsStatus) ttsStatus.textContent = "Text-to-speech is not supported by this browser.";
            if (voiceConversationActive) scheduleVoiceListening(500);
            return;
        }
        stopSpeaking(false);
        if (voiceConversationActive && isListening && recognition) {
            try { recognition.stop(); } catch (_) {}
        }
        const clean = String(text).replace(/[*#`_]/g, "");
        const utterance = new SpeechSynthesisUtterance(clean);
        const voice = getSelectedTtsVoice(window.speechSynthesis.getVoices());
        if (voice) {
            utterance.voice = voice;
            utterance.lang = voice.lang || "en-IN";
        } else {
            const hasTelugu = Array.from(clean).some((c) => { const p = c.codePointAt(0) || 0; return p >= 0x0C00 && p <= 0x0C7F; });
            utterance.lang = hasTelugu ? "te-IN" : "en-IN";
        }
        utterance.rate = 0.96;
        activeUtterance = utterance;
        activeSpeakButton = button;
        if (button) { button.textContent = "⏹ Stop"; button.setAttribute("aria-pressed", "true"); }
        utterance.onend = () => {
            if (activeUtterance !== utterance) return;
            resetSpeakButton();
            if (voiceConversationActive) scheduleVoiceListening(550);
        };
        utterance.onerror = () => {
            if (activeUtterance !== utterance) return;
            resetSpeakButton();
            if (voiceConversationActive) scheduleVoiceListening(700);
        };
        window.speechSynthesis.speak(utterance);
    }

    /* ---------- Voice input / conversation ---------- */
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

    function setVoiceStatus(text, active = voiceConversationActive) {
        if (voiceModeStatus) voiceModeStatus.textContent = text;
        window.kalkiVoiceState = { active, listening: isListening, processing: voiceTurnPending, status: text };
        window.dispatchEvent(new CustomEvent("kalki:voice-state", { detail: window.kalkiVoiceState }));
    }
    function updateMicButton() {
        if (!micButton) return;
        micButton.classList.toggle("is-listening", voiceConversationActive);
        micButton.setAttribute("aria-pressed", String(voiceConversationActive));
        micButton.setAttribute("aria-label", voiceConversationActive ? "Stop voice conversation" : "Start voice conversation");
        micButton.title = micButton.getAttribute("aria-label");
    }
    function normalizeVoiceStopPhrase(text) {
        return String(text || "").normalize("NFC").toLowerCase()
            .replace(/^\s*(?:kalki|కల్కి)[,\s]*/i, "")
            .replace(/[.,!?;:…]+/g, " ")
            .replace(/\s+/g, " ").trim()
            .replace(/\s+(?:please|now)$/i, "").trim();
    }
    function getInputLanguage() {
        return voiceInputLanguage?.value || "en-IN";
    }
    function scheduleVoiceListening(delay = 400) {
        clearTimeout(voiceRestartTimer);
        if (!voiceConversationActive) return;
        voiceRestartTimer = setTimeout(startListening, delay);
    }
    function startListening() {
        if (!voiceConversationActive || voiceTurnPending || isListening || recognitionStarting) return;
        if (window.speechSynthesis?.speaking) { scheduleVoiceListening(500); return; }
        if (!SpeechRecognitionCtor) {
            setVoiceStatus("Voice input is not supported in this browser. Use Chrome.", false);
            stopVoiceConversation();
            return;
        }
        recognition = new SpeechRecognitionCtor();
        recognition.lang = getInputLanguage();
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        recognitionStarting = true;

        recognition.onstart = () => {
            recognitionStarting = false;
            isListening = true;
            setVoiceStatus("Listening… speak now. Say “stop” to end.");
            publishKalkiAssistantState("listening");
        };
        recognition.onresult = (event) => {
            const transcript = event.results?.[0]?.[0]?.transcript?.trim() || "";
            if (!transcript) return;
            if (VOICE_STOP_PHRASES.has(normalizeVoiceStopPhrase(transcript))) {
                stopVoiceConversation();
                return;
            }
            handleSend(transcript);
        };
        recognition.onerror = (event) => {
            recognitionStarting = false;
            isListening = false;
            if (event.error === "not-allowed" || event.error === "service-not-allowed") {
                setVoiceStatus("Microphone permission blocked. Allow mic access and try again.", false);
                stopVoiceConversation(false);
            }
        };
        recognition.onend = () => {
            recognitionStarting = false;
            isListening = false;
            if (voiceConversationActive && !voiceTurnPending) {
                setVoiceStatus("Voice conversation on.");
                scheduleVoiceListening(500);
            }
        };
        try { recognition.start(); }
        catch (_) { recognitionStarting = false; scheduleVoiceListening(800); }
    }
    function startVoiceConversation() {
        if (!SpeechRecognitionCtor) { alert("Voice input kosam Chrome vaadu."); return; }
        voiceConversationActive = true;
        updateMicButton();
        setVoiceStatus("Voice conversation on.");
        startListening();
    }
    function stopVoiceConversation(announce = true) {
        voiceConversationActive = false;
        voiceTurnPending = false;
        clearTimeout(voiceRestartTimer);
        if (recognition) { try { recognition.abort(); } catch (_) {} }
        isListening = false;
        recognitionStarting = false;
        stopSpeaking(false);
        updateMicButton();
        if (announce) setVoiceStatus("Voice conversation stopped. Tap 🎙 to start again.", false);
        publishKalkiAssistantState("idle");
    }

    /* ---------- Everyday tools (local, no API) ---------- */
    const JOKES = [
        "Programmer ki wife: 'Milk teesuko, eggs unte 6 teesuko.' Vaadu 6 milk packets techadu. 'Eggs unnayi kada!'",
        "Why do programmers prefer dark mode? Because light attracts bugs.",
        "Computer doctor ki velli: 'Naaku virus vachindi.' Doctor: 'Antivirus tisuko.'"
    ];
    const QUOTES = [
        "Chinna adugu kuda mundu ki veltene success.",
        "Ee roju nuvvu chesindi, repati nee future ni create chestundi.",
        "Failure ante aapadam kaadu, nerchukodam."
    ];
    function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
    function makePassword(len = 16) {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%&*";
        const buf = new Uint32Array(len);
        crypto.getRandomValues(buf);
        return Array.from(buf, (n) => chars[n % chars.length]).join("");
    }
    function detectEverydayTool(text) {
        if (/\b(open|launch)\s+(youtube|yt)\b/i.test(text)) return "openYouTube";
        if (/\b(open|launch)\s+google\b/i.test(text)) return "openGoogle";
        if (/\b(what time|tell me the time|time entha|samayam)\b/i.test(text)) return "time";
        if (/\b(
dice)\b/i.test(text)) return "dice";
        if (/\b(coin|flip)\b/i.test(text)) return "coin";
        if (/\b(joke)\b/i.test(text)) return "joke";
        if (/\b(motivat)/i.test(text)) return "motivation";
        if (/\b(password)\b/i.test(text)) return "password";
        return null;
    }
    function runEverydayTool(tool) {
        switch (tool) {
            case "time": return "Ippudu time: " + new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
            case "dice": return "🎲 Dice result: " + (Math.floor(Math.random() * 6) + 1);
            case "coin": return "🪙 " + (Math.random() < 0.5 ? "Heads" : "Tails");
            case "joke": return pick(JOKES);
            case "motivation": return "✨ " + pick(QUOTES);
            case "password": return "🔐 Strong password: " + makePassword() + "\n(Idi save chesuko, chat history lo untundi. Kavalante Clear chey.)";
            case "openYouTube": window.open("https://www.youtube.com", "_blank", "noopener"); return "YouTube open chesanu.";
            case "openGoogle": window.open("https://www.google.com", "_blank", "noopener"); return "Google open chesanu.";
        }
        return null;
    }

    /* ---------- Attachments ---------- */
    function closeAttachMenu() {
        if (attachMenu) attachMenu.hidden = true;
        attachBtn?.setAttribute("aria-expanded", "false");
    }
    function readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).split(",")[1] || "");
            r.onerror = () => reject(new Error("File chadavaledu."));
            r.readAsDataURL(file);
        });
    }
    async function handleFileSelected(file) {
        if (!file) return;
        if (file.size > 15 * 1024 * 1024) { showMessage("SYSTEM", "File chala pedda (max 15 MB).", "ai", false); return; }
        try {
            if (file.type.startsWith("image/") || file.type === "application/pdf") {
                pendingAttachment = { name: file.name, mimeType: file.type, data: await readFileAsBase64(file) };
            } else if (file.type.startsWith("text/") || /\.txt$/i.test(file.name)) {
                pendingAttachment = { name: file.name, mimeType: "text/plain", text: (await file.text()).slice(0, 30000) };
            } else {
                showMessage("SYSTEM", "Ee file type ippudu support ledu. Image, PDF leda .txt vaadu.", "ai", false);
                return;
            }
            showMessage("SYSTEM", "📎 " + file.name + " attach ayyindi. Ippudu nee question type chesi pampu.", "ai", false);
            messageInput?.focus();
        } catch (error) {
            showMessage("SYSTEM", error.message, "ai", false);
        }
    }

    /* ---------- Sending ---------- */
    async function handleSend(rawText) {
        const text = String(rawText ?? messageInput?.value ?? "").trim();
        if ((!text && !pendingAttachment) || busy) return;

        if (voiceConversationActive && VOICE_STOP_PHRASES.has(normalizeVoiceStopPhrase(text))) {
            stopVoiceConversation();
            return;
        }

        busy = true;
        voiceTurnPending = true;
        if (sendButton) sendButton.disabled = true;
        if (messageInput) messageInput.value = "";
        if (recognition && isListening) { try { recognition.abort(); } catch (_) {} }

        const attachment = pendingAttachment;
        pendingAttachment = null;
        const shown = attachment ? text + (text ? "\n" : "") + "📎 " + attachment.name : text;
        showMessage("YOU", shown, "user");

        // Local tools first (only when no attachment)
        const tool = attachment ? null : detectEverydayTool(text);
        if (tool) {
            const result = runEverydayTool(tool);
            if (result) showMessage("KALKI", result, "ai");
            finishSend();
            return;
        }

        if (!getApiKey()) {
            showMessage("SYSTEM", "Gemini API key ledu. Settings lo add chey.", "ai", false);
            openApiKeySettings();
            finishSend();
            return;
        }

        publishKalkiAssistantState("thinking");
        setVoiceStatus("Thinking…");
        const thinking = showMessage("KALKI", "…", "ai", false);

        try {
            const reply = await askGemini(attachment);
            thinking?.remove();
            showMessage("KALKI", reply, "ai");
        } catch (error) {
            thinking?.remove();
            if (error.message === "NO_API_KEY") openApiKeySettings();
            else showMessage("SYSTEM", "⚠️ " + error.message, "ai", false);
        }
        finishSend();
    }

    function finishSend() {
        busy = false;
        voiceTurnPending = false;
        if (sendButton) sendButton.disabled = false;
        publishKalkiAssistantState("idle");
        if (voiceConversationActive) {
            setVoiceStatus("Voice conversation on.");
            if (!window.speechSynthesis?.speaking) scheduleVoiceListening(600);
        }
    }

    /* ---------- Menu / settings wiring ---------- */
    let backdrop = document.querySelector(".sheet-backdrop");
    if (!backdrop) {
        backdrop = document.createElement("div");
        backdrop.className = "sheet-backdrop";
        document.body.appendChild(backdrop);
    }
    document.querySelector(".menu-button")?.addEventListener("click", () => document.body.classList.add("menu-open"));
    document.querySelector(".sheet-close")?.addEventListener("click", () => document.body.classList.remove("menu-open"));
    backdrop.addEventListener("click", () => document.body.classList.remove("menu-open"));

    document.querySelectorAll(".sheet-link").forEach((el) => {
        if (el.tagName === "BUTTON" && /new conversation/i.test(el.textContent)) {
            el.addEventListener("click", () => { clearConversation(); document.body.classList.remove("menu-open"); });
        }
    });
    $("tools-menu-link")?.addEventListener("click", (e) => {
        e.preventDefault();
        document.body.classList.remove("menu-open");
        $("everyday-tools")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    settingsToggle?.addEventListener("click", () => {
        if (!voiceSettings) return;
        const open = voiceSettings.hidden;
        voiceSettings.hidden = !open;
        settingsToggle.setAttribute("aria-expanded", String(open));
    });

    saveApiKeyButton?.addEventListener("click", saveApiKey);
    clearApiKeyButton?.addEventListener("click", clearApiKey);
    apiKeyInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveApiKey(); } });

    if (ttsAutoRead) {
        try { ttsAutoRead.checked = localStorage.getItem(TTS_AUTO_READ_KEY) === "true"; } catch (_) {}
        ttsAutoRead.addEventListener("change", () => {
            try { localStorage.setItem(TTS_AUTO_READ_KEY, String(ttsAutoRead.checked)); } catch (_) {}
        });
    }
    ttsStopButton?.addEventListener("click", () => stopSpeaking());
    ttsVoiceSelect?.addEventListener("change", () => {
        try { localStorage.setItem(TTS_VOICE_KEY, ttsVoiceSelect.value); } catch (_) {}
    });
    if (voiceInputLanguage) {
        try { voiceInputLanguage.value = localStorage.getItem(VOICE_INPUT_LANGUAGE_KEY) || voiceInputLanguage.value; } catch (_) {}
        voiceInputLanguage.addEventListener("change", () => {
            try { localStorage.setItem(VOICE_INPUT_LANGUAGE_KEY, voiceInputLanguage.value); } catch (_) {}
            if (voiceConversationActive && recognition) { try { recognition.abort(); } catch (_) {} }
        });
    }
    if ("speechSynthesis" in window) {
        populateVoices();
        window.speechSynthesis.addEventListener?.("voiceschanged", populateVoices);
    }

    attachBtn?.addEventListener("click", () => {
        const open = attachMenu?.hidden;
        if (attachMenu) attachMenu.hidden = !open;
        attachBtn.setAttribute("aria-expanded", String(open));
    });
    camBtn?.addEventListener("click", () => {
        if (!fileInput) return;
        fileInput.setAttribute("capture", "environment");
        fileInput.accept = "image/*";
        closeAttachMenu();
        fileInput.click();
    });
    fileBtn?.addEventListener("click", () => {
        if (!fileInput) return;
        fileInput.removeAttribute("capture");
        fileInput.accept = "image/*,.pdf,.txt";
        closeAttachMenu();
        fileInput.click();
    });
    fileInput?.addEventListener("change", () => {
        handleFileSelected(fileInput.files?.[0]);
        fileInput.value = "";
    });
    document.addEventListener("click", (e) => {
        if (attachMenu && !attachMenu.hidden && !attachMenu.contains(e.target) && e.target !== attachBtn) closeAttachMenu();
    });

    sendButton?.addEventListener("click", () => handleSend());
    messageInput?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
    clearButton?.addEventListener("click", clearConversation);
    micButton?.addEventListener("click", () => {
        if (voiceConversationActive) stopVoiceConversation();
        else startVoiceConversation();
    });

    /* ---------- Init ---------- */
    refreshApiKeyStatus();
    loadSavedChat();
    updateMicButton();
    publishKalkiAssistantState("idle");
});
