process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require('dotenv').config();
const express  = require('express');
const fetch    = require('node-fetch');
const cors     = require('cors');
const path     = require('path');
const cron     = require('node-cron');
const nodemailer = require('nodemailer');
const { exec }   = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── ANTHROPIC ERROR HELPER ───────────────────────
function friendlyAIError(apiError) {
  const msg = apiError?.message || JSON.stringify(apiError) || 'Unknown AI error';
  if (msg.includes('credit balance') || msg.includes('billing') || msg.includes('upgrade')) {
    return '💳 Your Anthropic account is out of credits. Go to console.anthropic.com/settings/billing to add credits, then try again.';
  }
  if (msg.includes('invalid x-api-key') || msg.includes('authentication')) {
    return '🔑 Invalid Anthropic API key. Check your config.json and make sure the key is correct.';
  }
  if (msg.includes('overloaded')) {
    return '⏳ The AI is overloaded right now. Wait a moment and try again.';
  }
  return `AI error: ${msg}`;
}

// ─── CONFIG ───────────────────────────────────────
let CANVAS_DOMAIN   = process.env.CANVAS_DOMAIN   || '';
let CANVAS_TOKEN    = process.env.CANVAS_TOKEN    || '';
let STUDENT_NAME    = process.env.STUDENT_NAME    || 'Student';
let PHONE_NUMBER    = process.env.PHONE_NUMBER    || '';
let GMAIL_USER      = process.env.GMAIL_USER      || '';
let GMAIL_APP_PASS  = process.env.GMAIL_APP_PASS  || '';
let SMS_ENABLED     = process.env.SMS_ENABLED === 'true';
let EMAIL_TO        = process.env.EMAIL_TO        || '';   // recipient email for reminders
let EMAIL_ENABLED   = process.env.EMAIL_ENABLED   === 'true';
let RESEND_API_KEY  = process.env.RESEND_API_KEY  || '';
let BREVO_USER      = process.env.BREVO_USER      || '';
let BREVO_SMTP_KEY  = process.env.BREVO_SMTP_KEY  || '';
let NTFY_TOPIC        = process.env.NTFY_TOPIC      || 'studypulse-devan';
let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
// SMS carrier gateway — change if not on T-Mobile:
//   T-Mobile:  tmomail.net
//   Verizon:   vtext.com
//   AT&T:      txt.att.net
//   Sprint:    messaging.sprintpcs.com
let CARRIER_GATEWAY   = process.env.CARRIER_GATEWAY || 'tmomail.net';

// Cached Canvas items for scheduled digests
let cachedCanvasItems = [];

// ─── SET ANTHROPIC KEY ────────────────────────────
app.post('/api/anthropic-config', (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' });
  ANTHROPIC_API_KEY = apiKey.trim();
  saveConfig();
  res.json({ success: true });
});

// ─── SET CREDENTIALS (called from UI) ─────────────
app.post('/api/config', (req, res) => {
  const { domain, token } = req.body;
  if (!domain || !token) return res.status(400).json({ error: 'Missing domain or token' });
  CANVAS_DOMAIN = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  CANVAS_TOKEN  = token;
  saveConfig();
  res.json({ success: true, domain: CANVAS_DOMAIN });
});

app.post('/api/sms-config', (req, res) => {
  const { studentName, phoneNumber, gmailUser, gmailAppPass } = req.body;
  if (!phoneNumber || !gmailUser || !gmailAppPass)
    return res.status(400).json({ error: 'Phone number, Gmail address, and App Password are required.' });
  STUDENT_NAME   = studentName || 'Student';
  PHONE_NUMBER   = phoneNumber.replace(/\D/g, '');
  GMAIL_USER     = gmailUser;
  GMAIL_APP_PASS = gmailAppPass;
  SMS_ENABLED    = true;
  saveConfig();
  console.log(`📱 SMS configured for ${PHONE_NUMBER}@tmomail.net`);
  res.json({ success: true, gateway: `${PHONE_NUMBER}@tmomail.net` });
});

app.post('/api/sms-brevo-config', (req, res) => {
  const { phoneNumber, brevoUser, brevoSmtpKey, studentName } = req.body;
  if (!phoneNumber || !brevoUser || !brevoSmtpKey)
    return res.status(400).json({ error: 'Phone number, Brevo email, and SMTP key are required.' });
  PHONE_NUMBER   = phoneNumber.replace(/\D/g, '');
  BREVO_USER     = brevoUser;
  BREVO_SMTP_KEY = brevoSmtpKey;
  SMS_ENABLED    = true;
  if (studentName) STUDENT_NAME = studentName;
  saveConfig();
  console.log(`📱 SMS via Brevo configured for ${PHONE_NUMBER}@tmomail.net`);
  res.json({ success: true, gateway: `${PHONE_NUMBER}@tmomail.net` });
});

app.get('/api/sms-config/status', (req, res) => {
  res.json({ enabled: SMS_ENABLED, studentName: STUDENT_NAME, hasPhone: !!PHONE_NUMBER, hasGmail: !!GMAIL_USER });
});

app.post('/api/email-config', (req, res) => {
  const { emailTo, studentName, gmailUser, gmailAppPass } = req.body;
  if (!emailTo || !gmailUser || !gmailAppPass)
    return res.status(400).json({ error: 'Recipient email, Gmail address, and App Password are required.' });
  EMAIL_TO       = emailTo;
  GMAIL_USER     = gmailUser;
  GMAIL_APP_PASS = gmailAppPass.replace(/\s/g, '');
  EMAIL_ENABLED  = true;
  if (studentName) STUDENT_NAME = studentName;
  saveConfig();
  console.log(`📧 Email configured — sending to ${EMAIL_TO}`);
  res.json({ success: true, emailTo: EMAIL_TO });
});

app.post('/api/resend-config', (req, res) => {
  const { resendApiKey, emailTo, studentName } = req.body;
  if (!resendApiKey || !emailTo)
    return res.status(400).json({ error: 'Resend API key and recipient email are required.' });
  RESEND_API_KEY = resendApiKey.trim();
  EMAIL_TO       = emailTo;
  EMAIL_ENABLED  = true;
  if (studentName) STUDENT_NAME = studentName;
  saveConfig();
  console.log(`📧 Resend configured — sending to ${EMAIL_TO}`);
  res.json({ success: true, emailTo: EMAIL_TO });
});

app.get('/api/config/status', (req, res) => {
  res.json({
    configured: !!(CANVAS_DOMAIN && CANVAS_TOKEN), domain: CANVAS_DOMAIN,
    sms:   { enabled: SMS_ENABLED,   studentName: STUDENT_NAME, hasPhone: !!PHONE_NUMBER, hasGmail: !!GMAIL_USER },
    email: { enabled: EMAIL_ENABLED, emailTo: EMAIL_TO, studentName: STUDENT_NAME, gmailUser: GMAIL_USER, usingResend: !!RESEND_API_KEY }
  });
});

