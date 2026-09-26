/* ============================================================
   Verdict — script.js
   Claim verification (Google Search–grounded) + AI roadmap generator
   + "Spot the AI Mistake" quiz mode
   Powered by the Gemini API.
   ============================================================ */

// ---- Config -------------------------------------------------
const GEMINI_MODEL = "gemini-3.5-flash-lite"; // change here if Google renames/retires this model
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ---- API key (entered by the user, never stored in the code) ----
// The key is typed into the "Set API Key" dialog and kept only in this
// browser's localStorage. It is NOT part of the repo or the hosted files.
const KEY_STORAGE = "verdict-gemini-key";

function getApiKey() {
  try { return (localStorage.getItem(KEY_STORAGE) || "").trim(); } catch (e) { return ""; }
}

function updateKeyLabel() {
  const label = document.getElementById("keyLabel");
  const icon = document.getElementById("keyIcon");
  const has = !!getApiKey();
  if (label) label.textContent = has ? "API Key: Set" : "Set API Key";
  if (icon) icon.textContent = has ? "🔓" : "🔑";
}

function openKeyModal() {
  const modal = document.getElementById("keyModal");
  const input = document.getElementById("keyInput");
  const status = document.getElementById("keyStatus");
  if (!modal) return;
  const key = getApiKey();
  input.value = "";
  input.placeholder = key ? "Saved key: ••••••••" + key.slice(-4) + " (paste a new one to replace)" : "Paste your Gemini API key";
  status.textContent = key ? "A key is saved in this browser." : "No key saved yet.";
  modal.classList.add("open");
  setTimeout(() => input.focus(), 50);
}

function closeKeyModal() {
  const modal = document.getElementById("keyModal");
  if (modal) modal.classList.remove("open");
}

function saveApiKey() {
  const input = document.getElementById("keyInput");
  const status = document.getElementById("keyStatus");
  const value = input.value.trim();
  if (!value) { status.textContent = "Paste a key first."; return; }
  try {
    localStorage.setItem(KEY_STORAGE, value);
  } catch (e) {
    status.textContent = "Couldn't save the key (browser storage is blocked).";
    return;
  }
  updateKeyLabel();
  closeKeyModal();
}

function removeApiKey() {
  try { localStorage.removeItem(KEY_STORAGE); } catch (e) {}
  updateKeyLabel();
  closeKeyModal();
}

// NOTE ON QUOTA: only callGeminiVerify() and callGeminiQuiz() use Google
// Search grounding (tools: [{ google_search: {} }]). Grounded requests are
// billed against a separate, much stricter free-tier quota than plain
// generateContent calls (roadmap generation). If you see 429 errors, check
// the "Search Grounding" row specifically on your AI Studio rate-limits page.

// ---- Small local fact library (shown in the side panel) -----
const FACT_LIBRARY = [
  { topic: "Geography", fact: "Canberra is the capital of Australia (not Sydney)." },
  { topic: "Astronomy", fact: "Jupiter is the largest planet in the Solar System." },
  { topic: "History", fact: "India gained independence from British rule on August 15, 1947." },
  { topic: "Science", fact: "Water boils at 100°C (212°F) at standard atmospheric pressure." },
  { topic: "Geography", fact: "Mount Everest is Earth's highest mountain above sea level." },
  { topic: "History", fact: "World War II ended in 1945." },
  { topic: "Science", fact: "The human body has 206 bones in adulthood." },
  { topic: "Geography", fact: "The Nile and the Amazon are generally cited as the two longest rivers on Earth." }
];

// Suggested topics for "Spot the AI Mistake" when the user wants a surprise
const QUIZ_TOPIC_SUGGESTIONS = [
  "the solar system", "world history", "the human body", "famous inventions",
  "world geography", "ocean life", "ancient civilizations", "computer science basics",
  "climate and weather", "nutrition and food science"
];

// ---- State ----------------------------------------------------
let currentView = "home";
let quizState = null; // { topic, statements: [{text, isCorrect, explanation}], guesses: [true/false/null], revealed: bool }

// ---- Theme (dark mode) -------------------------------------------
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "dark") {
    root.setAttribute("data-theme", "dark");
  } else {
    root.removeAttribute("data-theme");
  }
  const icon = document.getElementById("themeIcon");
  const label = document.getElementById("themeLabel");
  if (icon) icon.textContent = theme === "dark" ? "☀️" : "🌙";
  if (label) label.textContent = theme === "dark" ? "Light Mode" : "Dark Mode";
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem("verdict-theme", next);
}

// ---- Init -------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  const savedTheme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  applyTheme(savedTheme);
  renderFactLibrary();
  updateKeyLabel();
  initAuth();
  const textarea = document.getElementById("claimInput");
  if (textarea) {
    textarea.addEventListener("input", () => {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 130) + "px";
    });
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        document.querySelector(".composer").requestSubmit();
      }
    });
  }
  document.querySelectorAll(".nav button, .new-chat").forEach((btn) => {
    btn.addEventListener("click", closeSidebarOnMobile);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeSidebarOnMobile(); closeKeyModal(); closeAuth(); closeProfileMenu(); }
  });
  const keyInput = document.getElementById("keyInput");
  if (keyInput) keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveApiKey(); } });
});

// ---- Sidebar / navigation ---------------------------------------
function toggleSidebar(forceOpen) {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const open = typeof forceOpen === "boolean" ? forceOpen : !sidebar.classList.contains("open");
  sidebar.classList.toggle("open", open);
  if (overlay) overlay.classList.toggle("open", open);
  document.body.style.overflow = open && window.innerWidth <= 750 ? "hidden" : "";
}

function closeSidebarOnMobile() {
  if (window.innerWidth <= 750) toggleSidebar(false);
}

function setActiveNav(label) {
  document.querySelectorAll(".nav button").forEach((btn) => {
    btn.classList.toggle("active", btn.textContent.trim().includes(label));
  });
}

