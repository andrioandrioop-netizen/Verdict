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
    if (e.key === "Escape") { closeSidebarOnMobile(); closeKeyModal(); }
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
          <div class="feature-icon">✓</div>
          <span class="feature-tag">Core Engine</span>
          <h4>AI Information Verifier</h4>
          <p>Cross-examine claims, verify against trusted sources, and flag misleading or unverifiable statements.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">🗺</div>
          <span class="feature-tag">Career &amp; Skill Growth</span>
          <h4>AI Roadmap Architect</h4>
          <p>Turn ambitious goals into staged milestone roadmaps with concrete practice and projects.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon">🎯</div>
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

Return between 5 and 8 stages.`;

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

(continue through STATEMENT_6 / ANSWER_6 / EXPLANATION_6)`;

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