// ─── CANVAS PROXY HELPER ──────────────────────────
async function canvasFetch(path) {
  if (!CANVAS_DOMAIN || !CANVAS_TOKEN) throw new Error('Canvas not configured');
  const url = `https://${CANVAS_DOMAIN}/api/v1${path}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${CANVAS_TOKEN}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Canvas API error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ─── GET COURSES ──────────────────────────────────
app.get('/api/courses', async (req, res) => {
  try {
    const courses = await canvasFetch('/courses?enrollment_state=active&per_page=50');
    res.json(courses);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET ASSIGNMENTS FOR A COURSE ─────────────────
app.get('/api/courses/:id/assignments', async (req, res) => {
  try {
    const data = await canvasFetch(`/courses/${req.params.id}/assignments?per_page=50&order_by=due_at`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET QUIZZES FOR A COURSE ─────────────────────
app.get('/api/courses/:id/quizzes', async (req, res) => {
  try {
    const data = await canvasFetch(`/courses/${req.params.id}/quizzes?per_page=50`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ALL UPCOMING TESTS & QUIZZES ─────────────────
app.get('/api/upcoming-tests', async (req, res) => {
  try {
    const courses = await canvasFetch('/courses?enrollment_state=active&per_page=50');
    const realCourses = courses.filter(c =>
      c.name && !c.name.includes('Bulletin') && !c.name.includes('Counseling') && !c.name.includes('Investigates')
    ).slice(0, 15);

    const now = new Date();
    const cutoff = new Date(now.getTime() + 60 * 86400000); // 60 days ahead
    const items = [];

    await Promise.all(realCourses.map(async course => {
      try {
        const assignments = await canvasFetch(`/courses/${course.id}/assignments?per_page=50&order_by=due_at`);
        for (const a of assignments) {
          if (!a.due_at) continue;
          const due = new Date(a.due_at);
          if (due < now || due > cutoff) continue;
          const isTest = /quiz|test|exam|midterm|final|assessment/i.test(a.name + ' ' + (a.submission_types||[]).join(' '));
          items.push({
            id: `a-${a.id}`,
            title: a.name,
            course: course.name,
            courseId: course.id,
            type: a.is_quiz_assignment ? 'quiz' : (isTest ? 'test' : 'assignment'),
            due: a.due_at,
            points: a.points_possible,
            description: a.description || '',
            isTest
          });
        }
      } catch(e) {}

      try {
        const quizzes = await canvasFetch(`/courses/${course.id}/quizzes?per_page=50`);
        for (const q of quizzes) {
          if (!q.due_at) continue;
          const due = new Date(q.due_at);
          if (due < now || due > cutoff) continue;
          if (!items.find(i => i.title === q.title && i.courseId === course.id)) {
            items.push({
              id: `q-${q.id}`,
              title: q.title,
              course: course.name,
              courseId: course.id,
              type: 'quiz',
              due: q.due_at,
              points: q.points_possible,
              description: q.description || '',
              isTest: true
            });
          }
        }
      } catch(e) {}
    }));

    // Only keep actual quizzes/tests, filter out plain homework
    const testsOnly = items.filter(i => i.isTest || i.type === 'quiz' || /quiz|test|exam|midterm|final|assessment/i.test(i.title));
    const sorted = (testsOnly.length ? testsOnly : items).sort((a, b) => new Date(a.due) - new Date(b.due));

    // Always prepend a demo quiz so the feature can be tested
    const demo = {
      id: 'demo',
      title: '📝 Demo Quiz — Try Me!',
      course: 'StudyPulse Demo',
      courseId: 'demo',
      type: 'quiz',
      due: new Date(Date.now() + 2 * 86400000).toISOString(),
      points: 50,
      description: 'This is a demo quiz about the American Revolution for testing the study guide feature.',
      isTest: true,
      isDemo: true
    };
    res.json([demo, ...sorted]);
  } catch(e) {
    // Even if Canvas fails, return the demo so the page isn't empty
    const demo = {
      id: 'demo',
      title: '📝 Demo Quiz — Try Me!',
      course: 'StudyPulse Demo',
      courseId: 'demo',
      type: 'quiz',
      due: new Date(Date.now() + 2 * 86400000).toISOString(),
      points: 50,
      description: 'Demo quiz about the American Revolution.',
      isTest: true,
      isDemo: true
    };
    res.json([demo]);
  }
});

// ─── TOPIC SEARCH STUDY GUIDE ─────────────────────
app.post('/api/topic-guide', async (req, res) => {
  const { courseId, courseName, topic } = req.body;
  if (!courseId || !topic) return res.status(400).json({ error: 'courseId and topic required' });

  const ANTHROPIC_KEY = ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(400).json({ error: 'Anthropic API key not set.' });

  try {
    const topicLower = topic.toLowerCase();
    const sections = [];
    const visited = new Set();

    // Helper: score how relevant a piece of text is to the topic
    function relevanceScore(text) {
      const words = topicLower.split(/\s+/);
      let score = 0;
      words.forEach(w => { if (w.length > 2 && text.toLowerCase().includes(w)) score++; });
      return score;
    }

    async function tryFetchPage(slug, label) {
      if (visited.has(slug)) return;
      visited.add(slug);
      try {
        const page = await canvasFetch(`/courses/${courseId}/pages/${slug}`);
        const raw = page.body || '';
        const text = stripHtml(raw);
        if (text.length < 30) return;
        const score = relevanceScore(text);
        sections.push({ label, title: page.title || slug, text: text.slice(0, 5000), score });
        // Follow internal links from this page too
        const linked = extractCanvasPageLinks(raw, courseId);
        for (const ls of linked.slice(0, 8)) await tryFetchPage(ls, label + ' → linked');
      } catch(e) {}
    }

    // 1. Scan all modules
    let modules = [];
    try { modules = await canvasFetch(`/courses/${courseId}/modules?per_page=50&include[]=items`); } catch(e) {}
    for (const mod of modules.slice(0, 20)) {
      let items = mod.items || [];
      if (!items.length) {
        try { items = await canvasFetch(`/courses/${courseId}/modules/${mod.id}/items?per_page=50`); } catch(e) {}
      }
      for (const item of items.slice(0, 30)) {
        if (item.type === 'Page' && item.page_url) {
          await tryFetchPage(item.page_url, mod.name);
        } else if (item.type === 'Assignment' && item.content_id) {
          try {
            const a = await canvasFetch(`/courses/${courseId}/assignments/${item.content_id}`);
            const text = stripHtml(a.description || '');
            if (text.length > 30) {
              const score = relevanceScore(text);
              sections.push({ label: mod.name, title: a.name, text: text.slice(0, 3000), score, type: 'assignment' });
              const linked = extractCanvasPageLinks(a.description || '', courseId);
              for (const ls of linked.slice(0, 5)) await tryFetchPage(ls, mod.name + ' → assignment');
            }
          } catch(e) {}
        }
      }
    }

    // 2. Scan all pages, score by relevance
    try {
      const pages = await canvasFetch(`/courses/${courseId}/pages?per_page=50&sort=updated_at`);
      for (const pg of pages.slice(0, 30)) await tryFetchPage(pg.url, 'Course Pages');
    } catch(e) {}

    // 3. Sort by relevance, take top sections
    sections.sort((a, b) => b.score - a.score);
    const topSections = sections.filter(s => s.score > 0).slice(0, 20);
    const fallback = sections.slice(0, 10); // use everything if nothing matches
    const useSections = topSections.length >= 2 ? topSections : fallback;

    if (!useSections.length) {
      return res.json({ guide: `## No content found for "${topic}"\n\nNo matching notes or pages were found in ${courseName}. Try a broader topic name.`, sections: 0 });
    }

    let context = useSections.map(s => `### [${s.label}] ${s.title}\n${s.text}`).join('\n\n---\n\n');
    if (context.length > 55000) context = context.slice(0, 55000) + '\n\n[...truncated...]';

    const prompt = `You are building a focused study guide for a student in **${courseName}** on the topic: **"${topic}"**.

The content below was pulled directly from their teacher's Canvas pages, notes, and modules — filtered for relevance to this topic.

Create a thorough, well-organized study guide in Markdown that covers everything a student needs to know about **${topic}** based on THIS teacher's specific notes and materials. Include:

## 📌 What You Need to Know About ${topic}
Core concepts, definitions, and key ideas from the teacher's notes.

## 📖 Detailed Notes
Expand on each sub-topic with detail from the source material. Use bullet points and bold key terms.

## 🧠 Must Memorize
Facts, formulas, dates, names, vocab — anything they need cold.

## ✏️ Practice Problems & Questions
Generate 8-10 practice questions (mix of multiple choice, short answer, problem-solving) based specifically on what the teacher covered. Include full answers.

## 💡 Study Tips for This Topic
Specific advice based on the type of material (formulas? vocab? timelines? essays?).

## ⚠️ Common Mistakes
What students typically get wrong on this topic.

Be thorough and specific — use the actual content from the teacher's notes, not generic information.

--- TEACHER'S CANVAS CONTENT ---
${context}
--- END ---`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 5000, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await r.json();
    const guide = data.content?.map(b => b.text || '').join('') || 'Could not generate guide.';
    res.json({ guide, sections: useSections.length, matched: topSections.length });
  } catch(e) {
    console.error('topic-guide error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sync-status', (req, res) => {
  res.json({ items: cachedCanvasItems, lastSync: cachedCanvasItems.length ? new Date().toLocaleTimeString() : null });
});

// ─── FULL SYNC (all courses + items) ──────────────
app.get('/api/sync', async (req, res) => {
  try {
    const courses = await canvasFetch('/courses?enrollment_state=active&per_page=50');
    const now = new Date();
    const cutoff = new Date(now.getTime() - 7 * 86400000); // ignore items >7 days past due
    const items = [];

    for (const course of courses.slice(0, 15)) {
      // Assignments
      try {
        const assignments = await canvasFetch(`/courses/${course.id}/assignments?per_page=50&order_by=due_at`);
        for (const a of assignments) {
          if (!a.due_at) continue;
          const due = new Date(a.due_at);
          if (due < cutoff) continue;
          items.push({
            id: `a-${a.id}`,
            title: a.name,
            course: course.name,
            courseId: course.id,
            type: a.is_quiz_assignment ? 'quiz' : 'assignment',
            due: a.due_at,
            points: a.points_possible,
            htmlUrl: a.html_url,
          });
        }
      } catch (e) { /* skip course on error */ }

      // Quizzes
      try {
        const quizzes = await canvasFetch(`/courses/${course.id}/quizzes?per_page=50`);
        for (const q of quizzes) {
          if (!q.due_at) continue;
          const due = new Date(q.due_at);
          if (due < cutoff) continue;
          items.push({
            id: `q-${q.id}`,
            title: q.title,
            course: course.name,
            courseId: course.id,
            type: 'quiz',
            due: q.due_at,
            points: q.points_possible,
            htmlUrl: q.html_url,
          });
        }
      } catch (e) { /* skip */ }
    }

    items.sort((a, b) => new Date(a.due) - new Date(b.due));
    cachedCanvasItems = items; // cache for scheduled digests
    res.json({ courses: courses.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── MANUAL ASSIGNMENTS (PowerSchool / Paper) ─────
const fs = require('fs');
const MANUAL_FILE  = path.join(__dirname, 'manual_assignments.json');
const CONFIG_FILE  = path.join(__dirname, 'config.json');

// ─── PERSIST & LOAD CONFIG ────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig() {
  const cfg = { CANVAS_DOMAIN, CANVAS_TOKEN, STUDENT_NAME, PHONE_NUMBER, GMAIL_USER, GMAIL_APP_PASS, SMS_ENABLED, EMAIL_TO, EMAIL_ENABLED, RESEND_API_KEY, BREVO_USER, BREVO_SMTP_KEY, NTFY_TOPIC, ANTHROPIC_API_KEY, CARRIER_GATEWAY };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  console.log('💾 Config saved to config.json');
}

// Load saved config on startup (overrides .env if present)
const savedCfg = loadConfig();
if (savedCfg.CANVAS_DOMAIN)  CANVAS_DOMAIN  = savedCfg.CANVAS_DOMAIN;
if (savedCfg.CANVAS_TOKEN)   CANVAS_TOKEN   = savedCfg.CANVAS_TOKEN;
if (savedCfg.STUDENT_NAME)   STUDENT_NAME   = savedCfg.STUDENT_NAME;
if (savedCfg.PHONE_NUMBER)   PHONE_NUMBER   = savedCfg.PHONE_NUMBER;
if (savedCfg.GMAIL_USER)     GMAIL_USER     = savedCfg.GMAIL_USER;
if (savedCfg.GMAIL_APP_PASS) GMAIL_APP_PASS = savedCfg.GMAIL_APP_PASS;
if (savedCfg.SMS_ENABLED)    SMS_ENABLED    = savedCfg.SMS_ENABLED;
if (savedCfg.EMAIL_TO)       EMAIL_TO       = savedCfg.EMAIL_TO;
if (savedCfg.EMAIL_ENABLED)  EMAIL_ENABLED  = savedCfg.EMAIL_ENABLED;
if (savedCfg.RESEND_API_KEY) RESEND_API_KEY = savedCfg.RESEND_API_KEY;
if (savedCfg.BREVO_USER)     BREVO_USER     = savedCfg.BREVO_USER;
if (savedCfg.BREVO_SMTP_KEY) BREVO_SMTP_KEY = savedCfg.BREVO_SMTP_KEY;
if (savedCfg.NTFY_TOPIC)        NTFY_TOPIC        = savedCfg.NTFY_TOPIC;
if (savedCfg.ANTHROPIC_API_KEY) ANTHROPIC_API_KEY = savedCfg.ANTHROPIC_API_KEY;
if (savedCfg.CARRIER_GATEWAY)   CARRIER_GATEWAY   = savedCfg.CARRIER_GATEWAY;

function loadManual() {
  try { return JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8')); } catch { return []; }
}
function saveManual(items) {
  fs.writeFileSync(MANUAL_FILE, JSON.stringify(items, null, 2));
}

app.get('/api/manual', (req, res) => {
  res.json(loadManual());
});

app.post('/api/manual', (req, res) => {
  const { title, course, type, due, points, notes, missing } = req.body;
  if (!title || !due) return res.status(400).json({ error: 'Title and due date are required' });
  const items = loadManual();
  const item = {
    id: `m-${Date.now()}`,
    title, course: course || 'Other', type: type || 'homework',
    due, points: points || null, notes: notes || '',
    missing: !!missing, source: 'manual',
    createdAt: new Date().toISOString()
  };
  items.push(item);
  saveManual(items);
  res.json(item);
});

app.put('/api/manual/:id', (req, res) => {
  const items = loadManual();
  const idx = items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  items[idx] = { ...items[idx], ...req.body, id: req.params.id };
  saveManual(items);
  res.json(items[idx]);
});

app.delete('/api/manual/:id', (req, res) => {
  const items = loadManual();
  const filtered = items.filter(i => i.id !== req.params.id);
  saveManual(filtered);
  res.json({ success: true });
});

// ─── VOICE ASSIGNMENT PARSING ─────────────────────
app.post('/api/parse-voice', async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: 'No transcript provided' });

  const now = new Date();
  const today = now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });

  const ANTHROPIC_KEY = ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    // Fallback: basic parse without AI
    return res.json({ title: transcript, course: '', type: 'homework', due: new Date(Date.now()+86400000).toISOString().slice(0,16), points: null, notes: '' });
  }

  try {
    const prompt = `Today is ${today}. A student just said this to describe an assignment they need to add:

"${transcript}"

Extract the assignment details and return ONLY valid JSON with these fields:
{
  "title": "assignment title (concise, 3-8 words)",
  "course": "subject or course name (e.g. Math, AP English, Biology)",
  "type": "one of: homework, assignment, test, quiz, project",
  "due": "ISO datetime string (YYYY-MM-DDTHH:MM) - if they said 'Friday' calculate from today, if no time mentioned use 23:59",
  "points": number or null,
  "notes": "any extra details they mentioned, or empty string"
}

Rules:
- Infer the course from context if not explicitly stated
- If no due date mentioned, default to tomorrow at 23:59
- Return ONLY the JSON object, no other text`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role:'user', content: prompt }] })
    });
    const data = await r.json();
    const text = data.content?.map(b => b.text||'').join('') || '{}';
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    res.json(parsed);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── STUDY GUIDE GENERATOR ────────────────────────
// Extract Canvas internal page URLs from HTML (handles /courses/ID/pages/slug links)
function extractCanvasPageLinks(html, courseId) {
  const links = [];
  const re = /href="[^"]*\/courses\/\d+\/pages\/([^"?#]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = decodeURIComponent(m[1]);
    if (!links.includes(slug)) links.push(slug);
  }
  return links;
}