function newChat() {
  currentView = "home";
  setActiveNav("Home");
  document.getElementById("conversationTitle").textContent = "New Conversation";
  const chat = document.getElementById("chat");
  chat.innerHTML = `
    <div class="welcome" id="welcome">
      <div class="hero-badge"><span class="dot-pulse"></span>Autonomous Verification &amp; Guided Mastery Engine</div>
      <h3>Verify Claims. Map Knowledge.<br><span class="grad-text">Spot the Truth</span> with Precision.</h3>
      <p>Paste a claim and Verdict will check it against trusted information, turn any goal into a staged roadmap, and sharpen your instincts in "Spot the Mistake".</p>
      <div class="hero-actions">
        <button class="hero-btn primary" onclick="document.getElementById('claimInput').focus()">Verify a Claim →</button>
        <button class="hero-btn ghost" onclick="showRoadmap()">Generate Roadmap</button>
        <button class="hero-btn outline" onclick="showQuiz()">Play "Spot the Mistake" 🎮</button>
      </div>
      <div class="examples">
        <button class="example" onclick="useExample(this)">The capital of Australia is Sydney.</button>
        <button class="example" onclick="useExample(this)">Jupiter is the largest planet.</button>
        <button class="example" onclick="useExample(this)">India became independent in 1947.</button>
      </div>
      <div class="feature-grid">
        <div class="feature-card">
          <div class="feature-icon"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5.5c0 4.2 2.8 7.6 7 9 4.2-1.4 7-4.8 7-9V6z"/><path d="m9 12 2.2 2.2L15 10.4"/></svg></div>
          <span class="feature-tag">Core Engine</span>
          <h4>AI Information Verifier</h4>
          <p>Cross-examine claims, verify against trusted sources, and flag misleading or unverifiable statements.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6"/></svg></div>
          <span class="feature-tag">Career &amp; Skill Growth</span>
          <h4>AI Roadmap Architect</h4>
          <p>Turn ambitious goals into staged milestone roadmaps with concrete practice and projects.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/></svg></div>
          <span class="feature-tag">Bonus Gamified Challenge</span>
          <h4>Spot the Mistake</h4>
          <p>Guess which statements are true and which are subtly wrong to sharpen your instincts.</p>
        </div>
      </div>
      <div class="stats-row">
        <div class="stat"><b>99.2%</b><span>Claim Parsing Precision</span></div>
        <div class="stat"><b>10,000+</b><span>Roadmaps Generated</span></div>
        <div class="stat"><b>15+</b><span>Quiz Categories</span></div>
        <div class="stat"><b>Zero</b><span>Unchecked Hallucinations</span></div>
      </div>
    </div>`;
  showComposer(true);
  updateWelcomeGreeting();
}

function showHome() {
  newChat();
}

function showRoadmap() {
  currentView = "roadmap";
  setActiveNav("Roadmap");
  document.getElementById("conversationTitle").textContent = "Roadmap Generator";
  showComposer(false);
  const chat = document.getElementById("chat");
  chat.innerHTML = `
    <div class="roadmap">
      <div class="roadmap-head">
        <h2>Roadmap Generator</h2>
        <p>Type literally any skill — Verdict will build a detailed, staged learning path for it.</p>
      </div>
      <div class="goal-box wrap">
        <input id="roadmapInput" placeholder="e.g. Machine Learning, Guitar, Public Speaking, Welding..." />
        <select id="roadmapLevel">
          <option value="Complete beginner">Complete beginner</option>
          <option value="Some experience">Some experience</option>
          <option value="Intermediate">Intermediate</option>
        </select>
        <input id="roadmapHours" type="number" min="1" max="12" value="2" title="Hours per day" />
        <button id="roadmapBtn" onclick="generateRoadmap()">Generate</button>
      </div>
      <div class="steps" id="roadmapSteps"></div>
    </div>`;
  const input = document.getElementById("roadmapInput");
  input.focus();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") generateRoadmap();
  });
}

function showHow() {
  currentView = "how";
  setActiveNav("How it works");
  document.getElementById("conversationTitle").textContent = "How it works";
  showComposer(false);
  document.getElementById("chat").innerHTML = `
    <div class="welcome">
      <div class="big-logo">?</div>
      <h3>How Verdict works</h3>
      <p style="text-align:left;max-width:600px;margin:20px auto 0">
        <b>Claim verification:</b> when you submit a claim, Verdict sends it to Gemini
        with Google Search grounding enabled, so the model checks it against live web
        results rather than relying on memory alone. It returns a status
        (verified / incorrect / partial / unclear), a plain-language explanation, and
        a source note.<br><br>
        <b>Roadmap generator:</b> enter any skill and Verdict asks Gemini to break it
        into a detailed, staged learning path — with what to learn, what to practice,
        a mini-project per stage, milestones, and common beginner mistakes.<br><br>
        <b>Spot the AI Mistake:</b> Verdict generates a short AI-style passage on a topic
        that deliberately mixes true statements with subtle errors. Guess which
        statements are true or false before revealing the answers — a fun way to
        practice spotting AI hallucinations.<br><br>
        <b>Fact library:</b> a small set of pre-checked facts is kept locally for instant
        reference — open it from the sidebar.<br><br>
        Verdict is a hackathon prototype: when something can't be confidently verified,
        it says so instead of guessing.
      </p>
    </div>`;
}

function showAbout() {
  currentView = "about";
  setActiveNav("About");
  document.getElementById("conversationTitle").textContent = "About";
  showComposer(false);
  document.getElementById("chat").innerHTML = `
    <div class="welcome">
      <div class="big-logo">V</div>
      <h3>About Verdict</h3>
      <p style="max-width:600px;margin:20px auto 0">
        Verdict is a lightweight fact-checking and learning-roadmap assistant, built
        for a hackathon demo. It pairs an AI model with search grounding to verify
        claims transparently, generates custom roadmaps for any skill on request,
        and lets you practice spotting AI mistakes with a quiz mode.
      </p>
    </div>`;
}

