# Blurt

Say it. It sorts itself.

Tap the orb, say whatever's on your mind ("dentist Thursday at 4, buy eggs and milk, finish the report"), and Blurt splits it into Calendar, Reminders, To-dos, Shopping and Notes.

## Run it

Needs Node.js 22.9 or newer.

```bash
npm install
cp .env.example .env   # then paste an API key into .env
npm start
```

Open http://localhost:5181 in Chrome. Without a key, Blurt still works using its built-in sorting rules.

For free testing, leave `ANTHROPIC_API_KEY` empty and set `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey) instead. Google's free tier has rate limits and may use prompts to improve Google's products, so use it to try Blurt out, not for other people's data. When both keys are set, Claude is used.

## What it does

- **Talk or type.** Speech-to-text uses the browser's built-in speech recognition.
- **Sorts into five cards.** Claude does the sorting when a key is set. Without one, built-in rules handle phrasings like "next Friday at 10", "tomorrow morning", "in 3 days" and "pick up the kids at 5".
- **Review before saving.** You see what was understood first. Tap the colored label to move an item to another list, drag it onto a card, edit the text or tap the time to change it.
- **Edit anything.** Tap an item in any list to change its text, amount, list or time, or to delete it.
- **Reminders go off.** You get a notification with Done and Snooze buttons, and events ping you 10 minutes before they start. This only works while the app is open or recently backgrounded (see Limits below).
- **Calendar export.** Each event has an "Add to Google Calendar" link and a .ics download, and Export on the Calendar or Reminders card saves everything coming up as one .ics file with alerts.
- **Shopping smarts.** It picks up amounts ("2 dozen eggs", "500g beef"), merges repeats ("milk" said twice), groups items by store aisle, and Share sends the list as text.
- **Today's 3.** You pick three things to do today, with suggestions from due reminders, today's events and the to-dos that have waited longest. To-dos older than 3 days show how long they've waited.
- **Installable app.** Chrome's "Install app" adds it to the home screen. Long-press the icon for "Blurt now" and "Today's 3". Blurt also shows up in Android's share sheet, so you can share text into it.

## How it fits together

- `blurt/index.html`: the whole app (orb, review, card stack, lists, editor).
- `blurt/sw.js`: the service worker. It lets the app open offline and handles the buttons on notifications.
- `blurt/manifest.webmanifest`: the install details, home-screen shortcuts and share target.
- `server.js`: serves the app and exposes `POST /api/sort`, which asks the AI (Claude, or Gemini for free testing) to split the transcript into cards and resolve dates and times.

The API key stays on the server and is never sent to the browser.

## Limits (for now)

- Data lives in the browser on one device. Accounts, sync and a live shared shopping list need a hosted backend.
- A web app can't schedule a notification for when it's closed. For reminders that must fire no matter what, export them to your phone's calendar. Reliable background alerts need push from a server, or a native app.
- Android home-screen widgets aren't available to web apps. The long-press shortcuts are the closest thing.
- The mic and install only work on `localhost` or over HTTPS.