// Extract file download links from Canvas HTML
function extractCanvasFileLinks(html) {
  const links = [];
  const re = /href="[^"]*\/files\/(\d+)[^"]*"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!links.includes(m[1])) links.push(m[1]);
  }
  return links;
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

app.post('/api/study-guide', async (req, res) => {
  const { courseId, courseName, focusTopic, quizTitle, quizDescription, quizDue } = req.body;
  if (!courseId) return res.status(400).json({ error: 'courseId required' });

  const ANTHROPIC_KEY = ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(400).json({ error: 'Anthropic API key not configured.' });

  // ── DEMO MODE ──────────────────────────────────────
  if (courseId === 'demo') {
    const demoContent = `The American Revolution (1765–1783) was the political upheaval during which the Thirteen Colonies broke from Britain and became the United States. Key causes included taxation without representation (Stamp Act, Townshend Acts, Tea Act), Enlightenment ideas about natural rights (John Locke), and colonial assemblies wanting self-governance. Key events: Boston Massacre (1770), Boston Tea Party (1773), Lexington & Concord (1775), Declaration of Independence (July 4, 1776), Battle of Saratoga (1777 — turning point, brought France as ally), Valley Forge (1777-78 — Washington's winter camp), Battle of Yorktown (1781 — Cornwallis surrenders). Key people: George Washington (Commander-in-Chief), Thomas Jefferson (wrote Declaration), Benjamin Franklin (diplomat, secured French alliance), Paul Revere (midnight ride), King George III (British king), Lord Cornwallis (British general). The Declaration of Independence states all men are created equal with rights to life, liberty, and the pursuit of happiness — based on Locke's natural rights theory. The Treaty of Paris (1783) officially ended the war.`;
    const prompt = `Create a comprehensive study guide for a quiz on the American Revolution. Use this content:\n\n${demoContent}\n\nInclude: key concepts, timeline, important people, practice questions with answers, memory tricks, and common mistakes. Use markdown with clear headers.`;
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
      });
      const data = await r.json();
      if (data.error) {
        console.error('Anthropic demo error:', JSON.stringify(data.error));
        return res.status(500).json({ error: friendlyAIError(data.error) });
      }
      const guide = data.content?.map(b => b.text || '').join('') || 'Could not generate demo.';
      return res.json({ guide, sections: 1, topics: ['American Revolution'] });
    } catch(demoErr) {
      console.error('Demo study guide fetch error:', demoErr);
      return res.status(500).json({ error: demoErr.message });
    }
  }

  try {
    const sections = [];
    const visitedPageSlugs = new Set();

    async function fetchPage(slug, moduleLabel, titleOverride) {
      if (visitedPageSlugs.has(slug)) return;
      visitedPageSlugs.add(slug);
      try {
        const page = await canvasFetch(`/courses/${courseId}/pages/${slug}`);
        const rawHtml = page.body || '';
        const text = stripHtml(rawHtml);
        if (text.length > 40) {
          sections.push({ module: moduleLabel, title: titleOverride || page.title || slug, type: 'page', text: text.slice(0, 5000) });
        }
        // Follow internal Canvas page links (table of contents, linked notes, worksheets)
        const linkedSlugs = extractCanvasPageLinks(rawHtml, courseId);
        for (const ls of linkedSlugs.slice(0, 10)) {
          await fetchPage(ls, moduleLabel + ' → linked', null);
        }
      } catch(e) {}
    }

    // 1. Fetch modules
    let modules = [];
    try { modules = await canvasFetch(`/courses/${courseId}/modules?per_page=50&include[]=items`); } catch(e) {}

    // 2. Walk each module and pull page / assignment content
    for (const mod of modules.slice(0, 20)) {
      let items = mod.items || [];
      if (!items.length) {
        try { items = await canvasFetch(`/courses/${courseId}/modules/${mod.id}/items?per_page=50`); } catch(e) {}
      }
      for (const item of items.slice(0, 30)) {
        if (item.type === 'Page' && item.page_url) {
          await fetchPage(item.page_url, mod.name, item.title);
        } else if (item.type === 'Assignment' && item.content_id) {
          try {
            const asgn = await canvasFetch(`/courses/${courseId}/assignments/${item.content_id}`);
            const rawHtml = asgn.description || '';
            const text = stripHtml(rawHtml);
            if (text.length > 40) {
              sections.push({ module: mod.name, title: item.title, type: 'assignment', text: text.slice(0, 2000) });
            }
            // Follow any page links in assignment descriptions
            const linkedSlugs = extractCanvasPageLinks(rawHtml, courseId);
            for (const ls of linkedSlugs.slice(0, 5)) {
              await fetchPage(ls, mod.name + ' → assignment link', null);
            }
          } catch(e) {}
        } else if (item.type === 'Discussion' && item.content_id) {
          try {
            const disc = await canvasFetch(`/courses/${courseId}/discussion_topics/${item.content_id}`);
            const text = stripHtml(disc.message);
            if (text.length > 40) {
              sections.push({ module: mod.name, title: item.title, type: 'discussion', text: text.slice(0, 1500) });
            }
          } catch(e) {}
        } else if (item.type === 'ExternalUrl' && item.external_url) {
          // Record external links (worksheets, Google Docs, etc.) as references
          sections.push({ module: mod.name, title: item.title, type: 'external', text: `External resource: ${item.external_url}` });
        }
      }
    }

    // 3. Also fetch standalone pages (not in modules)
    try {
      const pages = await canvasFetch(`/courses/${courseId}/pages?per_page=30&sort=updated_at&order=desc`);
      for (const pg of pages.slice(0, 15)) {
        await fetchPage(pg.url, 'Course Pages', pg.title);
      }
    } catch(e) {}

    if (sections.length === 0) {
      return res.json({ guide: '## No content found\n\nThis course has no accessible pages or modules in Canvas. Make sure your Canvas token has permission to read course content.', sections: 0 });
    }

    // 4. Build context string (cap at ~60k chars to stay within Claude context)
    let context = sections.map(s =>
      `### [${s.module}] ${s.title} (${s.type})\n${s.text}`
    ).join('\n\n---\n\n');
    if (context.length > 60000) context = context.slice(0, 60000) + '\n\n[... additional content truncated ...]';

    // Build focus context — quiz takes priority over free-text topic
    let focusLine = '';
    if (quizTitle) {
      const dueStr = quizDue ? `Due: ${new Date(quizDue).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}` : '';
      focusLine = `\n⚠️ The student has an upcoming quiz/test: **"${quizTitle}"** ${dueStr}. Build the study guide SPECIFICALLY for this quiz/test. Focus all key concepts, practice questions, and tips on what is likely to be tested. ${quizDescription ? `\nQuiz/Assignment description: ${stripHtml(quizDescription).slice(0,500)}` : ''}\n`;
    } else if (focusTopic) {
      focusLine = `\nThe student wants to focus especially on: **${focusTopic}**. Emphasize this topic throughout the guide.\n`;
    }

    const prompt = `You are an expert tutor creating a comprehensive study guide for a student in ${courseName}.
${focusLine}
Below is all the content pulled from their Canvas course — modules, pages, notes, assignment descriptions, and linked worksheets/resources. Some sections are labeled "→ linked" meaning they were found by following links inside other pages (like table of contents, study guides, or extra worksheets).

Your job: synthesize ALL of this into a **single, well-organized study guide** in Markdown. Structure it by UNIT/MODULE if there are clearly distinct units. Include:

## 📋 Table of Contents
List every major topic/unit covered.

## 📌 Key Concepts by Unit
For each unit/module, list the core concepts, definitions, and vocabulary in bullet form. Bold every key term.

## 📖 Unit Summaries
A 3-5 sentence plain-language summary of each major topic.

## 🧠 Must Know Cold
Facts, formulas, dates, vocab, names — anything they need to have memorized. Use tables where helpful.

## ✏️ Practice Questions
10+ questions mixing multiple choice, short answer, and problem-solving — pulled directly from the material. Include full answers at the end.

## 📝 Extra Practice & Worksheets
List any linked worksheets, extra practice resources, or external materials that were found in the course, with what they cover.

## 💡 How to Study This
Specific study strategies based on what types of content appeared (essays? formulas? timelines? vocab?).

## ⚠️ Common Mistakes
Tricky areas, common errors, things the teacher likely emphasizes.

Use clear headers, bold key terms, and tables where it helps. Write for a high school or college student. Be thorough.

--- CANVAS CONTENT START ---
${context}
--- CANVAS CONTENT END ---`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 6000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    if (data.error) {
      console.error('Anthropic API error (study guide):', JSON.stringify(data.error));
      return res.status(500).json({ error: friendlyAIError(data.error) });
    }
    const guide = data.content?.map(b => b.text || '').join('') || 'Could not generate study guide.';
    res.json({ guide, sections: sections.length, topics: [...new Set(sections.map(s => s.module))] });
  } catch(e) {
    console.error('Study guide error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── AI TUTOR (study guide follow-up) ────────────
app.post('/api/study-tutor', async (req, res) => {
  const { message, guideContext, courseName, history } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });

  const ANTHROPIC_KEY = ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(400).json({ error: 'Anthropic API key not configured.' });

  try {
    const systemPrompt = `You are a friendly, expert AI tutor helping a student study for ${courseName || 'their course'}.

You have access to all of their Canvas course material — it has already been compiled into a study guide shown below. Use it as your primary source of truth when answering.

When the student asks for:
- **Practice problems** → generate 5-10 relevant problems with full worked solutions
- **Step-by-step explanation** → break it down simply, use numbered steps, examples
- **Flashcard notes / memorization** → format as TERM: definition, one per line, easy to read
- **Memory tricks** → create mnemonics, acronyms, stories, or visual associations
- **Simpler explanation** → use plain everyday language and real-world analogies
- **Exam questions** → write realistic questions at the right difficulty level with model answers

Keep responses clear, structured, and student-friendly. Use markdown formatting (bold, bullets, numbered lists). Be encouraging.

--- COURSE STUDY GUIDE (your knowledge base) ---
${(guideContext || '').slice(0, 40000)}
--- END OF STUDY GUIDE ---`;

    // Build message history for multi-turn chat
    const messages = [];
    if (Array.isArray(history)) {
      for (const turn of history.slice(-8)) { // keep last 8 turns for context
        messages.push({ role: turn.role, content: turn.content });
      }
    }
    messages.push({ role: 'user', content: message });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages
      })
    });
    const data = await r.json();
    const reply = data.content?.map(b => b.text || '').join('') || 'Sorry, I could not generate a response.';
    res.json({ reply });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI EMAIL DRAFTER ─────────────────────────────