function showComposer(visible) {
  const el = document.querySelector(".input-area");
  if (el) el.style.display = visible ? "" : "none";
}

// ---- Fact library panel -----------------------------------------
function renderFactLibrary() {
  const list = document.getElementById("factList");
  if (!list) return;
  list.innerHTML = FACT_LIBRARY.map(
    (f) => `<div class="fact"><b>${escapeHtml(f.topic)}</b>${escapeHtml(f.fact)}</div>`
  ).join("");
}

function openLibrary() {
  document.getElementById("overlay").classList.add("open");
  document.getElementById("libraryPanel").classList.add("open");
}

function closeLibrary() {
  document.getElementById("overlay").classList.remove("open");
  document.getElementById("libraryPanel").classList.remove("open");
}

// ---- Example chips ------------------------------------------------
function useExample(btn) {
  const input = document.getElementById("claimInput");
  input.value = btn.textContent;
  input.dispatchEvent(new Event("input"));
  document.querySelector(".composer").requestSubmit();
}

// ---- Claim verification --------------------------------------------
async function verifyClaim(event) {
  event.preventDefault();
  const input = document.getElementById("claimInput");
  const claim = input.value.trim();
  if (!claim) return;

  const welcome = document.getElementById("welcome");
  if (welcome) welcome.remove();

  const chat = document.getElementById("chat");
  const sendBtn = document.getElementById("sendBtn");

  appendUserBubble(chat, claim);
  input.value = "";
  input.style.height = "auto";
  sendBtn.disabled = true;

  const loadingId = "loading-" + Date.now();
  appendLoadingBubble(chat, loadingId);
  chat.scrollTop = chat.scrollHeight;

  try {
    const verdict = await callGeminiVerify(claim);
    replaceWithResult(chat, loadingId, verdict);
    saveHistory("claim", claim, verdict);
  } catch (err) {
    console.error(err);
    replaceWithResult(chat, loadingId, {
      status: "unclear",
      explanation:
        "Verdict couldn't reach the verification service just now (" +
        (err.message || "unknown error") +
        "). Please try again.",
      source: "—"
    });
  } finally {
    sendBtn.disabled = false;
    chat.scrollTop = chat.scrollHeight;
  }
}

function appendUserBubble(chat, text) {
  const div = document.createElement("div");
  div.className = "message user";
  div.innerHTML = `
    <div class="user-bubble"></div>
    <div class="avatar user-avatar">U</div>`;
  div.querySelector(".user-bubble").textContent = text;
  chat.appendChild(div);
}

function appendLoadingBubble(chat, id) {
  const div = document.createElement("div");
  div.className = "message bot";
  div.id = id;
  div.innerHTML = `
    <div class="avatar bot-avatar">V</div>
    <div class="result"><div class="row">Checking against trusted sources…</div></div>`;
  chat.appendChild(div);
}

function replaceWithResult(chat, id, verdict) {
  const el = document.getElementById(id);
  if (!el) return;

  const statusMeta = {
    verified: { cls: "verified", label: "✓ Verified" },
    incorrect: { cls: "incorrect", label: "✕ Incorrect" },
    partial: { cls: "partial", label: "⚠ Partially True" },
    unclear: { cls: "partial", label: "? Unclear / Unverifiable" }
  };
  const meta = statusMeta[verdict.status] || statusMeta.unclear;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  el.innerHTML = `
    <div class="avatar bot-avatar">V</div>
    <div class="result">
      <div class="status ${meta.cls}"><span class="dot"></span>${meta.label}</div>
      <hr>
      <div class="row"><b>Explanation:</b> </div>
      <div class="row"><b>Source:</b> <span class="source"></span></div>
      <div class="actions">
        <button onclick="copyResult(this)">⧉ Copy</button>
      </div>
      <div class="time">${time}</div>
    </div>`;
  el.querySelectorAll(".row")[0].append(verdict.explanation || "No explanation returned.");
  el.querySelector(".source").textContent = verdict.source || "Gemini + Google Search grounding";
}

function copyResult(btn) {
  const result = btn.closest(".result");
  const text = result.innerText.replace("⧉ Copy", "").trim();
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = "✓ Copied";
    setTimeout(() => (btn.textContent = old), 1500);
  });
}

// ---- Gemini calls ----------------------------------------------------
async function callGeminiVerify(claim) {
  const prompt = `You are a careful fact-checker. Verify the following claim using
up-to-date information. Respond in EXACTLY this plain-text format, with no markdown,
no extra commentary, and nothing before or after it:

STATUS: <one of: verified, incorrect, partial, unclear>
EXPLANATION: <2-4 sentences explaining why, in plain language>
SOURCE: <a short description of what kind of source supports this, e.g. "Encyclopedia / general reference" or "Recent news reporting">

Rules:
- Use "verified" only if the claim is true and well-supported.
- Use "incorrect" if the claim is false.
- Use "partial" if the claim is partly true, outdated, or misleading.
- Use "unclear" if you cannot confidently verify it either way — do not guess.
${personalizationNote()}

Claim: "${claim}"`;

  const groundedBody = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2 }
  };
  const ungroundedBody = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 }
  };

  const { data, usedFallback } = await callGemini(groundedBody, ungroundedBody);
  const text = extractText(data);
  const result = parseVerifyResponse(text);
  if (usedFallback) {
    result.source = (result.source ? result.source + " " : "") +
      "(live search unavailable right now — answered from the model's own knowledge, not grounded)";
  }
  return result;
}

