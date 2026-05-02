# 📡 StudyPulse — Canvas Smart Reminder App

A local web app that syncs with Canvas LMS and generates AI-powered personalized reminders for students and parents.

---

## 🚀 Setup (Mac — 3 steps)

### Step 1 — Install Node.js (if you haven't already)
Go to https://nodejs.org and download the **LTS** version. Install it like any Mac app.

To verify it worked, open **Terminal** and type:
```
node --version
```
You should see something like `v20.x.x`

---

### Step 2 — Install the app dependencies
In **Terminal**, navigate to this folder and run:
```
cd path/to/studypulse
npm install
```
This installs Express and other required packages. Takes about 30 seconds.

---

### Step 3 — Start the app
```
node server.js
```
You'll see:
```
✅ StudyPulse running at http://localhost:3000
```

Open **Chrome** and go to: **http://localhost:3000**

---

## 🔑 Connecting Canvas

In the app:
1. Enter your Canvas domain — e.g. `somsd.instructure.com`
2. Paste your Canvas API token
3. Click **Sync Canvas**

Your token is sent only to the local server running on your computer — it never leaves your machine.

### Getting a Canvas API Token
1. Log into Canvas
2. Go to **Account → Settings**
3. Scroll to **Approved Integrations**
4. Click **+ New Access Token**
5. Copy the token and paste it into the app

---

## ✨ AI Reminders (Optional)

To enable AI-powered personalized reminders:
1. Copy `.env.example` to `.env`
2. Add your Anthropic API key: https://console.anthropic.com
3. Restart the server

Without an API key, the app still works — it just uses template-based reminders.

---

## 📁 Project Structure
```
studypulse/
├── server.js          ← Node.js backend (Canvas API proxy + AI)
├── public/
│   └── index.html     ← Frontend web app
├── package.json
├── .env.example       ← Copy to .env and fill in your values
└── README.md
```

---

## 🛑 Stopping the App
Press `Ctrl+C` in Terminal.