app.post('/api/draft-email', async (req, res) => {
  const { topic, reason, assignmentName, studentName, studentEmail, teacherEmail, teacherName, extraContext } = req.body;
  if (!topic) return res.status(400).json({ error: 'topic required' });

  const ANTHROPIC_KEY = ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(400).json({ error: 'Anthropic API key not configured.' });

  const name = studentName || STUDENT_NAME || 'the student';

  const topicDescriptions = {
    absence:      'The student was absent and wants to let the teacher know and ask what they missed.',
    missing_work: 'The student has missing work and wants to apologize and ask about making it up.',
    extension:    'The student needs more time on an assignment and is requesting a deadline extension.',
    grade:        'The student wants to ask about a grade or quiz score they received.',
    help:         'The student needs help understanding class material and wants to set up extra help.',
    late_work:    'The student is submitting late work and wants to explain why and ask if it will be accepted.',
    custom:       reason || 'The student has something to communicate to the teacher.'
  };

  const desc = topicDescriptions[topic] || topicDescriptions.custom;

  const prompt = `Write a professional, polite, and concise email from a student to their teacher.

Student name: ${name}
Teacher name: ${teacherName || 'the teacher'}
Assignment (if relevant): ${assignmentName || 'N/A'}
Situation: ${desc}
Extra context: ${extraContext || 'none'}

Requirements:
- Write the COMPLETE email including Subject line, greeting, body, and sign-off
- Sound like a real middle/high school student — polite but natural, not overly formal
- Be specific if an assignment name was provided
- Keep it concise (3-5 sentences in the body max)
- Include a clear subject line
- Sign off with the student's name

Format exactly like this:
Subject: [subject line]

[greeting],

[body]

[sign-off],
${name}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await r.json();
    const draft = data.content?.map(b => b.text || '').join('') || '';

    // Parse subject line out of draft
    const subjectMatch = draft.match(/^Subject:\s*(.+)$/m);
    const subject = subjectMatch ? subjectMatch[1].trim() : 'Message from student';
    const body = draft.replace(/^Subject:.*$/m, '').trim();

    res.json({ draft, subject, body, studentEmail, teacherEmail });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI REMINDER GENERATION ───────────────────────
app.post('/api/generate-reminder', async (req, res) => {
  const { item, studentName, target, context } = req.body;
  if (!item) return res.status(400).json({ error: 'Missing item' });

  const ANTHROPIC_KEY = ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    // Fallback reminder without AI
    const fallback = generateFallbackReminder(item, studentName || 'Student', target || 'Student');
    return res.json({ message: fallback });
  }

  const due = new Date(item.due);
  const now = new Date();
  const hoursLeft = Math.max(0, Math.round((due - now) / 3600000));
  const daysLeft  = Math.max(0, Math.round((due - now) / 86400000));
  const dueStr    = daysLeft === 0 ? `in ${hoursLeft} hours` : `in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;

  const prompt = `You are a helpful academic reminder assistant for students and parents.

Write a SHORT personalized reminder message:
- Student: ${studentName || 'the student'}
- Task: "${item.title}"
- Course: ${item.course}
- Type: ${item.type}
- Due: ${dueStr} (${due.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })})
- Points: ${item.points || 'unspecified'}
- Send to: ${target || 'Student'}
${context ? `- Extra context: ${context}` : ''}

Rules:
- If sending to Parent: address the parent, mention the student by name
- If sending to Student: address them directly, be motivating
- If sending to Both: write one combined message covering both
- Keep it 2-4 sentences, warm, and actionable
- For items due in < 24 hours, be more urgent
- Include a quick tip if helpful
- Plain text only, no markdown`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await aiRes.json();
    const message = data.content?.map(b => b.text || '').join('') || generateFallbackReminder(item, studentName, target);
    res.json({ message });
  } catch (e) {
    res.json({ message: generateFallbackReminder(item, studentName || 'Student', target || 'Student') });
  }
});