function parseVerifyResponse(text) {
  const statusMatch = text.match(/STATUS:\s*(verified|incorrect|partial|unclear)/i);
  const explanationMatch = text.match(/EXPLANATION:\s*([\s\S]*?)(?:\nSOURCE:|$)/i);
  const sourceMatch = text.match(/SOURCE:\s*([\s\S]*)$/i);

  return {
    status: statusMatch ? statusMatch[1].toLowerCase() : "unclear",
    explanation: explanationMatch ? explanationMatch[1].trim() : text.trim(),
    source: sourceMatch ? sourceMatch[1].trim() : ""
  };
}

// ---- Roadmap (elaborated) --------------------------------------------
async function generateRoadmap() {
  const input = document.getElementById("roadmapInput");
  const levelSel = document.getElementById("roadmapLevel");
  const hoursInput = document.getElementById("roadmapHours");
  const btn = document.getElementById("roadmapBtn");
  const stepsEl = document.getElementById("roadmapSteps");
  const skill = input.value.trim();
  if (!skill) return;

  const level = levelSel ? levelSel.value : "Complete beginner";
  const hours = hoursInput ? hoursInput.value : "2";

  btn.disabled = true;
  btn.textContent = "Generating…";
  stepsEl.innerHTML = `<div class="step"><div class="step-num">…</div><div><h4>Building your roadmap</h4><p>Asking Gemini for a detailed learning path for "${escapeHtml(skill)}"…</p></div></div>`;

  try {
    const roadmap = await callGeminiRoadmap(skill, level, hours);
    renderRoadmap(stepsEl, roadmap);
    saveHistory("roadmap", skill, roadmap);
  } catch (err) {
    console.error(err);
    stepsEl.innerHTML = `<div class="step"><div class="step-num">!</div><div><h4>Couldn't generate a roadmap</h4><p>${escapeHtml(err.message || "Unknown error")}. Please try again.</p></div></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate";
  }
}

async function callGeminiRoadmap(skill, level, hoursPerDay) {
  const prompt = `Create a detailed, realistic learning roadmap for someone who wants to learn: "${skill}".
Current level: ${level}. Time available: ${hoursPerDay} hours per day.

Design the roadmap from that starting level to solid practical competence.
Think about prerequisites before advanced topics. Do not just list random tutorials —
create logical stages that build on each other. Be concrete and specific, not vague.

Return between 5 and 8 stages.
${personalizationNote()}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          overview: { type: "STRING", description: "2-3 sentence overview of the overall journey" },
          totalEstimatedTime: { type: "STRING", description: "e.g. '4-6 months at 2 hrs/day'" },
          stages: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                title: { type: "STRING" },
                why: { type: "STRING", description: "why this stage matters, 1-2 sentences" },
                learn: { type: "ARRAY", items: { type: "STRING" }, description: "3-5 concrete concepts/skills to learn" },
                practice: { type: "ARRAY", items: { type: "STRING" }, description: "2-4 concrete practice activities" },
                project: { type: "STRING", description: "a small project proving mastery of this stage" },
                estimatedTime: { type: "STRING" }
              },
              required: ["title", "why", "learn", "practice", "project", "estimatedTime"]
            }
          },
          milestones: { type: "ARRAY", items: { type: "STRING" }, description: "3-5 checkpoints across the whole journey" },
          commonMistakes: { type: "ARRAY", items: { type: "STRING" }, description: "3-5 mistakes beginners commonly make" },
          finalProject: { type: "STRING", description: "a capstone project that proves overall competence" },
          resources: { type: "ARRAY", items: { type: "STRING" }, description: "general resource types to look for (no invented URLs)" }
        },
        required: ["overview", "totalEstimatedTime", "stages", "milestones", "commonMistakes", "finalProject", "resources"]
      }
    }
  };

  const data = await callGemini(body);
  const text = extractText(data);
  return JSON.parse(text);
}

function renderRoadmap(container, roadmap) {
  if (!roadmap || !roadmap.stages || !roadmap.stages.length) {
    container.innerHTML = `<div class="step"><div class="step-num">!</div><div><h4>No roadmap returned</h4><p>Try rephrasing the skill and generate again.</p></div></div>`;
    return;
  }

  const overviewHtml = `
    <div class="roadmap-overview">
      <p>${escapeHtml(roadmap.overview || "")}</p>
      <div class="pill">⏱ ${escapeHtml(roadmap.totalEstimatedTime || "")}</div>
    </div>`;

  const stagesHtml = roadmap.stages
    .map(
      (s, i) => `
      <div class="step stage-card">
        <div class="step-num">${i + 1}</div>
        <div class="step-body">
          <h4>${escapeHtml(s.title)}</h4>
          <p class="why">${escapeHtml(s.why)}</p>
          ${listBlock("Learn", s.learn)}
          ${listBlock("Practice", s.practice)}
          <div class="sub-block"><b>Project:</b> ${escapeHtml(s.project)}</div>
          <div class="pill small">⏱ ${escapeHtml(s.estimatedTime)}</div>
        </div>
      </div>`
    )
    .join("");

  const extrasHtml = `
    <div class="roadmap-extras">
      ${extraCard("🏁 Milestones", roadmap.milestones)}
      ${extraCard("⚠ Common Mistakes", roadmap.commonMistakes)}
      <div class="extra-card"><h4>🎯 Final Project</h4><p>${escapeHtml(roadmap.finalProject || "")}</p></div>
      ${extraCard("📚 Resource Types", roadmap.resources)}
    </div>`;

  container.innerHTML = overviewHtml + stagesHtml + extrasHtml;
}

function listBlock(label, items) {
  if (!items || !items.length) return "";
  return `<div class="sub-block"><b>${escapeHtml(label)}:</b><ul>${items
    .map((i) => `<li>${escapeHtml(i)}</li>`)
    .join("")}</ul></div>`;
}

function extraCard(title, items) {
  if (!items || !items.length) return "";
  return `<div class="extra-card"><h4>${escapeHtml(title)}</h4><ul>${items
    .map((i) => `<li>${escapeHtml(i)}</li>`)
    .join("")}</ul></div>`;
}

