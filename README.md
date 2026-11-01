# Blurt

Say it. It sorts itself.

Tap the orb, say whatever's on your mind ("dentist Thursday at 4, buy eggs and milk, finish the report"), and Blurt splits it into Calendar, Reminders, To-dos, Shopping and Notes.

## Run it

Needs Node.js 22.9 or newer.

```bash
npm install
cp .env.example .env   # then paste your Anthropic API key into .env
npm start
```

Open http://localhost:5181 in Chrome. Without a key, Blurt still works using its built-in sorting rules.

## How it fits together

- `blurt/index.html`: the whole app (orb, transcript, card stack, lists). Speech-to-text uses the browser's built-in speech recognition.
- `server.js`: serves the app and exposes `POST /api/sort`, which asks Claude to split the transcript into cards and resolve dates and times.

The API key stays on the server and is never sent to the browser.