function generateFallbackReminder(item, studentName, target) {
  const due = new Date(item.due);
  const daysLeft = Math.max(0, Math.round((due - new Date()) / 86400000));
  const dueStr = daysLeft === 0 ? 'today' : `in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;
  if (target === 'Parent') {
    return `Hi! Just a reminder that ${studentName} has "${item.title}" for ${item.course} due ${dueStr}. Please check in to make sure they're on track!`;
  }
  return `Hey ${studentName}! Don't forget — "${item.title}" for ${item.course} is due ${dueStr}. Stay on top of it! 📚`;
}

// ─── EMAIL ENGINE ─────────────────────────────────
async function sendEmail(subject, htmlBody) {
  if (!EMAIL_ENABLED || !EMAIL_TO) {
    console.log('📭 Email not configured — skipping.');
    return { success: false, reason: 'Email not configured' };
  }

  // ── Resend (preferred) ──────────────────────────
  if (RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'StudyPulse <onboarding@resend.dev>', to: EMAIL_TO, subject, html: htmlBody })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || JSON.stringify(data));
      console.log(`✅ Email sent via Resend to ${EMAIL_TO} — "${subject}"`);
      return { success: true };
    } catch (e) {
      console.error('❌ Resend failed:', e.message);
      return { success: false, reason: e.message };
    }
  }

  // ── Gmail SMTP fallback ─────────────────────────
  if (!GMAIL_USER || !GMAIL_APP_PASS) {
    return { success: false, reason: 'Email not configured — add a Resend API key or Gmail App Password.' };
  }
  try {
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false,
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS },
      tls: { rejectUnauthorized: false }
    });
    await transport.sendMail({ from: `"StudyPulse 📡" <${GMAIL_USER}>`, to: EMAIL_TO, subject, html: htmlBody });
    console.log(`✅ Email sent via Gmail to ${EMAIL_TO} — "${subject}"`);
    return { success: true };
  } catch (e) {
    console.error('❌ Gmail failed:', e.message);
    return { success: false, reason: e.message };
  }
}

function urgencyColor(item) {
  const diff = new Date(item.due) - new Date();
  if (item.missing) return '#f87171';
  if (diff < 0) return '#6b7a9d';
  if (diff < 86400000) return '#f87171';
  if (diff < 3 * 86400000) return '#fbbf24';
  return '#4f7dff';
}
function urgencyLabel(item) {
  const diff = new Date(item.due) - new Date();
  if (item.missing) return '⚠️ Missing';
  if (diff < 0) return 'Past Due';
  if (diff < 86400000) return '🔴 Due Today';
  if (diff < 3 * 86400000) return '🟡 Due Soon';
  return '🔵 Upcoming';
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
}
function daysLeft(iso) {
  const d = Math.ceil((new Date(iso) - new Date()) / 86400000);
  if (d <= 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  return `${d} days`;
}

function emailBase(title, preheader, bodyContent) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:20px;">
  <!-- Header -->
  <div style="background:linear-gradient(135deg,#1a2035,#1e2a4a);border-radius:16px 16px 0 0;padding:28px 32px;border-bottom:2px solid #4f7dff;">
    <div style="display:flex;align-items:center;gap:12px;">
      <span style="font-size:24px;">📡</span>
      <div>
        <div style="font-size:20px;font-weight:800;color:#e8ecf4;letter-spacing:-0.5px;">StudyPulse</div>
        <div style="font-size:11px;color:#6b7a9d;letter-spacing:2px;text-transform:uppercase;margin-top:2px;">${title}</div>
      </div>
    </div>
  </div>
  <!-- Body -->
  <div style="background:#111520;border-radius:0 0 16px 16px;padding:28px 32px;border:1px solid #1e2640;border-top:none;">
    ${bodyContent}
  </div>
  <!-- Footer -->
  <div style="text-align:center;padding:16px;font-size:11px;color:#3d4a6b;">
    StudyPulse · Automated by your local server · ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}
  </div>