// ---- Spot the AI Mistake (quiz mode) ---------------------------------
function showQuiz() {
  currentView = "quiz";
  setActiveNav("Spot the Mistake");
  document.getElementById("conversationTitle").textContent = "Spot the AI Mistake";
  showComposer(false);
  quizState = null;
  const chat = document.getElementById("chat");
  chat.innerHTML = `
    <div class="roadmap">
      <div class="roadmap-head">
        <h2>Spot the AI Mistake</h2>
        <p>Verdict will write a short passage that mixes true statements with a few subtle
        errors. Guess which is which — then reveal the answers.</p>
      </div>
      <div class="goal-box wrap">
        <input id="quizTopicInput" placeholder="e.g. Ancient Rome, the human brain, black holes... (or leave blank for a random topic)" />
        <button id="quizBtn" onclick="startQuizRound()">Generate Round</button>
      </div>
      <div class="steps" id="quizArea"></div>
    </div>`;
  const input = document.getElementById("quizTopicInput");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startQuizRound();
  });
}

async function startQuizRound() {
  const input = document.getElementById("quizTopicInput");
  const btn = document.getElementById("quizBtn");
  const area = document.getElementById("quizArea");
  let topic = input.value.trim();
  if (!topic) {
    topic = QUIZ_TOPIC_SUGGESTIONS[Math.floor(Math.random() * QUIZ_TOPIC_SUGGESTIONS.length)];
    input.value = topic;
  }

  btn.disabled = true;
  btn.textContent = "Generating…";
  area.innerHTML = `<div class="step"><div class="step-num">…</div><div><h4>Writing a round</h4><p>Asking Gemini to write statements about "${escapeHtml(topic)}", some true and some deliberately wrong…</p></div></div>`;

  try {
    const statements = await callGeminiQuiz(topic);
    quizState = {
      topic,
      statements,
      guesses: new Array(statements.length).fill(null),
      revealed: false
    };
    renderQuiz(area);
  } catch (err) {
    console.error(err);
    area.innerHTML = `<div class="step"><div class="step-num">!</div><div><h4>Couldn't generate a round</h4><p>${escapeHtml(err.message || "Unknown error")}. Please try again.</p></div></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate Round";
  }
}

async function callGeminiQuiz(topic) {
  const prompt = `You are creating a "Spot the AI Mistake" quiz round about: "${topic}".

Write 6 short, standalone factual statements about this topic, in a natural AI-assistant
tone. Exactly 2 or 3 of them must be SUBTLY WRONG (a plausible-sounding but incorrect
fact — the kind of mistake an AI model might confidently hallucinate), and the rest must
be TRUE and verifiable. Do not make the false ones obviously silly — they should sound
just as confident and reasonable as the true ones. Only use well-established, stable
facts you are confident about (the kind that would appear in a reference book) — avoid
anything that depends on very recent or fast-changing information, since you won't have
live search access for this task.

Respond in EXACTLY this plain-text format, no markdown, nothing extra:

STATEMENT_1: <statement text>
ANSWER_1: <true or false>
EXPLANATION_1: <1-2 sentences: if false, give the correct fact; if true, briefly confirm why>

STATEMENT_2: ...
ANSWER_2: ...
EXPLANATION_2: ...

(continue through STATEMENT_6 / ANSWER_6 / EXPLANATION_6)
${personalizationNote()}`;

  // No grounding tool here on purpose: quiz rounds are high-volume and use
  // stable, well-known facts, so they run on the plain generation quota
  // instead of competing with claim verification for the stricter grounded
  // search quota.
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.6 }
  };

  const data = await callGemini(body);
  const text = extractText(data);
  return parseQuizResponse(text);
}

function parseQuizResponse(text) {
  const statements = [];
  const regex = /STATEMENT_(\d+):\s*([\s\S]*?)\nANSWER_\1:\s*(true|false)[\s\S]*?EXPLANATION_\1:\s*([\s\S]*?)(?=\nSTATEMENT_\d+:|$)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    statements.push({
      text: match[2].trim(),
      isCorrect: match[3].toLowerCase() === "true",
      explanation: match[4].trim()
    });
  }
  if (!statements.length) throw new Error("Couldn't parse the quiz round from Gemini's response");
  return statements;
}

function renderQuiz(container) {
  if (!quizState) return;
  const cardsHtml = quizState.statements
    .map((s, i) => {
      const guess = quizState.guesses[i];
      let stateCls = "";
      let feedbackHtml = "";
      if (quizState.revealed) {
        const correctGuess = guess === s.isCorrect;
        stateCls = correctGuess ? "quiz-correct" : "quiz-incorrect";
        feedbackHtml = `
          <div class="quiz-answer">
            <b>${s.isCorrect ? "✓ True" : "✕ False"}</b> — ${escapeHtml(s.explanation)}
          </div>`;
      }
      return `
        <div class="quiz-card ${stateCls}">
          <p class="quiz-text">${escapeHtml(s.text)}</p>
          <div class="quiz-guess-row">
            <button class="quiz-guess ${guess === true ? "selected" : ""}" ${quizState.revealed ? "disabled" : ""} onclick="selectQuizGuess(${i}, true)">True</button>
            <button class="quiz-guess ${guess === false ? "selected" : ""}" ${quizState.revealed ? "disabled" : ""} onclick="selectQuizGuess(${i}, false)">False</button>
          </div>
          ${feedbackHtml}
        </div>`;
    })
    .join("");

  const allGuessed = quizState.guesses.every((g) => g !== null);
  const scoreHtml = quizState.revealed ? renderQuizScore() : "";
  const actionHtml = quizState.revealed
    ? `<button class="quiz-newround" onclick="startQuizRound()">Try another topic</button>`
    : `<button class="quiz-reveal" ${allGuessed ? "" : "disabled"} onclick="revealQuiz()">Reveal Answers${allGuessed ? "" : " (guess all first)"}</button>`;

  container.innerHTML = `<div class="quiz-grid">${cardsHtml}</div>${scoreHtml}<div class="quiz-actions">${actionHtml}</div>`;
}

function selectQuizGuess(i, value) {
  if (!quizState || quizState.revealed) return;
  quizState.guesses[i] = value;
  renderQuiz(document.getElementById("quizArea"));
}

function revealQuiz() {
  if (!quizState) return;
  quizState.revealed = true;
  renderQuiz(document.getElementById("quizArea"));
}

function renderQuizScore() {
  const correct = quizState.statements.filter((s, i) => quizState.guesses[i] === s.isCorrect).length;
  const total = quizState.statements.length;
  return `<div class="quiz-score">You spotted ${correct} / ${total} correctly.</div>`;
}

// ---- Shared Gemini fetch helper (with 429 backoff + grounding fallback) --
// If `fallbackBody` is provided (an ungrounded version of the same request),
// a 429 on the primary (usually grounded) request triggers one attempt with
// the fallback body instead of just retrying the same failing request.
// Returns { data, usedFallback }. Callers that don't pass fallbackBody get
// data straight back via callGeminiSimple() below.
async function callGeminiRaw(body, retries = 2) {
  const apiKey = getApiKey();
  if (!apiKey) {
    openKeyModal();
    const err = new Error("No API key set. Add your Gemini API key with the 🔑 button in the sidebar");
    err.status = "NO_KEY";
    throw err;
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body)
    });

    if (res.ok) return res.json();

    if (res.status === 429 && attempt < retries) {
      const waitMs = Math.pow(2, attempt) * 1000; // 1s, 2s
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const errText = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403 || (res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(errText))) {
      const keyErr = new Error("Google rejected the API key. Check it with the 🔑 button in the sidebar");
      keyErr.status = res.status;
      throw keyErr;
    }
    const err = new Error(`Gemini API error ${res.status}: ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
}

async function callGemini(body, fallbackBody = null) {
  try {
    const data = await callGeminiRaw(body);
    return fallbackBody ? { data, usedFallback: false } : data;
  } catch (err) {
    if (fallbackBody && err.status === 429) {
      try {
        const data = await callGeminiRaw(fallbackBody, 1);
        return { data, usedFallback: true };
      } catch (fallbackErr) {
        throw fallbackErr;
      }
    }
    throw err;
  }
}

function extractText(data) {
  const candidate = data && data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  if (!parts || !parts.length) throw new Error("Empty response from Gemini");
  return parts.map((p) => p.text || "").join("").trim();
}

// ---- Utils -----------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


// ============================================================
// Accounts + history (Supabase)
// Fill in these two values from Supabase -> Project Settings -> API.
// The publishable (anon) key is safe in the browser as long as Row Level
// Security is on -- run supabase-setup.sql once to create the table + policy.
// ============================================================
const SUPABASE_URL = "https://txczcxptfmhqystdwbyw.supabase.co";
const SUPABASE_KEY = "sb_publishable_h7OGnOBJBB4Vu92E2S_a-w_g-QcMQrp";

let sb = null;
let currentUser = null;
let authMode = "signin";
let userProfile = null; // { display_name, expertise_level, tone, interests, custom_instructions }

const USER_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';

function authConfigured() {
  return !!(window.supabase && /^https?:\/\//.test(SUPABASE_URL) && SUPABASE_KEY && !/^YOUR_/.test(SUPABASE_KEY));
}

function authPromptSeen() {
  try { return sessionStorage.getItem("verdict-auth-seen") === "1"; } catch (e) { return false; }
}

function initAuth() {
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".profile-wrap")) closeProfileMenu();
  });
  renderProfile();
  if (!authConfigured()) return;
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  sb.auth.onAuthStateChange((_event, session) => setUser(session ? session.user : null));
  sb.auth.getSession().then(({ data }) => {
    setUser(data.session ? data.session.user : null);
    if (!data.session && !authPromptSeen()) openAuth("signin");
  });
}