</div>
</body></html>`;
}

function itemRow(item) {
  const color = urgencyColor(item);
  const label = urgencyLabel(item);
  const dl    = daysLeft(item.due);
  return `
  <tr>
    <td style="padding:12px 0;border-bottom:1px solid #1e2640;">
      <div style="display:flex;align-items:flex-start;gap:12px;">
        <div style="width:3px;min-height:40px;background:${color};border-radius:2px;flex-shrink:0;margin-top:2px;"></div>
        <div style="flex:1;">
          <div style="font-size:14px;font-weight:600;color:#e8ecf4;margin-bottom:3px;">${item.title}</div>
          <div style="font-size:12px;color:#6b7a9d;">${item.course}
            <span style="background:${color}22;color:${color};font-size:10px;font-weight:700;padding:1px 7px;border-radius:4px;margin-left:6px;letter-spacing:0.5px;text-transform:uppercase;">${item.type}</span>
            ${item.source === 'manual' ? '<span style="background:#34d39922;color:#34d399;font-size:10px;font-weight:700;padding:1px 7px;border-radius:4px;margin-left:4px;">PAPER</span>' : ''}
          </div>
          ${item.notes ? `<div style="font-size:11px;color:#6b7a9d;margin-top:3px;font-style:italic;">📎 ${item.notes}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:12px;font-weight:700;color:${color};">${label}</div>
          <div style="font-size:11px;color:#6b7a9d;margin-top:2px;">${dl}</div>
          ${item.points ? `<div style="font-size:10px;color:#3d4a6b;margin-top:1px;">${item.points} pts</div>` : ''}
        </div>
      </div>
    </td>
  </tr>`;
}

function sectionBlock(emoji, title, color, items) {
  if (!items.length) return '';
  return `
  <div style="margin-bottom:24px;">
    <div style="font-size:11px;font-weight:700;color:${color};letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #1e2640;">
      ${emoji} ${title} (${items.length})
    </div>
    <table style="width:100%;border-collapse:collapse;">
      ${items.map(itemRow).join('')}
    </table>
  </div>`;
}

async function buildDailyEmail(timeOfDay) {
  const all    = buildAllItems();
  const now    = new Date();
  const today  = new Date(now); today.setHours(23,59,59,0);
  const urgent = all.filter(i => { const d=new Date(i.due)-now; return !i.missing&&d>0&&d<86400000; });
  const soon   = all.filter(i => { const d=new Date(i.due)-now; return !i.missing&&d>=86400000&&d<3*86400000; });
  const missing = all.filter(i => i.missing);

  const greeting = timeOfDay === 'morning'
    ? `☀️ Good morning, <strong style="color:#e8ecf4">${STUDENT_NAME}</strong>! Here's what needs your attention today.`
    : `🌙 Evening check-in, <strong style="color:#e8ecf4">${STUDENT_NAME}</strong>. Here's what's urgent before tomorrow.`;

  const ANTHROPIC_KEY = ANTHROPIC_API_KEY;
  let aiNote = '';
  if (ANTHROPIC_KEY && (urgent.length || soon.length)) {
    try {
      const itemList = [...urgent, ...soon].slice(0,5).map(i=>`- ${i.title} (${i.course}, due ${daysLeft(i.due)})`).join('\n');
      const prompt = `You are StudyPulse, a supportive academic coach. Write ONE short motivational paragraph (2-3 sentences max) personalized for ${STUDENT_NAME} based on their upcoming work:\n${itemList}\n\nBe warm, specific, and encouraging. Plain text, no markdown, no emojis.`;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST', headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:150, messages:[{role:'user',content:prompt}] })
      });
      const d = await r.json();
      const txt = d.content?.map(b=>b.text||'').join('');
      if (txt) aiNote = `<div style="background:#1a2035;border-left:3px solid #a78bfa;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:24px;font-size:13px;color:#c4b5fd;line-height:1.6;">${txt}</div>`;
    } catch {}
  }

  const body = `
    <p style="font-size:15px;color:#9ca8c4;line-height:1.6;margin-bottom:20px;">${greeting}</p>
    ${aiNote}
    ${sectionBlock('🔴','Due Today','#f87171', urgent)}
    ${sectionBlock('🟡','Due in 1–3 Days','#fbbf24', soon)}
    ${sectionBlock('⚠️','Missing Work','#f87171', missing)}
    ${(!urgent.length && !soon.length && !missing.length)
      ? `<div style="text-align:center;padding:32px;color:#34d399;font-size:15px;">✅ Nothing urgent right now — you're all caught up!</div>`
      : ''}
  `;

  const subject = timeOfDay === 'morning'
    ? `☀️ StudyPulse Morning — ${urgent.length} urgent, ${soon.length} due soon`
    : `🌙 StudyPulse Evening — ${urgent.length} urgent item${urgent.length !== 1 ? 's' : ''}`;

  return { subject, html: emailBase(timeOfDay === 'morning' ? 'Morning Briefing' : 'Evening Check-in', subject, body) };
}

async function buildWeeklyEmail() {
  const all     = buildAllItems();
  const now     = new Date();
  const week    = new Date(now.getTime() + 7*86400000);
  const urgent  = all.filter(i => { const d=new Date(i.due)-now; return !i.missing&&d>0&&d<86400000; });
  const soon    = all.filter(i => { const d=new Date(i.due)-now; return !i.missing&&d>=86400000&&d<3*86400000; });
  const thisWeek= all.filter(i => { const d=new Date(i.due)-now; return !i.missing&&d>=3*86400000&&new Date(i.due)<=week; });
  const missing = all.filter(i => i.missing);
  const manual  = all.filter(i => i.source==='manual' && !i.missing);

  const ANTHROPIC_KEY = ANTHROPIC_API_KEY;
  let aiSummary = '';
  if (ANTHROPIC_KEY && all.length) {
    try {
      const itemList = all.filter(i=>!i.missing).slice(0,8).map(i=>`- ${i.title} (${i.course}, due ${daysLeft(i.due)})`).join('\n');
      const prompt = `You are StudyPulse. Write a short weekly academic coaching message (3-4 sentences) for ${STUDENT_NAME}. Review their week ahead:\n${itemList}\n\nHighlight the most important priorities, suggest a strategy for the week, and end with encouragement. Warm, specific, and actionable. Plain text only.`;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST', headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:200, messages:[{role:'user',content:prompt}] })
      });
      const d = await r.json();
      const txt = d.content?.map(b=>b.text||'').join('');
      if (txt) aiSummary = `<div style="background:#1a2035;border-left:3px solid #a78bfa;border-radius:0 8px 8px 0;padding:16px 18px;margin-bottom:28px;font-size:14px;color:#c4b5fd;line-height:1.7;">${txt}</div>`;
    } catch {}
  }

  // Stats bar
  const statsBar = `
  <div style="display:flex;gap:0;margin-bottom:28px;border-radius:10px;overflow:hidden;border:1px solid #1e2640;">
    ${[
      ['Total','#4f7dff', all.filter(i=>!i.missing).length],
      ['Urgent','#f87171', urgent.length],
      ['This Week','#fbbf24', thisWeek.length+soon.length],
      ['Paper','#34d399', manual.length],
      ['Missing','#f87171', missing.length],
    ].map(([label,color,val])=>`
    <div style="flex:1;background:#181d2e;padding:14px 8px;text-align:center;border-right:1px solid #1e2640;">
      <div style="font-size:22px;font-weight:800;color:${color};">${val}</div>
      <div style="font-size:10px;color:#6b7a9d;letter-spacing:0.5px;text-transform:uppercase;margin-top:2px;">${label}</div>
    </div>`).join('')}
  </div>`;

  const weekday = new Date().toLocaleDateString('en-US',{weekday:'long'});
  const body = `
    <p style="font-size:15px;color:#9ca8c4;line-height:1.6;margin-bottom:20px;">
      📅 Happy ${weekday}, <strong style="color:#e8ecf4">${STUDENT_NAME}</strong>! Here's your full week ahead.
    </p>
    ${statsBar}
    ${aiSummary}
    ${sectionBlock('🔴','Due Today / Urgent','#f87171', urgent)}
    ${sectionBlock('🟡','Due in 1–3 Days','#fbbf24', soon)}
    ${sectionBlock('📅','Rest of This Week','#4f7dff', thisWeek)}
    ${sectionBlock('📝','Paper Assignments','#34d399', manual)}
    ${sectionBlock('⚠️','Missing Work — Action Required','#f87171', missing)}
    ${(!all.length) ? `<div style="text-align:center;padding:32px;color:#34d399;font-size:15px;">✅ Nothing due this week — great job staying ahead!</div>` : ''}
  `;

  return {
    subject: `📅 StudyPulse Weekly — ${all.filter(i=>!i.missing).length} items this week${missing.length ? `, ${missing.length} missing` : ''}`,
    html: emailBase('Weekly Summary', '', body)
  };
}

// ─── EMAIL SEND ENDPOINTS ─────────────────────────
app.post('/api/send-email', async (req, res) => {
  const { type } = req.body; // daily-morning | daily-evening | weekly
  try {
    let subject, html;
    if (type === 'weekly') ({ subject, html } = await buildWeeklyEmail());
    else if (type === 'daily-morning') ({ subject, html } = await buildDailyEmail('morning'));
    else if (type === 'daily-evening') ({ subject, html } = await buildDailyEmail('evening'));
    else return res.status(400).json({ error: 'type must be daily-morning, daily-evening, or weekly' });
    const result = await sendEmail(subject, html);
    res.json({ ...result, subject, type });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/test-email', async (req, res) => {
  const html = emailBase('Test Email', 'Test', `<p style="color:#9ca8c4;font-size:15px;">👋 Hi <strong style="color:#e8ecf4">${STUDENT_NAME||'there'}</strong>! Your StudyPulse email reminders are working perfectly. 🎉</p><p style="color:#6b7a9d;font-size:13px;margin-top:12px;">Daily emails will arrive at 7:30 AM and 8:00 PM.<br/>Weekly summaries arrive every Sunday at 6:00 PM.</p>`);
  const result = await sendEmail('📡 StudyPulse — Email Test', html);
  res.json(result);
});

// ─── EMAIL SCHEDULES ──────────────────────────────
// Daily 7:30 AM
cron.schedule('30 7 * * *', async () => {
  if (!EMAIL_ENABLED) return;
  console.log('📧 Sending morning email...');
  const { subject, html } = await buildDailyEmail('morning');
  await sendEmail(subject, html);
}, { timezone: 'America/New_York' });

// Daily 8:00 PM
cron.schedule('0 20 * * *', async () => {
  if (!EMAIL_ENABLED) return;
  console.log('📧 Sending evening email...');
  const { subject, html } = await buildDailyEmail('evening');
  await sendEmail(subject, html);
}, { timezone: 'America/New_York' });

// Weekly Sunday 6:00 PM
cron.schedule('0 18 * * 0', async () => {
  if (!EMAIL_ENABLED) return;
  console.log('📧 Sending weekly summary email...');
  const { subject, html } = await buildWeeklyEmail();
  await sendEmail(subject, html);
}, { timezone: 'America/New_York' });

console.log('📧 Email schedule: 7:30 AM daily · 8:00 PM daily · Sunday 6:00 PM weekly');

// ─── PUSH NOTIFICATIONS (ntfy.sh) ────────────────
// ── Send via Mac Messages app (free, uses your Apple ID) ──
function sendViaMacMessages(phone, message) {
  return new Promise((resolve, reject) => {
    // Escape single quotes in message for AppleScript
    const safe = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set targetBuddy to buddy "${phone}" of targetService
  send "${safe}" to targetBuddy
end tell`;
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