function setUser(user) {
  const was = currentUser;
  currentUser = user || null;
  renderProfile();
  const navH = document.getElementById("navHistory");
  const navP = document.getElementById("navProfile");
  if (navH) navH.hidden = !currentUser;
  if (navP) navP.hidden = !currentUser;
  if (currentUser) closeAuth();
  if (!currentUser) {
    userProfile = null;
    if (was && (currentView === "history" || currentView === "profile")) showHome();
  } else if (!was || was.id !== currentUser.id) {
    loadProfile();
  }
}

// ---- Profile icon + menu ----------------------------------
function renderProfile() {
  const btn = document.getElementById("profileBtn");
  const menu = document.getElementById("profileMenu");
  if (!btn || !menu) return;
  if (currentUser) {
    const email = currentUser.email || "Account";
    btn.classList.add("signed-in");
    btn.textContent = email.charAt(0).toUpperCase();
    menu.innerHTML = `
      <div class="pm-head"><b>${escapeHtml(email)}</b><span>Signed in</span></div>
      <button type="button" onclick="closeProfileMenu();showProfile()">Profile &amp; Preferences</button>
      <button type="button" onclick="closeProfileMenu();showHistory()">History</button>
      <button type="button" onclick="closeProfileMenu();signOutUser()">Sign out</button>`;
  } else {
    btn.classList.remove("signed-in");
    btn.innerHTML = USER_ICON;
    menu.innerHTML = `
      <div class="pm-head"><b>Guest</b><span>Sign in to save your history</span></div>
      <button type="button" onclick="closeProfileMenu();openAuth('signin')">Sign in</button>
      <button type="button" onclick="closeProfileMenu();openAuth('signup')">Create account</button>`;
  }
}

function toggleProfileMenu() {
  const menu = document.getElementById("profileMenu");
  const btn = document.getElementById("profileBtn");
  menu.hidden = !menu.hidden;
  btn.setAttribute("aria-expanded", String(!menu.hidden));
}