async function sendSMS(message) {
  if (!PHONE_NUMBER) {
    console.log('📵 No phone number configured — skipping SMS.');
    return { success: false, reason: 'No phone number configured' };
  }

  // ── Method 1: ntfy.sh push notification (free, instant) ──
  if (NTFY_TOPIC) {
    try {
      const r = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
        method: 'POST',
        headers: { 'Title': 'StudyPulse', 'Priority': 'default', 'Content-Type': 'text/plain' },
        body: message
      });
      if (!r.ok) throw new Error(`ntfy error ${r.status}`);
      console.log(`✅ Notification sent via ntfy to topic: ${NTFY_TOPIC}`);
      return { success: true, method: 'ntfy', gateway: NTFY_TOPIC };
    } catch (e) {
      console.error('❌ ntfy failed:', e.message);
    }
  }

  // ── Method 2: Mac Messages app ──
  try {
    await sendViaMacMessages(PHONE_NUMBER, message);
    console.log(`✅ SMS sent via Mac Messages to ${PHONE_NUMBER}`);
    return { success: true, method: 'mac-messages', gateway: PHONE_NUMBER };
  } catch (e) {
    console.error('❌ Mac Messages failed:', e.message);
  }

  // ── Method 3: Brevo SMTP → carrier email gateway ──
  const gateway = `${PHONE_NUMBER}@${CARRIER_GATEWAY}`;
  if (BREVO_USER && BREVO_SMTP_KEY) {
    try {
      const transport = nodemailer.createTransport({
        host: 'smtp-relay.brevo.com',
        port: 587,
        secure: false,
        auth: { user: BREVO_USER, pass: BREVO_SMTP_KEY }
      });
      await transport.sendMail({
        from: `"StudyPulse" <${BREVO_USER}>`,
        to: gateway,
        subject: '',
        text: message
      });
      console.log(`✅ SMS sent via Brevo to ${gateway}`);
      return { success: true, method: 'brevo', gateway };
    } catch (e) {
      console.error('❌ Brevo SMS failed:', e.message);
    }
  }

  // ── Method 3: Gmail App Password → carrier gateway ──
  if (GMAIL_USER && GMAIL_APP_PASS && GMAIL_APP_PASS !== 'x') {
    try {
      const transport = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS.replace(/\s/g, '') }
      });
      await transport.sendMail({
        from: GMAIL_USER,
        to: gateway,
        subject: '',
        text: message
      });
      console.log(`✅ SMS sent via Gmail to ${gateway}`);
      return { success: true, method: 'gmail', gateway };
    } catch (e) {
      console.error('❌ Gmail SMS failed:', e.message);
      return { success: false, reason: e.message };
    }
  }

  return { success: false, reason: 'All SMS methods failed. Make sure Messages app is open and signed in.' };
}

// ─── DIGEST BUILDER ───────────────────────────────
function buildAllItems() {
  const manual = loadManual().map(i => ({ ...i, source: 'manual' }));
  const canvas = cachedCanvasItems.map(i => ({ ...i, source: 'canvas' }));
  return [...canvas, ...manual].sort((a, b) => new Date(a.due) - new Date(b.due));
}

function fmtDueShort(iso) {
  const due = new Date(iso), now = new Date(), diff = due - now;
  if (diff < 0) return 'PAST DUE';
  const h = Math.floor(diff / 3600000);
  if (h < 24) return `${h}h left`;
  const d = Math.floor(diff / 86400000);
  return `${d}d — ${due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

async function buildDigestMessage(type) {
  const all   = buildAllItems();
  const now   = new Date();
  const today = new Date(now); today.setHours(23, 59, 59, 0);
  const week  = new Date(now.getTime() + 7 * 86400000);

  const dueToday  = all.filter(i => new Date(i.due) <= today && new Date(i.due) > now);
  const dueWeek   = all.filter(i => new Date(i.due) > today && new Date(i.due) <= week);
  const missing   = all.filter(i => i.missing);
  const urgent    = all.filter(i => { const d = new Date(i.due) - now; return d > 0 && d < 86400000; });

  let lines = [];

  if (type === 'morning') {
    lines.push(`☀️ Good morning ${STUDENT_NAME}! Here's your school day ahead:`);
    lines.push('');
    if (dueToday.length) {
      lines.push(`📌 DUE TODAY (${dueToday.length}):`);
      dueToday.forEach(i => lines.push(`  • ${i.title} [${i.course}] — ${fmtDueShort(i.due)}`));
      lines.push('');
    }
    if (dueWeek.length) {
      lines.push(`📅 THIS WEEK (${dueWeek.length}):`);
      dueWeek.slice(0, 4).forEach(i => lines.push(`  • ${i.title} [${i.course}] — ${fmtDueShort(i.due)}`));
      if (dueWeek.length > 4) lines.push(`  + ${dueWeek.length - 4} more`);
      lines.push('');
    }
    if (missing.length) lines.push(`⚠️ MISSING WORK: ${missing.length} item${missing.length > 1 ? 's' : ''} — check the app!`);
    if (!dueToday.length && !dueWeek.length) lines.push('✅ Nothing due this week. Great job staying ahead!');
  }

  else if (type === 'midday') {
    lines.push(`🕛 Midday check-in, ${STUDENT_NAME}!`);
    lines.push('');
    if (urgent.length) {
      lines.push(`🔴 URGENT — due in under 24h:`);
      urgent.forEach(i => lines.push(`  • ${i.title} [${i.course}] — ${fmtDueShort(i.due)}`));
      lines.push('');
    }
    if (dueWeek.length) {
      lines.push(`Coming up this week:`);
      dueWeek.slice(0, 3).forEach(i => lines.push(`  • ${i.title} — ${fmtDueShort(i.due)}`));
    }
    if (!urgent.length && !dueWeek.length) lines.push('✅ You\'re all clear for now. Keep it up!');
  }

  else if (type === 'evening') {
    const tomorrow     = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(23, 59, 59, 0);
    const dueTomorrow  = all.filter(i => new Date(i.due) > today && new Date(i.due) <= tomorrow);
    lines.push(`🌙 Evening wrap-up, ${STUDENT_NAME}!`);
    lines.push('');
    if (dueTomorrow.length) {
      lines.push(`📌 DUE TOMORROW (${dueTomorrow.length}):`);
      dueTomorrow.forEach(i => lines.push(`  • ${i.title} [${i.course}]`));
      lines.push('');
    }
    if (missing.length) {
      lines.push(`⚠️ MISSING WORK (${missing.length}):`);
      missing.forEach(i => lines.push(`  • ${i.title} [${i.course}]`));
      lines.push('');
    }
    const upcoming = dueWeek.filter(i => new Date(i.due) > tomorrow);
    if (upcoming.length) {
      lines.push(`📅 REST OF WEEK: ${upcoming.length} item${upcoming.length > 1 ? 's' : ''}`);
      upcoming.slice(0, 3).forEach(i => lines.push(`  • ${i.title} — ${fmtDueShort(i.due)}`));
    }
    if (!dueTomorrow.length && !missing.length) lines.push('✅ Great work today! Nothing urgent tomorrow.');
    lines.push('');
    lines.push('StudyPulse 📡');
  }

  // Optionally enhance with AI if key available
  const ANTHROPIC_KEY = ANTHROPIC_API_KEY;
  if (ANTHROPIC_KEY && all.length > 0) {
    try {
      const baseMsg = lines.join('\n');
      const prompt = `You are StudyPulse, a friendly academic reminder assistant sending an SMS to a student named ${STUDENT_NAME}.

Here is a structured digest message to enhance:
${baseMsg}

Make it feel warm, personal, and motivating — like a supportive coach texting them. 
Keep ALL the assignment details exactly as listed. Just improve the tone and add one short motivational line.
Keep total length under 300 words. Plain text only, no markdown.`;

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
      });
      const data = await aiRes.json();
      const aiText = data.content?.map(b => b.text || '').join('');
      if (aiText) return aiText;
    } catch (e) { /* fall through to base message */ }
  }

  return lines.join('\n');
}

// ─── SEND DIGEST ENDPOINT (manual trigger from UI) ─
app.post('/api/send-digest', async (req, res) => {
  const { type } = req.body; // morning | midday | evening
  if (!['morning', 'midday', 'evening'].includes(type))
    return res.status(400).json({ error: 'type must be morning, midday, or evening' });
  try {
    const message = await buildDigestMessage(type);
    const result  = await sendSMS(message);
    res.json({ ...result, message, type });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── TEST SMS ─────────────────────────────────────
app.post('/api/test-sms', async (req, res) => {
  const msg = `📡 StudyPulse test message! Hi ${STUDENT_NAME || 'there'} — SMS reminders are working. 🎉`;
  const result = await sendSMS(msg);
  res.json({ ...result, message: msg });
});

// ─── SCHEDULED DIGESTS ────────────────────────────
// 7:30 AM morning briefing
cron.schedule('30 7 * * *', async () => {
  console.log('⏰ Sending morning digest...');
  const msg = await buildDigestMessage('morning');
  await sendSMS(msg);
}, { timezone: 'America/New_York' });

// 12:00 PM midday check-in
cron.schedule('0 12 * * *', async () => {
  console.log('⏰ Sending midday digest...');
  const msg = await buildDigestMessage('midday');
  await sendSMS(msg);
}, { timezone: 'America/New_York' });

// 8:00 PM evening wind-down
cron.schedule('0 20 * * *', async () => {
  console.log('⏰ Sending evening digest...');
  const msg = await buildDigestMessage('evening');
  await sendSMS(msg);
}, { timezone: 'America/New_York' });

console.log('📅 Scheduled: 7:30 AM · 12:00 PM · 8:00 PM (ET) daily SMS digests');

// ─── AUTO SYNC CANVAS ─────────────────────────────
async function runCanvasSync() {
  if (!CANVAS_DOMAIN || !CANVAS_TOKEN) return;
  console.log('🔄 Auto-syncing Canvas...');
  try {
    const courses = await canvasFetch('/courses?enrollment_state=active&per_page=50');
    const now = new Date();
    const cutoff = new Date(now.getTime() - 7 * 86400000);
    const items = [];
    for (const course of courses.slice(0, 15)) {
      try {
        const assignments = await canvasFetch(`/courses/${course.id}/assignments?per_page=50&order_by=due_at`);
        for (const a of assignments) {
          if (!a.due_at || new Date(a.due_at) < cutoff) continue;
          items.push({ id:`a-${a.id}`, title:a.name, course:course.name, courseId:course.id,
            type: a.is_quiz_assignment?'quiz':'assignment', due:a.due_at,
            points:a.points_possible, htmlUrl:a.html_url });
        }
      } catch {}
      try {
        const quizzes = await canvasFetch(`/courses/${course.id}/quizzes?per_page=50`);
        for (const q of quizzes) {
          if (!q.due_at || new Date(q.due_at) < cutoff) continue;
          items.push({ id:`q-${q.id}`, title:q.title, course:course.name, courseId:course.id,
            type:'quiz', due:q.due_at, points:q.points_possible, htmlUrl:q.html_url });
        }
      } catch {}
    }
    items.sort((a,b) => new Date(a.due)-new Date(b.due));
    cachedCanvasItems = items;
    console.log(`✅ Auto-sync complete — ${items.length} items from ${courses.length} courses`);
  } catch(e) {
    console.log(`⚠️ Auto-sync failed: ${e.message}`);
  }
}

// Re-sync Canvas every day at 6 AM (before morning digest)
cron.schedule('0 6 * * *', () => runCanvasSync(), { timezone: 'America/New_York' });

// Auto-sync on startup if credentials are saved
setTimeout(runCanvasSync, 2000);

// ─── START SERVER ─────────────────────────────────
const PORT = process.env.PORT || 3000;

function startServer(port) {
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`\n✅ StudyPulse running — open this in your browser:`);
    console.log(`   👉  http://localhost:${port}`);
    console.log(`   👉  http://127.0.0.1:${port}`);
    console.log(`📡 Canvas domain: ${CANVAS_DOMAIN || '(not set — configure in the app)'}`);
    console.log(`\nPress Ctrl+C to stop.\n`);
    // Auto-open browser (Mac only — skip on cloud servers)
    if (process.platform === 'darwin') {
      exec(`open http://localhost:${port}`);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`⚠️  Port ${port} is busy, trying ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err.message);
    }
  });
}

startServer(PORT);