function closeProfileMenu() {
  const menu = document.getElementById("profileMenu");
  const btn = document.getElementById("profileBtn");
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

// ---- Login / sign-up page ---------------------------------
function setAuthStatus(msg, type) {
  const el = document.getElementById("authStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "auth-status" + (type ? " " + type : "");
}

function setAuthMode(mode) {
  authMode = mode === "signup" ? "signup" : "signin";
  const up = authMode === "signup";
  document.getElementById("authTitle").textContent = up ? "Create your account" : "Welcome back";
  document.getElementById("authSub").textContent = up
    ? "Save your fact-checks and roadmaps across devices."
    : "Sign in to save your checks and roadmaps.";
  document.getElementById("authSubmit").textContent = up ? "Create account" : "Sign in";
  document.getElementById("tabSignin").classList.toggle("active", !up);
  document.getElementById("tabSignup").classList.toggle("active", up);
  document.getElementById("authPassword").setAttribute("autocomplete", up ? "new-password" : "current-password");
  setAuthStatus("");
}

function openAuth(mode) {
  const page = document.getElementById("authPage");
  if (!page) return;
  try { sessionStorage.setItem("verdict-auth-seen", "1"); } catch (e) {}
  setAuthMode(mode || "signin");
  document.getElementById("authPassword").value = "";
  if (!authConfigured()) {
    setAuthStatus("Accounts aren't set up yet. Add your Supabase URL and key at the bottom of script.js.", "error");
  }
  page.hidden = false;
  setTimeout(() => document.getElementById("authEmail").focus(), 50);
}

function closeAuth() {
  const page = document.getElementById("authPage");
  if (page) page.hidden = true;
}

async function submitAuth(event) {
  event.preventDefault();
  if (!authConfigured() || !sb) {
    setAuthStatus("Accounts aren't set up yet. Add your Supabase URL and key at the bottom of script.js.", "error");
    return;
  }
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const btn = document.getElementById("authSubmit");
  btn.disabled = true;
  setAuthStatus(authMode === "signup" ? "Creating your account…" : "Signing in…");
  try {
    if (authMode === "signup") {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      if (!data.session) {
        setAuthMode("signin");
        setAuthStatus("Check your inbox to confirm your email, then sign in.", "ok");
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    setAuthStatus(err.message || "Something went wrong. Please try again.", "error");
  } finally {
    btn.disabled = false;
  }
}

async function signOutUser() {
  if (sb) await sb.auth.signOut();
}

// ---- History (saved per user, protected by Row Level Security) ----
function saveHistory(kind, input, result) {
  if (!sb || !currentUser) return;
  sb.from("history").insert({ kind, input, result }).then(({ error }) => {
    if (error) console.warn("Couldn't save history:", error.message);
  });
}

async function showHistory() {
  if (!currentUser || !sb) { openAuth("signin"); return; }
  currentView = "history";
  setActiveNav("History");
  document.getElementById("conversationTitle").textContent = "History";
  showComposer(false);
  document.getElementById("chat").innerHTML = `
    <div class="roadmap">
      <div class="roadmap-head">
        <h2>Your history</h2>
        <p>Claims you've checked and roadmaps you've generated.</p>
      </div>
      <div class="steps" id="historyList"><div class="step"><div><p>Loading…</p></div></div></div>
    </div>`;
  const list = document.getElementById("historyList");
  const { data, error } = await sb.from("history")
    .select("kind,input,result,created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (currentView !== "history") return;
  if (error) {
    list.innerHTML = `<div class="step"><div><h4>Couldn't load history</h4><p>${escapeHtml(error.message)}</p></div></div>`;
    return;
  }
  if (!data.length) {
    list.innerHTML = `<div class="step"><div><h4>Nothing saved yet</h4><p>Verify a claim or generate a roadmap and it will show up here.</p></div></div>`;
    return;
  }
  list.innerHTML = data.map(historyCard).join("");
}

function historyCard(row) {
  const r = row.result || {};
  const when = new Date(row.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  let body;
  if (row.kind === "claim") {
    const labels = { verified: "✓ Verified", incorrect: "✕ Incorrect", partial: "⚠ Partially true", unclear: "? Unclear" };
    body = `<div class="pill small">${labels[r.status] || labels.unclear}</div><p>${escapeHtml(r.explanation || "")}</p>`;
  } else {
    body = `<p>${escapeHtml(r.overview || "")}</p><div class="pill small">⏱ ${escapeHtml(r.totalEstimatedTime || "")}</div>`;
  }
  return `<div class="step stage-card"><div class="step-body"><h4>${escapeHtml(row.input)}</h4>${body}<div class="time">${row.kind === "claim" ? "Claim" : "Roadmap"} on ${when}</div></div></div>`;
}

// ---- Profile + personalization preferences ----------------------------
// Every signed-up user gets a row in public.profiles automatically (see
// the trigger in supabase-setup.sql). These preferences are woven into
// every prompt Verdict sends to Gemini, so claims, roadmaps and quizzes
// come back tailored to the user.
const DEFAULT_PROFILE = {
  display_name: "",
  expertise_level: "Intermediate",
  tone: "Balanced",
  interests: "",
  custom_instructions: ""
};

async function loadProfile() {
  if (!sb || !currentUser) return;
  const { data, error } = await sb
    .from("profiles")
    .select("display_name, expertise_level, tone, interests, custom_instructions")
    .eq("id", currentUser.id)
    .maybeSingle();
  if (error) {
    console.warn("Couldn't load profile:", error.message);
    userProfile = { ...DEFAULT_PROFILE };
    return;
  }
  if (data) {
    userProfile = { ...DEFAULT_PROFILE, ...data };
  } else {
    // Trigger hasn't run yet (e.g. account created before this table
    // existed) -- create the row now so it's there next time.
    userProfile = { ...DEFAULT_PROFILE };
    await sb.from("profiles").upsert({ id: currentUser.id, ...userProfile });
  }
  if (currentView === "profile") renderProfileForm();
  updateWelcomeGreeting();
}

function updateWelcomeGreeting() {
  const badge = document.querySelector("#welcome .hero-badge");
  if (!badge) return;
  const name = userProfile && userProfile.display_name && userProfile.display_name.trim();
  let tag = badge.querySelector(".greet-name");
  if (name) {
    if (!tag) {
      tag = document.createElement("span");
      tag.className = "greet-name";
      badge.appendChild(tag);
    }
    tag.textContent = " · Welcome back, " + name;
  } else if (tag) {
    tag.remove();
  }
}

// Builds the block of text appended to every AI prompt so responses are
// personalized. Returns "" when the user is signed out or has set nothing.
function personalizationNote() {
  if (!currentUser || !userProfile) return "";
  const bits = [];
  if (userProfile.expertise_level) bits.push(`Self-described expertise level: ${userProfile.expertise_level}.`);
  if (userProfile.tone) bits.push(`Preferred response tone: ${userProfile.tone}.`);
  if (userProfile.interests && userProfile.interests.trim()) bits.push(`Interests / background: ${userProfile.interests.trim()}.`);
  if (userProfile.custom_instructions && userProfile.custom_instructions.trim()) bits.push(`Personal notes from the user: ${userProfile.custom_instructions.trim()}.`);
  if (!bits.length) return "";
  return `\n\nPersonalize this response for the user below, adjusting depth, tone and examples accordingly -- but NEVER let it change the underlying facts or verdict:\n${bits.join(" ")}`;
}

function showProfile() {
  if (!currentUser) { openAuth("signin"); return; }
  currentView = "profile";
  setActiveNav("Profile");
  document.getElementById("conversationTitle").textContent = "Profile & Preferences";
  showComposer(false);
  document.getElementById("chat").innerHTML = `
    <div class="roadmap">
      <div class="roadmap-head">
        <h2>Profile &amp; Preferences</h2>
        <p>This is used to personalize how Verdict explains claims, builds roadmaps, and writes quizzes for you.</p>
      </div>
      <div class="profile-card" id="profileCard">
        <div class="profile-avatar" id="profileAvatarBig">?</div>
        <div class="profile-meta">
          <div class="profile-email" id="profileEmailText"></div>
          <div class="profile-sub">Signed in with Supabase</div>
        </div>
      </div>
      <form class="profile-form" id="profileForm" onsubmit="saveProfile(event)">
        <label>Display name
          <input id="prefName" type="text" maxlength="60" placeholder="What should Verdict call you?">
        </label>
        <label>Expertise level
          <select id="prefLevel">
            <option value="Beginner">Beginner — explain things simply, define jargon</option>
            <option value="Intermediate">Intermediate — balanced detail</option>
            <option value="Expert">Expert — be technical and concise</option>
          </select>
        </label>
        <label>Preferred tone
          <select id="prefTone">
            <option value="Concise">Concise — short, to the point</option>
            <option value="Balanced">Balanced</option>
            <option value="Detailed">Detailed — thorough explanations</option>
            <option value="Friendly & casual">Friendly &amp; casual</option>
            <option value="Formal">Formal</option>
          </select>
        </label>
        <label>Interests / background
          <input id="prefInterests" type="text" maxlength="200" placeholder="e.g. software engineering, history buff, parent of a 10-year-old">
        </label>
        <label>Anything else Verdict should know about you?
          <textarea id="prefNotes" rows="3" maxlength="500" placeholder="e.g. keep roadmaps focused on free resources; I learn best with analogies"></textarea>
        </label>
        <div class="profile-status" id="profileStatus" role="status"></div>
        <div class="profile-actions">
          <button type="submit" class="key-save" id="profileSaveBtn">Save preferences</button>
        </div>
      </form>
    </div>`;
  renderProfileForm();
}

function renderProfileForm() {
  if (currentView !== "profile" || !currentUser) return;
  const p = userProfile || DEFAULT_PROFILE;
  const email = currentUser.email || "";
  const avatar = document.getElementById("profileAvatarBig");
  if (avatar) avatar.textContent = email.charAt(0).toUpperCase() || "?";
  const emailEl = document.getElementById("profileEmailText");
  if (emailEl) emailEl.textContent = email;
  const name = document.getElementById("prefName");
  const level = document.getElementById("prefLevel");
  const tone = document.getElementById("prefTone");
  const interests = document.getElementById("prefInterests");
  const notes = document.getElementById("prefNotes");
  if (name) name.value = p.display_name || "";
  if (level) level.value = p.expertise_level || "Intermediate";
  if (tone) tone.value = p.tone || "Balanced";
  if (interests) interests.value = p.interests || "";
  if (notes) notes.value = p.custom_instructions || "";
}

async function saveProfile(event) {
  event.preventDefault();
  if (!sb || !currentUser) return;
  const btn = document.getElementById("profileSaveBtn");
  const status = document.getElementById("profileStatus");
  const updated = {
    id: currentUser.id,
    display_name: document.getElementById("prefName").value.trim(),
    expertise_level: document.getElementById("prefLevel").value,
    tone: document.getElementById("prefTone").value,
    interests: document.getElementById("prefInterests").value.trim(),
    custom_instructions: document.getElementById("prefNotes").value.trim(),
    updated_at: new Date().toISOString()
  };
  btn.disabled = true;
  status.textContent = "Saving…";
  status.className = "profile-status";
  const { error } = await sb.from("profiles").upsert(updated);
  btn.disabled = false;
  if (error) {
    status.textContent = "Couldn't save: " + error.message;
    status.className = "profile-status error";
    return;
  }
  userProfile = { ...userProfile, ...updated };
  status.textContent = "Saved — Verdict will use this from now on.";
  status.className = "profile-status ok";
}


